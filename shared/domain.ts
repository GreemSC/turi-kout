// Regles metier (section 5 de la specification).
// Fonctions pures, sans I/O : le client les rejoue hors ligne a l'identique.

import type {
  Bodyweight, EquipmentItem, Exercise, ExerciseMuscle, Muscle, PersonalRecord,
  RecordKind, RoutineDay, RoutineExercise, Session, SetEntry,
} from './types.js';

/**
 * Series comptant comme du travail. Un echauffement n'entre ni dans le volume,
 * ni dans la reference de progression, ni dans les records : le compter
 * fausserait tout ce qui est construit dessus.
 *
 * Le test porte sur `!== 'warmup'` et non sur une liste blanche : une serie
 * venue d'une file d'attente v1, sans champ `kind`, reste ainsi une serie de
 * travail.
 */
export const workingSets = <T extends { kind?: SetEntry['kind'] }>(sets: T[]): T[] =>
  sets.filter((s) => s.kind !== 'warmup');

// --- 5.1 Rotation continue -------------------------------------------------

/**
 * Prochaine journee de la rotation : celle qui suit, par `position`, la journee
 * de la derniere seance TERMINEE. Boucle a la fin. Les seances abandonnees
 * (sans ended_at) et les choix manuels ne deplacent pas le curseur.
 */
export function nextRoutineDay(days: RoutineDay[], sessions: Session[]): RoutineDay | null {
  if (days.length === 0) return null;
  const ordered = [...days].sort((a, b) => a.position - b.position);

  const finished = sessions
    .filter((s) => s.ended_at)
    .sort((a, b) => (a.ended_at! < b.ended_at! ? 1 : a.ended_at! > b.ended_at! ? -1 : 0));

  const last = finished[0];
  if (!last) return ordered[0];

  const idx = ordered.findIndex((d) => d.id === last.routine_day_id);
  if (idx === -1) return ordered[0];
  return ordered[(idx + 1) % ordered.length];
}

// --- 5.2 Surcharge progressive --------------------------------------------

export interface PreviousPerformance {
  sessionId: string;
  /** Date ISO de la seance precedente sur cet exercice. */
  date: string;
  /** Series de cette seance, triees par set_index. */
  sets: SetEntry[];
}

/**
 * Seances passees sur un exercice, de la plus recente a la plus ancienne.
 * Les echauffements sont ecartes : ils ne sont ni une reference de progression
 * ni un signe de stagnation.
 */
