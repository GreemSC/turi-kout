import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bestE1rm, bodyweightSeries, detectRecords, e1rm, loadable, makeLoadResolver,
  nextRoutineDay, performanceHistory, previousPerformance, stallStreak, suggestLoad,
  topSet, volumeLabel, volumeStatus, warmupRamp, weeklyTrend, weeklyVolume, workVolume,
} from '../../shared/domain.ts';
import type {
  Bodyweight, EquipmentItem, Exercise, ExerciseMuscle, Muscle, RoutineDay,
  Session, SetEntry, SetKind,
} from '../../shared/types.ts';

const days: RoutineDay[] = [
  { id: 1, name: 'Haut A', position: 1 },
  { id: 2, name: 'Bas A', position: 2 },
  { id: 3, name: 'Haut B', position: 3 },
  { id: 4, name: 'Bas B', position: 4 },
];

const session = (id: string, dayId: number, started: string, ended: string | null = started): Session =>
  ({ id, routine_day_id: dayId, started_at: started, ended_at: ended, note: null });

const set = (
  id: string, sessionId: string, index: number, weight: number, reps: number, at: string,
  kind: SetKind = 'work', rpe: number | null = null,
): SetEntry =>
  ({ id, session_id: sessionId, exercise_id: 1, set_index: index, weight_kg: weight, reps, done_at: at, kind, rpe });

// --- 5.1 Rotation ----------------------------------------------------------

test('sans historique, la rotation commence a la premiere journee', () => {
  assert.equal(nextRoutineDay(days, [])?.name, 'Haut A');
});

test('la rotation avance apres une seance terminee et boucle a la fin', () => {
  assert.equal(nextRoutineDay(days, [session('a', 1, '2026-01-01T10:00:00Z')])?.name, 'Bas A');
  assert.equal(nextRoutineDay(days, [session('a', 4, '2026-01-01T10:00:00Z')])?.name, 'Haut A');
});

test('une seance abandonnee ne deplace pas la rotation', () => {
  const history = [
    session('a', 1, '2026-01-01T10:00:00Z'),
    session('b', 3, '2026-01-03T10:00:00Z', null), // ouverte, jamais terminee
  ];
  assert.equal(nextRoutineDay(days, history)?.name, 'Bas A');
});

test('un choix manuel hors ordre repart de la journee suivante, sans casser la rotation', () => {
  const history = [
    session('a', 1, '2026-01-01T10:00:00Z'),
    session('b', 4, '2026-01-03T10:00:00Z'), // l'utilisateur a saute a Bas B
  ];
  assert.equal(nextRoutineDay(days, history)?.name, 'Haut A');
});

// --- 5.2 Surcharge progressive (critere d'acceptation 4) -------------------

const routine = { target_sets: 4, rep_min: 6, rep_max: 8 };

test('toutes les series au haut de la fourchette a la meme charge : +increment', () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [1, 2, 3, 4].map((i) => set(`x${i}`, 's1', i, 80, 8, '2026-01-01T10:0${i}:00Z'));

  const previous = previousPerformance(sets, sessions, 1);
  const suggestion = suggestLoad(previous, routine, 2.5);

  assert.equal(suggestion.weight_kg, 82.5);
  assert.equal(suggestion.incremented, true);
});

test('une seule serie sous rep_max : on repropose la meme charge', () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [
    set('x1', 's1', 1, 80, 8, '2026-01-01T10:01:00Z'),
    set('x2', 's1', 2, 80, 8, '2026-01-01T10:05:00Z'),
    set('x3', 's1', 3, 80, 8, '2026-01-01T10:09:00Z'),
    set('x4', 's1', 4, 80, 7, '2026-01-01T10:13:00Z'),
  ];

  const suggestion = suggestLoad(previousPerformance(sets, sessions, 1), routine, 2.5);
  assert.equal(suggestion.weight_kg, 80);
  assert.equal(suggestion.incremented, false);
});

test('une serie manquante bloque l increment meme si les reps sont au maximum', () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [1, 2, 3].map((i) => set(`x${i}`, 's1', i, 80, 8, '2026-01-01T10:00:00Z'));
  assert.equal(suggestLoad(previousPerformance(sets, sessions, 1), routine, 2.5).incremented, false);
});

test('une charge degressive bloque l increment et repropose la charge de travail', () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [
    set('x1', 's1', 1, 80, 8, '2026-01-01T10:01:00Z'),
    set('x2', 's1', 2, 80, 8, '2026-01-01T10:05:00Z'),
    set('x3', 's1', 3, 75, 8, '2026-01-01T10:09:00Z'),
    set('x4', 's1', 4, 75, 8, '2026-01-01T10:13:00Z'),
  ];
  const suggestion = suggestLoad(previousPerformance(sets, sessions, 1), routine, 2.5);
  assert.equal(suggestion.weight_kg, 80);
  assert.equal(suggestion.incremented, false);
});

test('la seance de reference est la plus recente, la seance en cours exclue', () => {
  const sessions = [
    session('s1', 1, '2026-01-01T10:00:00Z'),
    session('s2', 1, '2026-01-08T10:00:00Z'),
    session('s3', 1, '2026-01-15T10:00:00Z', null),
  ];
  const sets = [
    set('a', 's1', 1, 70, 8, '2026-01-01T10:01:00Z'),
    set('b', 's2', 1, 85, 6, '2026-01-08T10:01:00Z'),
    set('c', 's3', 1, 90, 6, '2026-01-15T10:01:00Z'),
  ];
  const previous = previousPerformance(sets, sessions, 1, 's3');
  assert.equal(previous?.sessionId, 's2');
  assert.equal(suggestLoad(previous, routine, 2.5).weight_kg, 85);
});

test('sans historique, aucune charge n est suggeree', () => {
  const suggestion = suggestLoad(null, routine, 2.5);
  assert.equal(suggestion.weight_kg, 0);
  assert.equal(suggestion.previous, null);
});

// --- 5.3 Poids corporel (critere d'acceptation 5) --------------------------

test('douze pesees sur trois semaines donnent une moyenne glissante et une tendance', () => {
  // 3 pesees par semaine, +0,3 kg/semaine environ.
  const entries: { measured_on: string; weight_kg: number }[] = [];
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 12; i++) {
    const dayOffset = Math.floor(i / 3) * 7 + (i % 3) * 2;
    const date = new Date(start + dayOffset * 86_400_000).toISOString().slice(0, 10);
    // Bruit journalier volontaire, de somme nulle sur la semaine : la moyenne
    // glissante doit le lisser et ne laisser que la tendance de fond.
    entries.push({ measured_on: date, weight_kg: 75 + dayOffset * (0.3 / 7) + [-0.3, 0, 0.3][i % 3] });
  }

  const today = new Date(Date.UTC(2026, 0, 26)); // derniere pesee du jeu de donnees
  const series = bodyweightSeries(entries, 40, today);
  const withAvg = series.filter((p) => p.avg !== null);

  assert.equal(withAvg.length, 12, 'une moyenne par jour pese');
  assert.ok(withAvg.every((p) => p.raw !== null), 'pas de moyenne sur un jour sans pesee');

  const trend = weeklyTrend(series, 0.25);
  assert.ok(trend.kgPerWeek !== null);
  assert.ok(Math.abs(trend.kgPerWeek! - 0.3) < 0.05, `tendance inattendue: ${trend.kgPerWeek}`);
  assert.equal(trend.status, 'on-target');
  assert.match(trend.label, /kg\/semaine — dans la cible/);
});

test('la moyenne glissante lisse le bruit journalier', () => {
  const entries = [
    { measured_on: '2026-02-01', weight_kg: 80 },
    { measured_on: '2026-02-02', weight_kg: 82 },
    { measured_on: '2026-02-03', weight_kg: 81 },
  ];
  const series = bodyweightSeries(entries, 5, new Date(Date.UTC(2026, 1, 3)));
  const last = series[series.length - 1];
  assert.equal(last.raw, 81);
  assert.equal(last.avg, 81);
  assert.equal(last.samples, 3);
});

test('une prise trop rapide est signalee comme au-dessus de la cible', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({
    measured_on: new Date(Date.UTC(2026, 2, 1) + i * 86_400_000).toISOString().slice(0, 10),
    weight_kg: 78 + i * (0.9 / 7),
  }));
  const trend = weeklyTrend(bodyweightSeries(entries, 20, new Date(Date.UTC(2026, 2, 15))), 0.25);
  assert.equal(trend.status, 'above');
  assert.match(trend.label, /au-dessus de la cible/);
});

test('un poids stable sur deux semaines est signale comme tel', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({
    measured_on: new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10),
    weight_kg: 78,
  }));
  const trend = weeklyTrend(bodyweightSeries(entries, 20, new Date(Date.UTC(2026, 3, 15))), 0.25);
  assert.equal(trend.status, 'stalled');
  assert.match(trend.label, /^Stable sur 2 semaines$/);
});