export function performanceHistory(
  sets: SetEntry[],
  sessions: Session[],
  exerciseId: number,
  excludeSessionId?: string,
  limit = 10,
): PreviousPerformance[] {
  const startedAt = new Map(sessions.map((s) => [s.id, s.started_at]));
  const bySession = new Map<string, SetEntry[]>();

  for (const set of sets) {
    if (set.exercise_id !== exerciseId) continue;
    if (set.kind === 'warmup') continue;
    if (excludeSessionId && set.session_id === excludeSessionId) continue;
    const bucket = bySession.get(set.session_id);
    if (bucket) bucket.push(set);
    else bySession.set(set.session_id, [set]);
  }

  return [...bySession.entries()]
    .map(([sessionId, entries]) => ({
      sessionId,
      // Repli sur done_at si la seance n'est pas dans la fenetre chargee.
      date: startedAt.get(sessionId)
        ?? entries.reduce((min, e) => (e.done_at < min ? e.done_at : min), entries[0].done_at),
      sets: entries.sort((a, b) => a.set_index - b.set_index),
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/**
 * Derniere seance (autre que `excludeSessionId`) au cours de laquelle
 * l'exercice a ete travaille.
 */
export function previousPerformance(
  sets: SetEntry[],
  sessions: Session[],
  exerciseId: number,
  excludeSessionId?: string,
): PreviousPerformance | null {
  return performanceHistory(sets, sessions, exerciseId, excludeSessionId, 1)[0] ?? null;
}

export type SuggestReason =
  | 'first'            // jamais fait : rien a proposer
  | 'hold'             // fourchette non bouclee, on repropose la meme charge
  | 'increment'        // fourchette bouclee : +1 increment
  | 'double-increment' // bouclee tres facilement (RPE <= 7) : +2 increments
  | 'consolidate'      // bouclee mais au bord de l'echec (RPE >= 9) : on reste
  | 'deload';          // stagnation installee : allegement propose

export interface Suggestion {
  weight_kg: number;
  reps: number;
  /** true quand la charge a ete incrementee par rapport a la seance precedente. */
  incremented: boolean;
  previous: PreviousPerformance | null;
  reason: SuggestReason;
  /** Disques a mettre de chaque cote, null hors barre chargee. */
  perSide: number[] | null;
}

export interface SuggestOptions {
  /** Sans exercice ni inventaire, aucun arrondi n'est applique. */
  exercise?: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'>;
  inventory?: EquipmentItem[];
  /** Seances precedentes sur cet exercice, de la plus recente a la plus ancienne. */
  history?: PreviousPerformance[];
  /** Allegement propose apres stagnation, en pourcentage. Defaut 10. */
  deloadPercent?: number;
}

/**
 * Charge suggeree pour le prochain passage sur un exercice.
 *
 * Socle inchange depuis la v1 : si toutes les series prevues ont ete realisees
 * a la MEME charge en atteignant `rep_max`, on propose `charge + increment_kg` ;
 * sinon on repropose la meme charge.
 *
 * Le RPE, quand il est saisi sur TOUTES les series, module ce socle : tres
 * facile (<= 7) vaut un double increment, au bord de l'echec (>= 9) vaut une
 * consolidation. Sans RPE, le resultat est exactement celui de la v1.
 *
 * Jamais imposee : la valeur est pre-remplie et reste modifiable.
 */
export function suggestLoad(
  previous: PreviousPerformance | null,
  routine: Pick<RoutineExercise, 'target_sets' | 'rep_min' | 'rep_max'>,
  incrementKg: number,
  options: SuggestOptions = {},
): Suggestion {
  const snap = (weight: number): { weight_kg: number; perSide: number[] | null } => {
    if (!options.exercise) return { weight_kg: round(weight), perSide: null };
    const fit = loadable(weight, options.exercise, options.inventory ?? []);
    return { weight_kg: fit.weightKg, perSide: fit.perSide };
  };

  const sets = previous ? workingSets(previous.sets) : [];
  if (!previous || sets.length === 0) {
    return { weight_kg: 0, reps: routine.rep_max, incremented: false, previous, reason: 'first', perSide: null };
  }

  const working = sets[0].weight_kg;
  const allSetsDone = sets.length >= routine.target_sets;
  const sameLoad = sets.every((s) => s.weight_kg === working);
  const allTopped = sets.every((s) => s.reps >= routine.rep_max);

  // Le RPE ne compte que s'il a ete saisi sur toutes les series : une moyenne
  // partielle dirait n'importe quoi.
  const rpes = sets.map((s) => s.rpe).filter((r): r is number => r !== null && r !== undefined);
  const avgRpe = rpes.length === sets.length && rpes.length > 0
    ? rpes.reduce((a, b) => a + b, 0) / rpes.length
    : null;

  if (allSetsDone && sameLoad && allTopped) {
    const steps = avgRpe === null ? 1 : avgRpe <= 7 ? 2 : avgRpe >= 9 ? 0 : 1;

    if (steps === 0) {
      return { ...snap(working), reps: routine.rep_max, incremented: false, previous, reason: 'consolidate' };
    }
    const next = snap(working + steps * incrementKg);
    return {
      ...next,
      reps: routine.rep_min,
      // Un arrondi au chargeable peut ramener a la charge de depart.
      incremented: next.weight_kg > working,
      previous,
      reason: steps === 2 ? 'double-increment' : 'increment',
    };
  }

  // Fourchette non bouclee : on repropose la meme charge, sauf si la stagnation
  // dure — auquel cas un allegement est propose, jamais impose.
  const streak = stallStreak(options.history ?? [], routine);
  if (streak >= 2) {
    const lighter = working * (1 - (options.deloadPercent ?? 10) / 100);
    return { ...snap(lighter), reps: routine.rep_max, incremented: false, previous, reason: 'deload' };
  }

  return { ...snap(working), reps: sets[0].reps, incremented: false, previous, reason: 'hold' };
}

/**
 * Nombre de seances consecutives bloquees a la meme charge sans boucler la
 * fourchette. L'historique est attendu de la plus recente a la plus ancienne.
 */
export function stallStreak(
  history: PreviousPerformance[],
  routine: Pick<RoutineExercise, 'target_sets' | 'rep_max'>,
): number {
  const first = workingSets(history[0]?.sets ?? []);
  if (first.length === 0) return 0;
  const weight = first[0].weight_kg;

  let streak = 0;
  for (const session of history) {
    const sets = workingSets(session.sets);
    if (sets.length === 0 || sets[0].weight_kg !== weight) break;

    const completed = sets.length >= routine.target_sets && sets.every((s) => s.reps >= routine.rep_max);
    if (completed) break;
    streak++;
  }
  return streak;
}

/** Arrondi au quart de kilo : evite les 62.50000000000001 des flottants. */
export function round(kg: number): number {
  return Math.round(kg * 4) / 4;
}

// --- 5.3 Poids corporel ----------------------------------------------------

export interface BodyweightPoint {
  date: string;
  /** Mesure brute du jour, null si aucune saisie ce jour-la. */
  raw: number | null;
  /** Moyenne glissante sur les 7 jours calendaires se terminant a `date`. */
  avg: number | null;
  /** Nombre de mesures reelles dans la fenetre de 7 jours. */
  samples: number;
}

const DAY_MS = 86_400_000;

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Serie journaliere continue sur `days` jours, avec moyenne glissante 7 jours.
 * La moyenne n'est produite que sur les jours ou une mesure existe : sinon la
 * courbe se prolongerait a plat apres la derniere pesee.
 */
export function bodyweightSeries(entries: Bodyweight[], days: number, today = new Date()): BodyweightPoint[] {
  const byDate = new Map(entries.map((e) => [e.measured_on, e.weight_kg]));
  const end = keyToUtc(toDateKey(today));
  const out: BodyweightPoint[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const ts = end - i * DAY_MS;
    const date = new Date(ts).toISOString().slice(0, 10);
    const raw = byDate.get(date) ?? null;

    let sum = 0;
    let samples = 0;
    for (let back = 0; back < 7; back++) {
      const w = byDate.get(new Date(ts - back * DAY_MS).toISOString().slice(0, 10));
      if (w !== undefined) {
        sum += w;
        samples++;
      }
    }
    out.push({ date, raw, avg: raw !== null && samples > 0 ? sum / samples : null, samples });
  }
  return out;
}

export interface WeeklyTrend {
  /** Variation en kg/semaine, calculee sur les moyennes glissantes. null si trop peu de donnees. */
  kgPerWeek: number | null;
  /** Enonce factuel, sans jugement. */
  label: string;
  status: 'below' | 'on-target' | 'above' | 'stalled' | 'unknown';
}

/**
 * Variation hebdomadaire comparee a la cible. Compare la derniere moyenne
 * glissante a celle d'environ 7 jours plus tot, et normalise par l'ecart reel
 * en jours (les pesees ne tombent pas toujours pile a 7 jours d'intervalle).
 */
export function weeklyTrend(series: BodyweightPoint[], targetKgPerWeek: number): WeeklyTrend {
  const points = series.filter((p) => p.avg !== null);
  if (points.length < 2) {
    return { kgPerWeek: null, label: 'Pas assez de mesures', status: 'unknown' };
  }

  const last = points[points.length - 1];
  const lastTs = keyToUtc(last.date);

  // Point de comparaison : celui dont l'ecart est le plus proche de 7 jours,
  // en n'acceptant qu'au dela de 4 jours d'ecart pour eviter le bruit.
  let ref: BodyweightPoint | null = null;
  let bestGap = Infinity;
  for (const p of points.slice(0, -1)) {
    const gapDays = (lastTs - keyToUtc(p.date)) / DAY_MS;
    if (gapDays < 4) continue;
    const distance = Math.abs(gapDays - 7);
    if (distance < bestGap) {
      bestGap = distance;
      ref = p;
    }
  }
  if (!ref) return { kgPerWeek: null, label: 'Pas assez de recul', status: 'unknown' };

  const gapDays = (lastTs - keyToUtc(ref.date)) / DAY_MS;
  const kgPerWeek = ((last.avg! - ref.avg!) / gapDays) * 7;
  const shown = Math.round(kgPerWeek * 10) / 10;

  // Stagnation : variation nulle alors qu'une prise est visee, sur >= 14 jours.
  const span = (lastTs - keyToUtc(points[0].date)) / DAY_MS;
  if (Math.abs(kgPerWeek) < 0.05 && targetKgPerWeek > 0.05 && span >= 14) {
    const weeks = Math.floor(span / 7);
    return { kgPerWeek, label: `Stable sur ${weeks} semaines`, status: 'stalled' };
  }

  const halfBand = Math.max(0.1, Math.abs(targetKgPerWeek) * 0.4);
  const delta = kgPerWeek - targetKgPerWeek;
  const value = `${shown >= 0 ? '+' : '−'}${Math.abs(shown).toFixed(1).replace('.', ',')} kg/semaine`;

  if (Math.abs(delta) <= halfBand) return { kgPerWeek, label: `${value} — dans la cible`, status: 'on-target' };
  if (delta > 0) return { kgPerWeek, label: `${value} — au-dessus de la cible`, status: 'above' };
  return { kgPerWeek, label: `${value} — en dessous de la cible`, status: 'below' };
}

// --- Volume de travail (ecran Progression) ---------------------------------

/**
 * Charge de travail d'une seance : somme(charge x reps x cotes), echauffements
 * exclus. Un exercice unilateral compte double : dix repetitions par bras font
 * bien vingt repetitions de travail.
 */
export function workVolume(sets: SetEntry[], resolve: LoadResolver = externalLoad): number {
  return workingSets(sets).reduce((sum, s) => {
    const { load, sides } = resolve(s);
    return sum + load * s.reps * sides;
  }, 0);
}

/** Serie de travail la plus lourde d'une seance, charge reellement soulevee. */
export function topSet(sets: SetEntry[], resolve: LoadResolver = externalLoad): number {
  return workingSets(sets).reduce((max, s) => Math.max(max, resolve(s).load), 0);
}

// --- Charge reellement soulevee --------------------------------------------
//
// La valeur consignee est celle qu'on ajoute a la barre. Elle ne suffit pas :
// aux tractions elle vaut zero, et sur un rowing halteres elle ne dit pas si
// 30 kg sont dans une main ou dans deux. Tant qu'on s'en tient a elle, les
// tractions ne produisent ni tonnage, ni 1RM estime, ni record.

export interface ResolvedLoad {
  /** Charge reellement soulevee, poids du corps compris. */
  load: number;
  /** Cotes travailles : 2 quand l'exercice est unilateral. */
  sides: number;
}

export type LoadResolver = (set: SetEntry) => ResolvedLoad;

/** Resolution par defaut : la charge consignee, telle quelle. */
export const externalLoad: LoadResolver = (set) => ({ load: set.weight_kg, sides: 1 });

type LoadProfile = Pick<Exercise, 'id' | 'bodyweight_factor' | 'unilateral'>;

/**
 * Construit une resolution qui tient compte du poids de corps et du travail
 * unilateral. Le poids retenu est la derniere pesee anterieure a la serie —
 * pas la derniere connue : une traction d'il y a six mois s'evalue au poids
 * qu'on faisait ce jour-la.
 *
 * Sans aucune pesee, on s'abstient plutot que d'inventer : l'exercice retombe
 * sur la charge consignee.
 */
export function makeLoadResolver(exercises: LoadProfile[], bodyweights: Bodyweight[]): LoadResolver {
  const profiles = new Map(exercises.map((e) => [e.id, e]));
  const measures = [...bodyweights].sort((a, b) => a.measured_on.localeCompare(b.measured_on));

  const weightOn = (iso: string): number | null => {
    if (measures.length === 0) return null;
    const day = iso.slice(0, 10);
    let found: number | null = null;
    for (const measure of measures) {
      if (measure.measured_on > day) break;
      found = measure.weight_kg;
    }
    // Serie anterieure a toute pesee : la plus ancienne reste la meilleure
    // approximation disponible.
    return found ?? measures[0].weight_kg;
  };

  return (set) => {
    const profile = profiles.get(set.exercise_id);
    const sides = profile?.unilateral === 1 ? 2 : 1;
    if (!profile?.bodyweight_factor) return { load: set.weight_kg, sides };

    const body = weightOn(set.done_at);
    if (body === null) return { load: set.weight_kg, sides };
    // Le lest peut etre negatif : assistance a la poulie.
    return { load: Math.max(0, body * profile.bodyweight_factor + set.weight_kg), sides };
  };
}

// --- Force : 1RM estime ----------------------------------------------------

/**
 * 1RM estime a partir d'une serie. C'est le bon indicateur de progression en
 * force : le tonnage monte des qu'on ajoute une serie et descend des qu'on
 * monte lourd sur moins de repetitions.
 *
 * Brzycki sous 6 repetitions, Epley a partir de 6 : c'est la ou chacune est la
 * plus juste. Au-dela de 12, l'erreur passe a ±15-20 % et on prefere ne rien
 * afficher qu'un chiffre faux.
 */
export function e1rm(weightKg: number, reps: number): number | null {
  if (weightKg <= 0 || reps < 1 || reps > 12) return null;
  if (reps === 1) return weightKg;

  const estimate = reps < 6
    ? (weightKg * 36) / (37 - reps)
    : weightKg * (1 + reps / 30);

  return Math.round(estimate * 10) / 10;
}

/** Meilleur 1RM estime d'un lot de series. Echauffements exclus. */
export function bestE1rm(sets: SetEntry[], resolve: LoadResolver = externalLoad): number | null {
  let best: number | null = null;
  for (const set of workingSets(sets)) {
    const value = e1rm(resolve(set).load, set.reps);
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

// --- Volume hebdomadaire par muscle ----------------------------------------

/** Lundi de la semaine d'une date ISO, au format YYYY-MM-DD. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const offset = (d.getDay() + 6) % 7; // 0 = lundi
  return toDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset));
}

export interface WeekVolume {
  /** Lundi de la semaine, YYYY-MM-DD. */
  week: string;
  /** Sets fractionnes par identifiant de muscle. */
  byMuscle: Record<string, number>;
  /** Nombre de series de travail dans la semaine, tous muscles confondus. */
  workingSets: number;
}

/**
 * Volume hebdomadaire en sets fractionnes : chaque serie de travail vaut 1,0
 * pour le muscle moteur de l'exercice et 0,5 pour chaque synergiste.
 *
 * C'est le comptage qui predit le mieux l'hypertrophie dans la litterature,
 * devant le comptage direct qui ignore les synergistes.
 */
export function weeklyVolume(
  sets: SetEntry[],
  mapping: ExerciseMuscle[],
  weeks: number,
  today = new Date(),
): WeekVolume[] {
  const byExercise = new Map<number, ExerciseMuscle[]>();
  for (const row of mapping) {
    const bucket = byExercise.get(row.exercise_id);
    if (bucket) bucket.push(row);
    else byExercise.set(row.exercise_id, [row]);
  }

  // Squelette de semaines continues : une semaine sans entrainement doit
  // apparaitre a zero, pas disparaitre du graphique.
  const currentMonday = new Date(weekStart(today.toISOString()));
  const out: WeekVolume[] = [];
  const index = new Map<string, WeekVolume>();

  for (let i = weeks - 1; i >= 0; i--) {
    const monday = new Date(currentMonday);
    monday.setDate(monday.getDate() - i * 7);
    const entry: WeekVolume = { week: toDateKey(monday), byMuscle: {}, workingSets: 0 };
    out.push(entry);
    index.set(entry.week, entry);
  }

  for (const set of workingSets(sets)) {
    const bucket = index.get(weekStart(set.done_at));
    if (!bucket) continue;

    bucket.workingSets++;
    for (const { muscle_id, share } of byExercise.get(set.exercise_id) ?? []) {
      bucket.byMuscle[muscle_id] = (bucket.byMuscle[muscle_id] ?? 0) + share;
    }
  }
  return out;
}

export type VolumeStatus = 'sous-mev' | 'productif' | 'optimal' | 'au-dessus-mrv';

export function volumeStatus(fractionalSets: number, landmark: Muscle): VolumeStatus {
  if (fractionalSets > landmark.mrv) return 'au-dessus-mrv';
  if (fractionalSets >= landmark.mav_low && fractionalSets <= landmark.mav_high) return 'optimal';
  if (fractionalSets < landmark.mev) return 'sous-mev';
  return 'productif';
}

/** Enonce factuel, sans jugement — meme registre que la tendance de poids. */
export function volumeLabel(fractionalSets: number, landmark: Muscle): string {
  const count = fractionalSets.toFixed(fractionalSets % 1 === 0 ? 0 : 1).replace('.', ',');
  const unit = fractionalSets > 1 ? 'sets' : 'set';
  const head = `${count} ${unit}`;

  switch (volumeStatus(fractionalSets, landmark)) {
    case 'sous-mev': return `${head} — sous le minimum de ${landmark.mev}`;
    case 'au-dessus-mrv': return `${head} — au-dessus du plafond de ${landmark.mrv}`;
    // Certains muscles n'ont pas de minimum : le travail indirect suffit a les
    // entretenir. Annoncer une « zone productive » y serait trompeur.
    case 'optimal': return landmark.mev === 0
      ? `${head} — aucun minimum requis, le travail indirect suffit`
      : `${head} — zone la plus productive`;
    default: return `${head} — au-dessus du minimum`;
  }
}

// --- Charges reellement chargeables ----------------------------------------

const DEFAULT_BAR_KG = 20;
/** On travaille en quarts de kilo entiers : les flottants ne se somment pas juste. */
const UNIT = 4;

export interface LoadableWeight {
  weightKg: number;
  /** Disques d'un cote de la barre, du plus lourd au plus leger. null sinon. */
  perSide: number[] | null;
}

/**
 * Ramene une charge souhaitee a une charge reellement montable, compte tenu du
 * materiel disponible. Sans cela l'application propose 82,5 kg a qui n'a pas de
 * disques de 1,25, ou +2,5 kg sur des halteres qui montent de 2 en 2.
 */
export function loadable(
  target: number,
  exercise: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'>,
  inventory: EquipmentItem[],
): LoadableWeight {
  if (target <= 0) return { weightKg: 0, perSide: null };

  switch (exercise.equipment) {
    case 'bodyweight':
      // Poids du corps : la charge saisie est un lest, libre.
      return { weightKg: round(target), perSide: null };

    case 'dumbbell': {
      const ladder = inventory
        .filter((i) => i.kind === 'dumbbell')
        .map((i) => i.weight_kg)
        .sort((a, b) => a - b);
      if (ladder.length === 0) return { weightKg: roundTo(target, exercise.increment_kg), perSide: null };
      return { weightKg: nearest(target, ladder), perSide: null };
    }

    case 'machine':
    case 'cable':
      return { weightKg: roundTo(target, exercise.increment_kg), perSide: null };

    default: {
      const bar = exercise.bar_kg ?? DEFAULT_BAR_KG;
      if (target <= bar) return { weightKg: bar, perSide: [] };

      const plates = inventory
        .filter((i) => i.kind === 'plate' && i.weight_kg > 0 && i.count > 0)
        .sort((a, b) => b.weight_kg - a.weight_kg);
      if (plates.length === 0) return { weightKg: roundTo(target, exercise.increment_kg), perSide: null };

      const wantedPerSide = Math.round(((target - bar) / 2) * UNIT);
      const best = bestCombination(plates, wantedPerSide);
      return { weightKg: round(bar + (best.units * 2) / UNIT), perSide: best.plates };
    }
  }
}

function roundTo(value: number, step: number): number {
  const increment = step > 0 ? step : 0.5;
  return round(Math.round(value / increment) * increment);
}

/** Le plus proche, et le plus leger en cas d'egalite : on ne force pas a monter. */
function nearest(value: number, sorted: number[]): number {
  let best = sorted[0];
  for (const candidate of sorted) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return best;
}

/**
 * A poids egal, on prefere le moins de disques ; a nombre egal, les plus lourds
 * d'abord. C'est ce qu'on fait devant la barre : deux disques valent mieux que
 * quatre, et un 20 vaut mieux que deux 10.
 */
function preferable(candidate: number[], incumbent: number[]): boolean {
  if (candidate.length !== incumbent.length) return candidate.length < incumbent.length;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i] > incumbent[i];
  }
  return false;
}

/**
 * Meilleure combinaison de disques pour approcher `wantedUnits` d'un cote.
 *
 * Recherche exhaustive plutot que gloutonne : avec un jeu 20/15/10, l'approche
 * gloutonne rate 30 kg (elle prend le 20 puis bloque) la ou 15 + 15 tombe
 * juste. Les volumes en jeu sont minuscules, l'exactitude ne coute rien.
 */
function bestCombination(
  plates: EquipmentItem[],
  wantedUnits: number,
): { units: number; plates: number[] } {
  // Les disques arrivent tries du plus lourd au plus leger : les compositions
  // sont donc construites deja ordonnees, ce dont `preferable` depend.
  let reachable = new Map<number, number[]>([[0, []]]);

  for (const plate of plates) {
    const step = Math.round(plate.weight_kg * UNIT);
    const next = new Map(reachable);
    for (const [units, used] of reachable) {
      for (let count = 1; count <= plate.count; count++) {
        const total = units + count * step;
        if (total > wantedUnits) break;

        const composition = [...used, ...Array<number>(count).fill(plate.weight_kg)];
        const incumbent = next.get(total);
        if (!incumbent || preferable(composition, incumbent)) next.set(total, composition);
      }
    }
    reachable = next;
  }

  let best = 0;
  for (const units of reachable.keys()) if (units > best) best = units;
  return { units: best, plates: reachable.get(best)! };
}

// --- Echauffement ----------------------------------------------------------

export interface WarmupStep {
  /** Position dans la rampe, a partir de 1. */
  index: number;
  weightKg: number;
  reps: number;
  /**
   * Repos qui suit ce palier. Court entre deux echauffements ; celui du dernier
   * est le repos de l'exercice, puisque c'est une serie de travail qui suit.
   */
  restSeconds: number;
  /** Vrai pour la barre a vide : on ne charge rien. */
  bar: boolean;
}

/**
 * Nombre de paliers. Plus la serie est lourde, plus la montee doit etre
 * progressive : un squat a 140 kg ne se prepare pas comme un curl a 20.
 *
 * A la barre, l'echelle est le rapport a la barre a vide. Ailleurs il n'y a pas
 * de point de depart fixe — le mesurer en part de la charge donnerait un
 * rapport constant, et donc le meme nombre de paliers pour 12 kg que pour
 * 120 — on se rabat donc sur des seuils absolus.
 */
function rampLength(work: number, isBarbell: boolean, barKg: number): number {
  if (isBarbell) {
    const ratio = work / Math.max(1, barKg);
    if (ratio < 1.4) return 0;   // deja au niveau de la barre, rien a monter
    if (ratio < 2) return 2;
    if (ratio < 3.5) return 3;
    return 4;
  }

  // Sous cette charge, il n'y a rien a preparer : s'echauffer pour des
  // elevations laterales a 12 kg ne fait que rallonger la seance.
  if (work < 25) return 0;
  if (work < 50) return 2;
  if (work < 90) return 3;
  return 4;
}

// Les repetitions descendent a mesure que la charge monte, et le repos
// s'allonge : les premiers paliers ne fatiguent pas, le dernier prepare
// vraiment la serie de travail.
const RAMP_REPS = [10, 5, 3, 2];
const RAMP_REST = [30, 30, 45, 60];
/** Dernier palier, en part de la charge de travail. */
const RAMP_TOP = 0.85;

/**
 * Rampe d'echauffement menant a `workKg`.
 *
 * Depart a la barre a vide quand il y en a une — c'est le premier palier de
 * tous les protocoles serieux — sinon a 40 % de la charge. Les paliers montent
 * lineairement jusqu'a 85 %, chacun arrondi a une charge reellement montable.
 *
 * `workRestSeconds` est le repos de l'exercice : il remplace celui du dernier
 * palier, qui precede une vraie serie de travail et non un autre echauffement.
 */
export function warmupRamp(
  workKg: number,
  exercise: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'>,
  inventory: EquipmentItem[] = [],
  workRestSeconds?: number,
): WarmupStep[] {
  if (workKg <= 0) return [];

  const isBarbell = exercise.equipment === 'barbell';
  const bar = exercise.bar_kg ?? DEFAULT_BAR_KG;
  const start = isBarbell ? bar : workKg * 0.4;
  const count = rampLength(workKg, isBarbell, bar);
  if (count === 0) return [];

  const top = workKg * RAMP_TOP;
  const reps = RAMP_REPS.slice(RAMP_REPS.length - count);
  const rests = RAMP_REST.slice(RAMP_REST.length - count);

  const steps: WarmupStep[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < count; i++) {
    const target = count === 1 ? top : start + ((top - start) * i) / (count - 1);
    const { weightKg } = loadable(target, exercise, inventory);

    // Un palier qui retombe sur un precedent, ou qui atteint deja la charge de
    // travail, n'apprend rien au corps.
    if (weightKg >= workKg || seen.has(weightKg)) continue;
    seen.add(weightKg);

    steps.push({
      index: steps.length + 1,
      weightKg,
      reps: reps[i],
      restSeconds: rests[i],
      bar: isBarbell && weightKg <= (exercise.bar_kg ?? DEFAULT_BAR_KG),
    });
  }

  // Renumeroter apres les fusions eventuelles, et donner au dernier palier le
  // repos de l'exercice : c'est une serie de travail qui le suit.
  return steps.map((step, i) => ({
    ...step,
    index: i + 1,
    restSeconds: i === steps.length - 1 && workRestSeconds !== undefined
      ? workRestSeconds
      : step.restSeconds,
  }));
}

// --- Records ---------------------------------------------------------------

/** Meilleures valeurs connues, indexees `exerciseId:kind`. */
export type RecordSnapshot = Record<string, number>;

export const recordKey = (exerciseId: number, kind: RecordKind): string => `${exerciseId}:${kind}`;

export function toSnapshot(records: PersonalRecord[]): RecordSnapshot {
  const out: RecordSnapshot = {};
  for (const record of records) out[recordKey(record.exercise_id, record.kind)] = record.value;
  return out;
}

export interface DetectedRecord {
  kind: RecordKind;
  value: number;
  previous: number | null;
}

/**
 * Records battus par une serie qui vient d'etre validee. Compare aux meilleures
 * valeurs de toute l'histoire, transmises par le serveur au demarrage : le
 * client n'a que 90 jours en memoire et annoncerait sinon des records contre un
 * passe qu'il ne voit pas.
 */
export function detectRecords(
  set: SetEntry,
  sessionSetsForExercise: SetEntry[],
  best: RecordSnapshot,
  resolve: LoadResolver = externalLoad,
): DetectedRecord[] {
  const { load, sides } = resolve(set);
  if (set.kind === 'warmup' || set.reps < 1 || load <= 0) return [];

  const candidates: [RecordKind, number | null][] = [
    ['weight', load],
    ['e1rm', e1rm(load, set.reps)],
    ['set_volume', load * set.reps * sides],
    ['session_volume', workVolume(sessionSetsForExercise, resolve)],
  ];

  const out: DetectedRecord[] = [];
  for (const [kind, value] of candidates) {
    if (value === null || value <= 0) continue;
    const previous = best[recordKey(set.exercise_id, kind)] ?? null;
    // Egaler n'est pas battre : on n'annonce que le depassement franc.
    if (previous === null || value > previous + 1e-9) out.push({ kind, value, previous });
  }
  return out;
}