test('une seule pesee ne produit aucune tendance', () => {
  const series = bodyweightSeries([{ measured_on: '2026-05-01', weight_kg: 80 }], 10, new Date(Date.UTC(2026, 4, 5)));
  assert.equal(weeklyTrend(series, 0.25).kgPerWeek, null);
});

// ===========================================================================
// v2 — mesure de l'entrainement
// ===========================================================================

// --- Series d'echauffement -------------------------------------------------

test("un echauffement ne compte ni dans le volume ni dans la reference", () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [
    set('w1', 's1', 1, 20, 10, '2026-01-01T10:00:00Z', 'warmup'),
    set('w2', 's1', 2, 50, 5, '2026-01-01T10:03:00Z', 'warmup'),
    set('x1', 's1', 1, 80, 8, '2026-01-01T10:08:00Z'),
    set('x2', 's1', 2, 80, 8, '2026-01-01T10:12:00Z'),
  ];

  assert.equal(workVolume(sets), 2 * 80 * 8, 'les echauffements sortent du tonnage');

  const previous = previousPerformance(sets, sessions, 1);
  assert.equal(previous?.sets.length, 2, 'seules les series de travail font reference');
  assert.equal(previous?.sets[0].weight_kg, 80);
});

test("la charge de travail proposee ignore l echauffement en tete de seance", () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [
    set('w1', 's1', 1, 40, 8, '2026-01-01T10:00:00Z', 'warmup'),
    ...[1, 2, 3, 4].map((i) => set(`x${i}`, 's1', i, 80, 8, `2026-01-01T10:1${i}:00Z`)),
  ];
  const suggestion = suggestLoad(previousPerformance(sets, sessions, 1), routine, 2.5);
  assert.equal(suggestion.weight_kg, 82.5);
  assert.equal(suggestion.incremented, true);
});

// --- 1RM estime ------------------------------------------------------------

test('e1RM : Brzycki sous 6 repetitions, Epley au-dela', () => {
  // Brzycki : 100 x 36 / (37 - 3) = 105,9
  assert.equal(e1rm(100, 3), 105.9);
  // Epley : 100 x (1 + 8/30) = 126,7
  assert.equal(e1rm(100, 8), 126.7);
  // A 6 repetitions on bascule sur Epley : 100 x 1,2 = 120
  assert.equal(e1rm(100, 6), 120);
});

test('e1RM : une repetition vaut la charge, au-dela de 12 on ne devine pas', () => {
  assert.equal(e1rm(140, 1), 140);
  assert.equal(e1rm(60, 13), null, "l'erreur passe a ±15-20 %, mieux vaut ne rien dire");
  assert.equal(e1rm(0, 5), null);
  assert.equal(e1rm(100, 0), null);
});

test('e1RM : monter plus lourd sur moins de reps est bien vu comme un progres', () => {
  // Le tonnage dirait l'inverse : 4x8 a 80 = 2560 contre 3x5 a 100 = 1500.
  const before = [1, 2, 3, 4].map((i) => set(`a${i}`, 's1', i, 80, 8, '2026-01-01T10:00:00Z'));
  const after = [1, 2, 3].map((i) => set(`b${i}`, 's2', i, 100, 5, '2026-01-08T10:00:00Z'));

  assert.ok(workVolume(after) < workVolume(before), 'le tonnage baisse');
  assert.ok(bestE1rm(after)! > bestE1rm(before)!, 'le e1RM monte — c est lui qui a raison');
});

// --- Volume hebdomadaire par muscle ---------------------------------------

const mapping: ExerciseMuscle[] = [
  { exercise_id: 1, muscle_id: 'chest', share: 1 },
  { exercise_id: 1, muscle_id: 'triceps', share: 0.5 },
  { exercise_id: 1, muscle_id: 'front_delts', share: 0.5 },
  { exercise_id: 2, muscle_id: 'triceps', share: 1 },
];

const chest: Muscle = { id: 'chest', name: 'Pectoraux', mev: 8, mav_low: 12, mav_high: 20, mrv: 22, position: 1 };

test('le comptage fractionne donne 1,0 au moteur et 0,5 aux synergistes', () => {
  const sets = [1, 2, 3, 4].map((i) => set(`x${i}`, 's1', i, 80, 8, '2026-03-04T10:00:00Z'));
  const [week] = weeklyVolume(sets, mapping, 1, new Date('2026-03-06T12:00:00'));

  assert.equal(week.byMuscle.chest, 4, '4 series motrices');
  assert.equal(week.byMuscle.triceps, 2, '4 series synergistes = 2 sets fractionnes');
  assert.equal(week.byMuscle.front_delts, 2);
  assert.equal(week.workingSets, 4);
});

test('le volume additionne les contributions de plusieurs exercices', () => {
  const sets = [
    ...[1, 2].map((i) => set(`a${i}`, 's1', i, 80, 8, '2026-03-04T10:00:00Z')),
    { ...set('b1', 's1', 1, 30, 12, '2026-03-04T10:20:00Z'), exercise_id: 2 },
    { ...set('b2', 's1', 2, 30, 12, '2026-03-04T10:24:00Z'), exercise_id: 2 },
  ];
  const [week] = weeklyVolume(sets, mapping, 1, new Date('2026-03-06T12:00:00'));

  assert.equal(week.byMuscle.chest, 2);
  assert.equal(week.byMuscle.triceps, 3, '2 synergistes (1) + 2 moteurs (2)');
});

test('les echauffements ne gonflent pas le volume hebdomadaire', () => {
  const sets = [
    set('w1', 's1', 1, 20, 10, '2026-03-04T10:00:00Z', 'warmup'),
    set('x1', 's1', 1, 80, 8, '2026-03-04T10:08:00Z'),
  ];
  const [week] = weeklyVolume(sets, mapping, 1, new Date('2026-03-06T12:00:00'));
  assert.equal(week.byMuscle.chest, 1);
  assert.equal(week.workingSets, 1);
});

test('les semaines sont decoupees du lundi au dimanche, sans trou', () => {
  const sets = [
    set('a', 's1', 1, 80, 8, '2026-03-01T10:00:00'), // dimanche : semaine du 23/02
    set('b', 's2', 1, 80, 8, '2026-03-02T10:00:00'), // lundi : semaine du 02/03
  ];
  const weeks = weeklyVolume(sets, mapping, 3, new Date('2026-03-06T12:00:00'));

  assert.equal(weeks.length, 3, 'une semaine sans entrainement reste presente, a zero');
  assert.deepEqual(weeks.map((w) => w.week), ['2026-02-16', '2026-02-23', '2026-03-02']);
  assert.equal(weeks[0].workingSets, 0);
  assert.equal(weeks[1].byMuscle.chest, 1, 'le dimanche appartient a la semaine precedente');
  assert.equal(weeks[2].byMuscle.chest, 1);
});

test('le statut de volume se lit sur les reperes MEV / MAV / MRV', () => {
  assert.equal(volumeStatus(3, chest), 'sous-mev');
  assert.equal(volumeStatus(10, chest), 'productif');
  assert.equal(volumeStatus(14.5, chest), 'optimal');
  assert.equal(volumeStatus(21, chest), 'productif');
  assert.equal(volumeStatus(25, chest), 'au-dessus-mrv');
});

test("l enonce de volume est factuel, sans jugement", () => {
  assert.equal(volumeLabel(14.5, chest), '14,5 sets — zone la plus productive');
  assert.equal(volumeLabel(3, chest), '3 sets — sous le minimum de 8');
  assert.equal(volumeLabel(25, chest), '25 sets — au-dessus du plafond de 22');
  assert.equal(volumeLabel(1, chest), '1 set — sous le minimum de 8', 'accord au singulier');
});

test("un muscle sans minimum n annonce pas de zone productive", () => {
  // Les deltoides anterieurs sont assez sollicites indirectement : leur MEV
  // vaut zero, et parler de « zone productive » a 1 set serait trompeur.
  const frontDelts: Muscle =
    { id: 'front_delts', name: 'Épaules (antérieures)', mev: 0, mav_low: 0, mav_high: 6, mrv: 12, position: 5 };
  assert.match(volumeLabel(1, frontDelts), /aucun minimum requis/);
});

// --- Charges chargeables ---------------------------------------------------

const gym: EquipmentItem[] = [
  { kind: 'plate', weight_kg: 20, count: 4 },
  { kind: 'plate', weight_kg: 15, count: 2 },
  { kind: 'plate', weight_kg: 10, count: 2 },
  { kind: 'plate', weight_kg: 5, count: 2 },
  { kind: 'plate', weight_kg: 2.5, count: 2 },
  { kind: 'plate', weight_kg: 1.25, count: 2 },
  ...[10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30].map((w) => ({ kind: 'dumbbell' as const, weight_kg: w, count: 1 })),
];

const barbell: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
  { equipment: 'barbell', bar_kg: 20, increment_kg: 2.5 };

test('une charge chargeable est rendue telle quelle, avec ses disques', () => {
  const fit = loadable(82.5, barbell, gym);
  assert.equal(fit.weightKg, 82.5);
  assert.deepEqual(fit.perSide, [20, 10, 1.25], '20 + 10 + 1,25 de chaque cote + barre de 20');
});

test('sans disques de 1,25, la charge redescend au chargeable', () => {
  const withoutSmall = gym.filter((i) => i.weight_kg !== 1.25);
  assert.equal(loadable(82.5, barbell, withoutSmall).weightKg, 80);
});

test("la recherche est exhaustive, la gloutonne raterait le compte", () => {
  // 20 (une paire) et 15 (deux paires) : la gloutonne prend le 20 puis bloque
  // a 60 kg, alors que 15 + 15 tombe juste sur 80.
  const sparse: EquipmentItem[] = [
    { kind: 'plate', weight_kg: 20, count: 1 },
    { kind: 'plate', weight_kg: 15, count: 2 },
  ];
  const fit = loadable(80, barbell, sparse);
  assert.equal(fit.weightKg, 80);
  assert.deepEqual(fit.perSide, [15, 15]);
});

test('la barre seule est le plancher', () => {
  assert.equal(loadable(12, barbell, gym).weightKg, 20);
  assert.deepEqual(loadable(12, barbell, gym).perSide, []);
});

test("le nombre de paires disponibles est respecte", () => {
  const one: EquipmentItem[] = [{ kind: 'plate', weight_kg: 20, count: 1 }];
  const fit = loadable(200, barbell, one);
  assert.equal(fit.weightKg, 60, 'une seule paire de 20 : 20 + 2 x 20');
  assert.deepEqual(fit.perSide, [20]);
});

test('un haltere accroche au barreau existant le plus proche', () => {
  const dumbbell: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'dumbbell', bar_kg: null, increment_kg: 2.5 };
  assert.equal(loadable(27, dumbbell, gym).weightKg, 26, 'a egale distance, on ne force pas a monter');
  assert.equal(loadable(29.5, dumbbell, gym).weightKg, 30);
  assert.equal(loadable(21, dumbbell, gym).weightKg, 20);
  assert.equal(loadable(24, dumbbell, gym).perSide, null);
});

test("une machine s arrondit a son propre increment", () => {
  const machine: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'machine', bar_kg: null, increment_kg: 5 };
  assert.equal(loadable(142, machine, gym).weightKg, 140);
  assert.equal(loadable(143, machine, gym).weightKg, 145);
});

test('au poids du corps, la charge saisie est un lest libre', () => {
  const bodyweight: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'bodyweight', bar_kg: null, increment_kg: 2.5 };
  assert.equal(loadable(7.5, bodyweight, gym).weightKg, 7.5);
});

test('la suggestion passe par le chargeable quand le materiel est connu', () => {
  const sessions = [session('s1', 1, '2026-01-01T10:00:00Z')];
  const sets = [1, 2, 3, 4].map((i) => set(`x${i}`, 's1', i, 80, 8, '2026-01-01T10:00:00Z'));
  const withoutSmall = gym.filter((i) => i.weight_kg !== 1.25);

  const suggestion = suggestLoad(previousPerformance(sets, sessions, 1), routine, 2.5, {
    exercise: barbell, inventory: withoutSmall,
  });
  assert.equal(suggestion.weight_kg, 80, '82,5 n est pas chargeable ici');
  assert.equal(suggestion.incremented, false, "on n annonce pas une hausse qui n a pas lieu");
});

// --- Echauffement propose --------------------------------------------------

test('une charge lourde merite quatre paliers, une charge legere deux', () => {
  const heavy = warmupRamp(140, barbell, gym);
  const light = warmupRamp(35, barbell, gym);

  assert.equal(heavy.length, 4, '140 kg sur une barre de 20 : montee en quatre temps');
  assert.equal(light.length, 2, '35 kg : deux suffisent');
});

test('la rampe part de la barre a vide et monte jusqu a 85 %', () => {
  const ramp = warmupRamp(100, barbell, gym);

  assert.equal(ramp[0].weightKg, 20, 'premier palier : la barre');
  assert.equal(ramp[0].bar, true);
  assert.equal(ramp[ramp.length - 1].weightKg, 85, 'dernier palier : 85 %');
  assert.ok(ramp.every((step) => step.weightKg < 100), 'aucun palier n atteint la charge de travail');
});

test('les repetitions descendent et le repos s allonge a mesure qu on monte', () => {
  const ramp = warmupRamp(140, barbell, gym);

  assert.deepEqual(ramp.map((s) => s.reps), [10, 5, 3, 2]);
  assert.deepEqual(ramp.map((s) => s.restSeconds), [30, 30, 45, 60]);
  for (let i = 1; i < ramp.length; i++) {
    assert.ok(ramp[i].weightKg > ramp[i - 1].weightKg, 'la charge monte a chaque palier');
  }
});

test("le dernier palier prend le repos de l exercice : une serie de travail suit", () => {
  const ramp = warmupRamp(140, barbell, gym, 180);

  assert.deepEqual(ramp.map((s) => s.restSeconds), [30, 30, 45, 180]);
  assert.equal(warmupRamp(140, barbell, gym).at(-1)?.restSeconds, 60,
    'sans repos d exercice fourni, on garde celui de la rampe');
});

test('chaque palier est une charge reellement montable', () => {
  const withoutSmall = gym.filter((i) => i.weight_kg !== 1.25 && i.weight_kg !== 2.5);
  const ramp = warmupRamp(100, barbell, withoutSmall);
  for (const step of ramp) {
    assert.equal(loadable(step.weightKg, barbell, withoutSmall).weightKg, step.weightKg);
  }
});

test("rien a echauffer quand la charge de travail frole le depart", () => {
  assert.deepEqual(warmupRamp(25, barbell, gym), [], 'une barre a 25 kg n a pas de rampe');
  assert.deepEqual(warmupRamp(0, barbell, gym), []);
});

test('un halterophile sans barre part de 40 % de la charge', () => {
  const dumbbell: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'dumbbell', bar_kg: null, increment_kg: 2 };
  const ramp = warmupRamp(30, dumbbell, gym);

  assert.ok(ramp.length >= 2);
  assert.ok(ramp[0].weightKg <= 14, 'depart autour de 40 % (12 kg), arrondi au barreau');
  assert.ok(ramp.every((s) => !s.bar), 'aucune barre a vide sans barre');
});

test("hors barre, le nombre de paliers suit la charge et non un rapport", () => {
  const dumbbell: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'dumbbell', bar_kg: null, increment_kg: 2 };
  const machine: Pick<Exercise, 'equipment' | 'bar_kg' | 'increment_kg'> =
    { equipment: 'machine', bar_kg: null, increment_kg: 5 };

  // Mesuree en part de la charge, l'echelle donnait un rapport constant : des
  // elevations laterales a 12 kg recevaient autant de paliers qu'une presse a
  // 140. C'est la charge absolue qui decide.
  assert.deepEqual(warmupRamp(12.5, dumbbell, gym), [], 'rien a preparer sur une charge legere');
  assert.equal(warmupRamp(30, dumbbell, gym).length, 2);
  assert.equal(warmupRamp(140, machine, gym).length, 4);
  assert.ok(warmupRamp(140, machine, gym).length > warmupRamp(45, machine, gym).length,
    'plus lourd, plus de paliers');
});

test('les paliers identiques apres arrondi sont fusionnes et renumerotes', () => {
  const coarse: EquipmentItem[] = [{ kind: 'plate', weight_kg: 20, count: 4 }];
  const ramp = warmupRamp(100, barbell, coarse);

  assert.equal(new Set(ramp.map((s) => s.weightKg)).size, ramp.length, 'aucun doublon');
  assert.deepEqual(ramp.map((s) => s.index), ramp.map((_, i) => i + 1), 'numerotation continue');
});

// --- RPE -------------------------------------------------------------------

function withRpe(weight: number, rpe: number): SetEntry[] {
  return [1, 2, 3, 4].map((i) => set(`x${i}`, 's1', i, weight, 8, `2026-01-01T10:0${i}:00Z`, 'work', rpe));
}
const oneSession = [session('s1', 1, '2026-01-01T10:00:00Z')];
const suggestWith = (sets: SetEntry[]) =>
  suggestLoad(previousPerformance(sets, oneSession, 1), routine, 2.5);

test('RPE 7 sur toutes les series : la charge saute deux increments', () => {
  const suggestion = suggestWith(withRpe(80, 7));
  assert.equal(suggestion.weight_kg, 85);
  assert.equal(suggestion.reason, 'double-increment');
});

test('RPE 8 : increment nominal, comme sans RPE', () => {
  assert.equal(suggestWith(withRpe(80, 8)).weight_kg, 82.5);
  assert.equal(suggestWith(withRpe(80, 8)).reason, 'increment');
});

test('RPE 9 : la fourchette est bouclee mais on consolide', () => {
  const suggestion = suggestWith(withRpe(80, 9));
  assert.equal(suggestion.weight_kg, 80);
  assert.equal(suggestion.incremented, false);
  assert.equal(suggestion.reason, 'consolidate');
});

test('un RPE partiel est ignore : une moyenne incomplete dirait n importe quoi', () => {
  const sets = withRpe(80, 7);
  sets[2].rpe = null;
  const suggestion = suggestWith(sets);
  assert.equal(suggestion.weight_kg, 82.5, 'on retombe sur la regle sans RPE');
  assert.equal(suggestion.reason, 'increment');
});

// --- Stagnation et deload --------------------------------------------------

function stalledSession(id: string, weight: number, reps: number[]): { sessionId: string; date: string; sets: SetEntry[] } {
  return {
    sessionId: id,
    date: `2026-01-0${id.slice(-1)}T10:00:00Z`,
    sets: reps.map((r, i) => set(`${id}-${i}`, id, i + 1, weight, r, `2026-01-0${id.slice(-1)}T10:00:00Z`)),
  };
}

test('deux seances bloquees a la meme charge comptent comme une stagnation', () => {
  const history = [stalledSession('s3', 80, [8, 8, 8, 7]), stalledSession('s2', 80, [8, 8, 7, 7])];
  assert.equal(stallStreak(history, routine), 2);
});

test('une seance reussie remet le compteur de stagnation a zero', () => {
  const history = [stalledSession('s3', 80, [8, 8, 8, 7]), stalledSession('s2', 80, [8, 8, 8, 8])];
  assert.equal(stallStreak(history, routine), 1);
});

test('un changement de charge interrompt la serie de stagnation', () => {
  const history = [stalledSession('s3', 80, [8, 8, 7]), stalledSession('s2', 75, [8, 8, 7])];
  assert.equal(stallStreak(history, routine), 1);
});

test('apres deux echecs, un allegement est propose — jamais impose', () => {
  const history = [stalledSession('s3', 80, [8, 8, 8, 7]), stalledSession('s2', 80, [8, 8, 7, 7])];
  const suggestion = suggestLoad(history[0], routine, 2.5, { history, deloadPercent: 10 });

  assert.equal(suggestion.reason, 'deload');
  assert.equal(suggestion.weight_kg, 72, '80 kg allege de 10 %');
  assert.equal(suggestion.incremented, false);
});

test('sans historique fourni, aucun deload ne peut se declencher', () => {
  const history = [stalledSession('s3', 80, [8, 8, 8, 7])];
  assert.equal(suggestLoad(history[0], routine, 2.5).reason, 'hold');
});

// --- Records ---------------------------------------------------------------

test('les quatre types de record sont detectes', () => {
  const entry = set('x1', 's1', 1, 100, 5, '2026-01-01T10:00:00Z');
  const found = detectRecords(entry, [entry], {});
  assert.deepEqual(found.map((r) => r.kind).sort(), ['e1rm', 'session_volume', 'set_volume', 'weight']);
});

test('egaler un record ne suffit pas a le battre', () => {
  const entry = set('x1', 's1', 1, 100, 5, '2026-01-01T10:00:00Z');
  const best = { '1:weight': 100, '1:e1rm': e1rm(100, 5)!, '1:set_volume': 500, '1:session_volume': 500 };
  assert.deepEqual(detectRecords(entry, [entry], best), []);
});

test('un record de charge se detecte meme sans record de volume', () => {
  const entry = set('x1', 's1', 1, 110, 3, '2026-01-01T10:00:00Z');
  const best = { '1:weight': 100, '1:e1rm': 200, '1:set_volume': 500, '1:session_volume': 500 };
  const found = detectRecords(entry, [entry], best);
  assert.deepEqual(found.map((r) => r.kind), ['weight']);
  assert.equal(found[0].previous, 100);
});

test('un echauffement ne bat jamais de record', () => {
  const entry = set('w1', 's1', 1, 200, 10, '2026-01-01T10:00:00Z', 'warmup');
  assert.deepEqual(detectRecords(entry, [entry], {}), []);
});

test('le volume de seance cumule les series de l exercice', () => {
  const first = set('x1', 's1', 1, 80, 8, '2026-01-01T10:00:00Z');
  const second = set('x2', 's1', 2, 80, 8, '2026-01-01T10:04:00Z');
  const found = detectRecords(second, [first, second], { '1:session_volume': 700 });
  const record = found.find((r) => r.kind === 'session_volume');
  assert.equal(record?.value, 1280);
});

test("l historique rend les seances de la plus recente a la plus ancienne", () => {
  const sessions = [
    session('s1', 1, '2026-01-01T10:00:00Z'),
    session('s2', 1, '2026-01-08T10:00:00Z'),
    session('s3', 1, '2026-01-15T10:00:00Z'),
  ];
  const sets = [
    set('a', 's1', 1, 70, 8, '2026-01-01T10:01:00Z'),
    set('b', 's2', 1, 75, 8, '2026-01-08T10:01:00Z'),
    set('w', 's3', 1, 20, 10, '2026-01-15T10:00:00Z', 'warmup'),
    set('c', 's3', 1, 80, 8, '2026-01-15T10:01:00Z'),
  ];

  const history = performanceHistory(sets, sessions, 1);
  assert.deepEqual(history.map((h) => h.sessionId), ['s3', 's2', 's1']);
  assert.equal(history[0].sets.length, 1, "l echauffement n entre pas dans l historique");
  assert.equal(history[0].sets[0].weight_kg, 80);
});

// --- Charge reellement soulevee -------------------------------------------

const pullups: Pick<Exercise, 'id' | 'bodyweight_factor' | 'unilateral'> =
  { id: 1, bodyweight_factor: 1, unilateral: 0 };
const rowOneArm: Pick<Exercise, 'id' | 'bodyweight_factor' | 'unilateral'> =
  { id: 2, bodyweight_factor: null, unilateral: 1 };

const weighIns: Bodyweight[] = [
  { measured_on: '2026-01-01', weight_kg: 78 },
  { measured_on: '2026-03-01', weight_kg: 82 },
];

test('une traction sans lest cesse d etre invisible', () => {
  const sets = [1, 2, 3, 4].map((i) => set(`p${i}`, 's1', i, 0, 8, '2026-03-05T10:00:00Z'));

  // Sans resolution : c'est le defaut que la v2 laissait passer.
  assert.equal(workVolume(sets), 0);
  assert.equal(bestE1rm(sets), null);
  assert.deepEqual(detectRecords(sets[0], sets, {}), []);

  const resolve = makeLoadResolver([pullups], weighIns);
  assert.equal(workVolume(sets, resolve), 82 * 8 * 4, 'le corps est la charge');
  assert.equal(bestE1rm(sets, resolve), e1rm(82, 8));
  assert.ok(detectRecords(sets[0], sets, {}, resolve).length > 0, 'un record devient possible');
});

test('le lest s ajoute au poids du corps, l assistance s en retranche', () => {
  const resolve = makeLoadResolver([pullups], weighIns);
  const lester = set('a', 's1', 1, 10, 5, '2026-03-05T10:00:00Z');
  const assiste = set('b', 's1', 1, -20, 12, '2026-03-05T10:00:00Z');

  assert.equal(resolve(lester).load, 92);
  assert.equal(resolve(assiste).load, 62, "l'assistance a la poulie allege");
});

test('le poids retenu est celui du jour de la serie, pas le dernier connu', () => {
  const resolve = makeLoadResolver([pullups], weighIns);
  assert.equal(resolve(set('x', 's1', 1, 0, 8, '2026-01-15T10:00:00Z')).load, 78, 'pesee de janvier');
  assert.equal(resolve(set('y', 's2', 1, 0, 8, '2026-03-15T10:00:00Z')).load, 82, 'pesee de mars');
});

test('sans aucune pesee, on s abstient plutot que d inventer', () => {
  const resolve = makeLoadResolver([pullups], []);
  assert.equal(resolve(set('x', 's1', 1, 15, 8, '2026-03-05T10:00:00Z')).load, 15);
});

test('un exercice unilateral compte double dans le tonnage', () => {
  const sets = [1, 2, 3].map((i) => ({ ...set(`r${i}`, 's1', i, 30, 10, '2026-03-05T10:00:00Z'), exercise_id: 2 }));
  const resolve = makeLoadResolver([rowOneArm], weighIns);

  assert.equal(workVolume(sets), 30 * 10 * 3, 'sans resolution, un cote seulement');
  assert.equal(workVolume(sets, resolve), 30 * 10 * 3 * 2, 'dix repetitions par bras en font vingt');
  assert.equal(topSet(sets, resolve), 30, 'la charge par bras reste celle du bras');
});

test('un exercice a charge externe n est pas affecte par la resolution', () => {
  const bench: Pick<Exercise, 'id' | 'bodyweight_factor' | 'unilateral'> =
    { id: 3, bodyweight_factor: null, unilateral: 0 };
  const sets = [{ ...set('b1', 's1', 1, 80, 8, '2026-03-05T10:00:00Z'), exercise_id: 3 }];
  const resolve = makeLoadResolver([bench], weighIns);

  assert.equal(workVolume(sets, resolve), workVolume(sets));
  assert.equal(bestE1rm(sets, resolve), bestE1rm(sets));
});
