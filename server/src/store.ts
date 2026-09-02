import { db } from './db.ts';
import type {
  Bodyweight, Bootstrap, EquipmentItem, Exercise, ExerciseAlternative,
  ExerciseMuscle, ExerciseNote, FoodLog, MealTemplate, Muscle, PersonalRecord,
  RecordKind, RoutineDay, RoutineExercise, Session, SessionSwap, SetEntry,
  Settings, SyncOp, SyncResult,
} from '../../shared/types.ts';
import { e1rm, makeLoadResolver, weeklyVolume, workVolume } from '../../shared/domain.ts';

type SessionInput = Pick<Session, 'id' | 'routine_day_id' | 'started_at'> & Partial<Pick<Session, 'ended_at' | 'note'>>;
type SetInput = Omit<SetEntry, 'kind' | 'rpe'> & Partial<Pick<SetEntry, 'kind' | 'rpe'>>;
type FoodLogInput = Omit<FoodLog, 'template_id'> & { template_id?: number | null };

/** Fenetre chargee au demarrage puis conservee dans IndexedDB (section 3.2). */
export const HISTORY_DAYS = 90;
/** Section 5.4 : aucun historique alimentaire detaille au-dela de 30 jours. */
export const FOOD_DAYS = 30;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function daysAgoDate(days: number): string {
  return daysAgoIso(days).slice(0, 10);
}

// --- Lectures --------------------------------------------------------------

const q = {
  exercises: db.prepare('SELECT * FROM exercise ORDER BY muscle_group, name'),
  routineDays: db.prepare('SELECT * FROM routine_day ORDER BY position'),
  routineExercises: db.prepare('SELECT * FROM routine_exercise ORDER BY routine_day_id, position'),
  mealTemplates: db.prepare('SELECT * FROM meal_template ORDER BY position'),
  sessionsSince: db.prepare('SELECT * FROM session WHERE started_at >= ? ORDER BY started_at DESC'),
  setsSince: db.prepare(`
    SELECT s.* FROM set_entry s
    JOIN session ss ON ss.id = s.session_id
    WHERE ss.started_at >= ?
    ORDER BY s.done_at
  `),
  bodyweightsSince: db.prepare('SELECT * FROM bodyweight WHERE measured_on >= ? ORDER BY measured_on'),
  foodSince: db.prepare('SELECT * FROM food_log WHERE logged_on >= ? ORDER BY logged_on, rowid'),
  settings: db.prepare('SELECT key, value FROM setting'),
  muscles: db.prepare('SELECT * FROM muscle ORDER BY position'),
  exerciseMuscles: db.prepare('SELECT * FROM exercise_muscle'),
  equipment: db.prepare('SELECT * FROM equipment_item ORDER BY kind, weight_kg'),
  notesSince: db.prepare(`
    SELECT n.* FROM exercise_note n
    JOIN session s ON s.id = n.session_id
    WHERE s.started_at >= ?
  `),
  loadProfiles: db.prepare('SELECT id, bodyweight_factor, unilateral FROM exercise'),
  allBodyweights: db.prepare('SELECT * FROM bodyweight'),
  workingSets: db.prepare("SELECT * FROM set_entry WHERE kind <> 'warmup' ORDER BY done_at"),
  alternatives: db.prepare('SELECT * FROM exercise_alternative ORDER BY exercise_id, position'),
  swapsSince: db.prepare(`
    SELECT w.* FROM session_swap w
    JOIN session s ON s.id = w.session_id
    WHERE s.started_at >= ?
  `),
};

const SETTING_DEFAULTS: Settings = {
  kcal_target: 3000,
  protein_target_g: 160,
  weekly_gain_target_kg: 0.25,
  // Booleens stockes en 0/1 : la table `setting` ne transporte que des nombres.
  rpe_enabled: 0,
  warmup_enabled: 1,
  deload_percent: 10,
};

export function readSettings(): Settings {
  const rows = q.settings.all() as { key: string; value: string }[];
  const out = { ...SETTING_DEFAULTS };
  for (const { key, value } of rows) {
    if (key in out) {
      const n = Number(value);
      if (Number.isFinite(n)) (out as Record<string, number>)[key] = n;
    }
  }
  return out;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const stmt = db.prepare(`
    INSERT INTO setting (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (key in SETTING_DEFAULTS && typeof value === 'number' && Number.isFinite(value)) {
        stmt.run(key, String(value));
      }
    }
  })();
  return readSettings();
}

export function bootstrap(): Bootstrap {
  const since = daysAgoIso(HISTORY_DAYS);
  return {
    exercises: q.exercises.all() as Exercise[],
    routineDays: q.routineDays.all() as RoutineDay[],
    routineExercises: q.routineExercises.all() as RoutineExercise[],
    mealTemplates: q.mealTemplates.all() as MealTemplate[],
    sessions: q.sessionsSince.all(since) as Session[],
    sets: q.setsSince.all(since) as SetEntry[],
    bodyweights: q.bodyweightsSince.all(daysAgoDate(HISTORY_DAYS)) as Bodyweight[],
    foodLogs: q.foodSince.all(daysAgoDate(FOOD_DAYS)) as FoodLog[],
    settings: readSettings(),
    muscles: q.muscles.all() as Muscle[],
    exerciseMuscles: q.exerciseMuscles.all() as ExerciseMuscle[],
    equipment: q.equipment.all() as EquipmentItem[],
    exerciseNotes: q.notesSince.all(since) as ExerciseNote[],
    alternatives: q.alternatives.all() as ExerciseAlternative[],
    swaps: q.swapsSince.all(since) as SessionSwap[],
    records: personalRecords(),
    serverTime: new Date().toISOString(),
  };
}

// --- Records ---------------------------------------------------------------
//
// Derives de `set_entry` a chaque lecture plutot que stockes : corriger une
// serie a posteriori corrige immediatement les records, sans table a
// resynchroniser. Le cout est celui d'un GROUP BY sur quelques milliers de
// lignes, pour un seul utilisateur.

/** Resolution des charges construite sur l'etat courant de la base. */
function loadResolver() {
  return makeLoadResolver(
    q.loadProfiles.all() as Pick<Exercise, 'id' | 'bodyweight_factor' | 'unilateral'>[],
    q.allBodyweights.all() as Bodyweight[],
  );
}

/**
 * Meilleures performances de toute l'histoire, par exercice et par type.
 *
 * Calcule en JavaScript avec les fonctions du domaine plutot qu'en SQL : la
 * charge reellement soulevee depend du poids de corps au jour de la serie, et
 * transcrire cette regle une seconde fois en SQL garantissait qu'un jour les
 * deux versions divergeraient. Le cout est de parcourir les series de travail
 * d'un seul utilisateur, ce qui reste negligeable.
 */
export function personalRecords(): PersonalRecord[] {
  const sets = q.workingSets.all() as SetEntry[];
  const resolve = loadResolver();

  const best = new Map<string, PersonalRecord>();
  const keep = (exerciseId: number, kind: RecordKind, value: number | null, at: string) => {
    if (value === null || value <= 0) return;
    const key = `${exerciseId}:${kind}`;
    const current = best.get(key);
    if (!current || value > current.value) {
      best.set(key, { exercise_id: exerciseId, kind, value: Math.round(value * 10) / 10, achieved_at: at });
    }
  };

  const sessionTotals = new Map<string, { sets: SetEntry[]; at: string }>();

  for (const set of sets) {
    const { load, sides } = resolve(set);
    if (load <= 0 || set.reps < 1) continue;

    keep(set.exercise_id, 'weight', load, set.done_at);
    keep(set.exercise_id, 'e1rm', e1rm(load, set.reps), set.done_at);
    keep(set.exercise_id, 'set_volume', load * set.reps * sides, set.done_at);

    const key = `${set.exercise_id}:${set.session_id}`;
    const bucket = sessionTotals.get(key);
    if (bucket) { bucket.sets.push(set); bucket.at = set.done_at; }
    else sessionTotals.set(key, { sets: [set], at: set.done_at });
  }

  for (const [key, { sets: grouped, at }] of sessionTotals) {
    keep(Number(key.split(':')[0]), 'session_volume', workVolume(grouped, resolve), at);
  }

  return [...best.values()];
}

// --- Volume hebdomadaire ---------------------------------------------------

const setsSinceDate = db.prepare("SELECT * FROM set_entry WHERE done_at >= ? ORDER BY done_at");

/** Volume fractionne par muscle sur les `weeks` dernieres semaines. */
export function volumeStats(weeks: number) {
  // Une semaine de marge : le lundi de la premiere semaine peut preceder
  // `weeks * 7` jours en arriere.
  const since = daysAgoIso(weeks * 7 + 7);
  const sets = setsSinceDate.all(since) as SetEntry[];
  const mapping = q.exerciseMuscles.all() as ExerciseMuscle[];

  return {
    weeks: weeklyVolume(sets, mapping, weeks),
    muscles: q.muscles.all() as Muscle[],
  };
}

const historyStmt = db.prepare(`
  SELECT s.* FROM set_entry s
  WHERE s.exercise_id = ?
    AND s.session_id IN (
      SELECT session_id FROM set_entry
      WHERE exercise_id = ?
      GROUP BY session_id
      ORDER BY MAX(done_at) DESC
      LIMIT ?
    )
  ORDER BY s.done_at, s.set_index
`);

/** Les `limit` dernieres SEANCES sur un exercice, series completes. */
export function exerciseHistory(exerciseId: number, limit: number): SetEntry[] {
  return historyStmt.all(exerciseId, exerciseId, limit) as SetEntry[];
}

export function bodyweightRange(days: number): Bodyweight[] {
  return q.bodyweightsSince.all(daysAgoDate(days)) as Bodyweight[];
}

// --- Ecritures, toutes idempotentes par identifiant client ------------------

const w = {
  insertSession: db.prepare(`
    INSERT INTO session (id, routine_day_id, started_at, ended_at, note)
    VALUES (@id, @routine_day_id, @started_at, @ended_at, @note)
    ON CONFLICT(id) DO NOTHING
  `),
  getSession: db.prepare('SELECT * FROM session WHERE id = ?'),
  updateSession: db.prepare(`
    UPDATE session
       SET ended_at = COALESCE(@ended_at, ended_at),
           note     = COALESCE(@note, note)
     WHERE id = @id
  `),
  insertSet: db.prepare(`
    INSERT INTO set_entry (id, session_id, exercise_id, set_index, weight_kg, reps, done_at, kind, rpe)
    VALUES (@id, @session_id, @exercise_id, @set_index, @weight_kg, @reps, @done_at, @kind, @rpe)
    ON CONFLICT(id) DO NOTHING
  `),
  getSet: db.prepare('SELECT * FROM set_entry WHERE id = ?'),
  updateSet: db.prepare(`
    UPDATE set_entry
       SET weight_kg = COALESCE(@weight_kg, weight_kg),
           reps      = COALESCE(@reps, reps),
           set_index = COALESCE(@set_index, set_index),
           kind      = COALESCE(@kind, kind),
           rpe       = CASE WHEN @clear_rpe = 1 THEN NULL ELSE COALESCE(@rpe, rpe) END
     WHERE id = @id
  `),
  deleteSet: db.prepare('DELETE FROM set_entry WHERE id = ?'),
  upsertBodyweight: db.prepare(`
    INSERT INTO bodyweight (measured_on, weight_kg) VALUES (@measured_on, @weight_kg)
    ON CONFLICT(measured_on) DO UPDATE SET weight_kg = excluded.weight_kg
  `),
  deleteBodyweight: db.prepare('DELETE FROM bodyweight WHERE measured_on = ?'),
  insertFood: db.prepare(`
    INSERT INTO food_log (id, logged_on, label, kcal, protein_g, template_id)
    VALUES (@id, @logged_on, @label, @kcal, @protein_g, @template_id)
    ON CONFLICT(id) DO NOTHING
  `),
  deleteFood: db.prepare('DELETE FROM food_log WHERE id = ?'),
};

export function createSession(input: SessionInput): Session {
  w.insertSession.run({
    id: input.id,
    routine_day_id: input.routine_day_id,
    started_at: input.started_at,
    ended_at: input.ended_at ?? null,
    note: input.note ?? null,
  });
  return w.getSession.get(input.id) as Session;
}

export function updateSession(id: string, patch: { ended_at?: string | null; note?: string | null }): Session | null {
  w.updateSession.run({ id, ended_at: patch.ended_at ?? null, note: patch.note ?? null });
  return (w.getSession.get(id) as Session) ?? null;
}

export function createSet(input: SetInput): SetEntry {
  // `kind` et `rpe` sont optionnels : une file d'attente remplie par un client
  // v1 doit continuer a passer.
  w.insertSet.run({
    id: input.id,
    session_id: input.session_id,
    exercise_id: input.exercise_id,
    set_index: input.set_index,
    weight_kg: input.weight_kg,
    reps: input.reps,
    done_at: input.done_at,
    kind: input.kind ?? 'work',
    rpe: input.rpe ?? null,
  });
  return w.getSet.get(input.id) as SetEntry;
}

export function updateSet(
  id: string,
  patch: { weight_kg?: number; reps?: number; set_index?: number; kind?: string; rpe?: number | null },
): SetEntry | null {
  w.updateSet.run({
    id,
    weight_kg: patch.weight_kg ?? null,
    reps: patch.reps ?? null,
    set_index: patch.set_index ?? null,
    kind: patch.kind ?? null,
    rpe: patch.rpe ?? null,
    // `rpe: null` explicite doit effacer la valeur, la ou un champ absent la garde.
    clear_rpe: 'rpe' in patch && patch.rpe === null ? 1 : 0,
  });
  return (w.getSet.get(id) as SetEntry) ?? null;
}

export function deleteSet(id: string): void {
  w.deleteSet.run(id);
}

export function upsertBodyweight(entry: Bodyweight): Bodyweight {
  w.upsertBodyweight.run(entry);
  return entry;
}

export function deleteBodyweight(date: string): void {
  w.deleteBodyweight.run(date);
}

export function createFoodLog(input: FoodLogInput): FoodLog {
  const row: FoodLog = { template_id: null, ...input };
  w.insertFood.run(row);
  return row;
}

export function deleteFoodLog(id: string): void {
  w.deleteFood.run(id);
}

// --- Programme et templates (ecrans Programme / Reglages) -------------------

export function replaceRoutineExercises(dayId: number, slots: Omit<RoutineExercise, 'id' | 'routine_day_id'>[]): RoutineExercise[] {
  const del = db.prepare('DELETE FROM routine_exercise WHERE routine_day_id = ?');
  const ins = db.prepare(`
    INSERT INTO routine_exercise
      (routine_day_id, exercise_id, position, target_sets, rep_min, rep_max, rest_seconds, superset_group)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    del.run(dayId);
    slots.forEach((s, i) => {
      ins.run(dayId, s.exercise_id, i + 1, s.target_sets, s.rep_min, s.rep_max, s.rest_seconds, s.superset_group ?? null);
    });
  })();
  return db.prepare('SELECT * FROM routine_exercise WHERE routine_day_id = ? ORDER BY position').all(dayId) as RoutineExercise[];
}

export function renameRoutineDay(id: number, name: string): RoutineDay | null {
  db.prepare('UPDATE routine_day SET name = ? WHERE id = ?').run(name, id);
  return (db.prepare('SELECT * FROM routine_day WHERE id = ?').get(id) as RoutineDay) ?? null;
}

export function createExercise(input: Omit<Exercise, 'id' | 'archived_at'>): Exercise {
  const info = db.prepare(`
    INSERT INTO exercise (name, muscle_group, increment_kg, is_bodyweight, equipment, bar_kg)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.name, input.muscle_group, input.increment_kg, input.is_bodyweight, input.equipment, input.bar_kg);
  return db.prepare('SELECT * FROM exercise WHERE id = ?').get(info.lastInsertRowid) as Exercise;
}

export function updateExercise(id: number, patch: Partial<Exercise>): Exercise | null {
  db.prepare(`
    UPDATE exercise
       SET name         = COALESCE(@name, name),
           muscle_group = COALESCE(@muscle_group, muscle_group),
           increment_kg = COALESCE(@increment_kg, increment_kg),
           equipment    = COALESCE(@equipment, equipment),
           bar_kg       = COALESCE(@bar_kg, bar_kg),
           archived_at  = @archived_at
     WHERE id = @id
  `).run({
    id,
    name: patch.name ?? null,
    muscle_group: patch.muscle_group ?? null,
    increment_kg: patch.increment_kg ?? null,
    equipment: patch.equipment ?? null,
    bar_kg: patch.bar_kg ?? null,
    archived_at: patch.archived_at === undefined
      ? ((db.prepare('SELECT archived_at FROM exercise WHERE id = ?').get(id) as { archived_at: string | null } | undefined)?.archived_at ?? null)
      : patch.archived_at,
  });
  return (db.prepare('SELECT * FROM exercise WHERE id = ?').get(id) as Exercise) ?? null;
}

export function saveMealTemplates(templates: Omit<MealTemplate, 'id' | 'position'>[]): MealTemplate[] {
  const ins = db.prepare('INSERT INTO meal_template (name, kcal, protein_g, position) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    // Les food_log referencent meal_template : on detache avant de reecrire.
    db.prepare('UPDATE food_log SET template_id = NULL').run();
    db.prepare('DELETE FROM meal_template').run();
    templates.forEach((t, i) => ins.run(t.name, t.kcal, t.protein_g, i + 1));
  })();
  return q.mealTemplates.all() as MealTemplate[];
}

/** Remplace l'inventaire de la salle. Meme forme que les repas types. */
export function saveEquipment(items: Omit<EquipmentItem, never>[]): EquipmentItem[] {
  const insert = db.prepare('INSERT INTO equipment_item (kind, weight_kg, count) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM equipment_item').run();
    for (const item of items) insert.run(item.kind, item.weight_kg, item.count);
  })();
  return q.equipment.all() as EquipmentItem[];
}

/** Cartographie musculaire d'un exercice : 1,0 pour le moteur, 0,5 pour un synergiste. */
export function saveExerciseMuscles(
  exerciseId: number,
  rows: { muscle_id: string; share: number }[],
): ExerciseMuscle[] {
  const insert = db.prepare('INSERT INTO exercise_muscle (exercise_id, muscle_id, share) VALUES (?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM exercise_muscle WHERE exercise_id = ?').run(exerciseId);
    for (const row of rows) insert.run(exerciseId, row.muscle_id, row.share);
  })();
  return db.prepare('SELECT * FROM exercise_muscle WHERE exercise_id = ?').all(exerciseId) as ExerciseMuscle[];
}

const upsertNote = db.prepare(`
  INSERT INTO exercise_note (exercise_id, session_id, note, updated_at)
  VALUES (@exercise_id, @session_id, @note, @updated_at)
  ON CONFLICT(exercise_id, session_id) DO UPDATE
    SET note = excluded.note, updated_at = excluded.updated_at
`);
const deleteNote = db.prepare('DELETE FROM exercise_note WHERE exercise_id = ? AND session_id = ?');

/** Note attachee a un exercice pour une seance. Une note vide efface la ligne. */
export function saveExerciseNote(input: { exercise_id: number; session_id: string; note: string }): ExerciseNote | null {
  const note = input.note.trim();
  if (!note) {
    deleteNote.run(input.exercise_id, input.session_id);
    return null;
  }
  const row = { ...input, note, updated_at: new Date().toISOString() };
  upsertNote.run(row);
  return row;
}

const upsertSwap = db.prepare(`
  INSERT INTO session_swap (session_id, planned_id, actual_id)
  VALUES (@session_id, @planned_id, @actual_id)
  ON CONFLICT(session_id, planned_id) DO UPDATE SET actual_id = excluded.actual_id
`);
const removeSwap = db.prepare('DELETE FROM session_swap WHERE session_id = ? AND planned_id = ?');

/** Remplacement d'un exercice pour une seance : la machine prevue etait prise. */
export function setSwap(input: SessionSwap): SessionSwap {
  upsertSwap.run(input);
  return input;
}

export function clearSwap(sessionId: string, plannedId: number): void {
  removeSwap.run(sessionId, plannedId);
}

/** Remplace la liste des alternatives d'un exercice, dans les deux sens. */
export function saveAlternatives(exerciseId: number, alternativeIds: number[]): ExerciseAlternative[] {
  const drop = db.prepare('DELETE FROM exercise_alternative WHERE exercise_id = ? OR alternative_id = ?');
  const add = db.prepare(`
    INSERT INTO exercise_alternative (exercise_id, alternative_id, position) VALUES (?, ?, ?)
    ON CONFLICT(exercise_id, alternative_id) DO NOTHING
  `);
  db.transaction(() => {
    drop.run(exerciseId, exerciseId);
    alternativeIds.forEach((other, i) => {
      if (other === exerciseId) return;
      add.run(exerciseId, other, i + 1);
      // Une alternative vaut dans les deux sens : depuis la machine choisie, on
      // doit pouvoir revenir a l'exercice prevu.
      add.run(other, exerciseId, 99);
    });
  })();
  return db.prepare('SELECT * FROM exercise_alternative WHERE exercise_id = ? ORDER BY position')
    .all(exerciseId) as ExerciseAlternative[];
}

// --- Synchronisation (section 3.4) -----------------------------------------

const APPLIERS: Record<SyncOp['type'], (payload: any) => void> = {
  'session.create': (p) => void createSession(p),
  'session.update': (p) => void updateSession(p.id, p),
  'set.create': (p) => void createSet(p),
  'set.update': (p) => void updateSet(p.id, p),
  'set.delete': (p) => void deleteSet(p.id),
  'bodyweight.upsert': (p) => void upsertBodyweight(p),
  'food.create': (p) => void createFoodLog(p),
  'food.delete': (p) => void deleteFoodLog(p.id),
  'note.upsert': (p) => void saveExerciseNote(p),
  'swap.set': (p) => void setSwap(p),
  'swap.clear': (p) => void clearSwap(p.session_id, p.planned_id),
};

/**
 * Applique un lot d'ecritures en attente. Chaque operation est appliquee dans
 * sa propre transaction : une operation invalide (seance parente supprimee,
 * par exemple) ne fait pas echouer le reste du lot.
 */
export function applySync(ops: SyncOp[]): SyncResult {
  const applied: string[] = [];
  const failed: { opId: string; error: string }[] = [];

  for (const op of ops) {
    const apply = APPLIERS[op.type];
    if (!apply) {
      failed.push({ opId: op.opId, error: `type inconnu: ${op.type}` });
      continue;
    }
    try {
      db.transaction(apply)(op.payload);
      applied.push(op.opId);
    } catch (err) {
      failed.push({ opId: op.opId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, failed };
}

// --- Export complet (section 7) --------------------------------------------

export function exportAll(): Record<string, unknown> {
  const table = (name: string) => db.prepare(`SELECT * FROM ${name}`).all();
  return {
    format: 'turi-kout/v1',
    exportedAt: new Date().toISOString(),
    exercise: table('exercise'),
    routine_day: table('routine_day'),
    routine_exercise: table('routine_exercise'),
    session: table('session'),
    set_entry: table('set_entry'),
    bodyweight: table('bodyweight'),
    meal_template: table('meal_template'),
    food_log: table('food_log'),
    setting: table('setting'),
    muscle: table('muscle'),
    exercise_muscle: table('exercise_muscle'),
    equipment_item: table('equipment_item'),
    exercise_note: table('exercise_note'),
    exercise_alternative: table('exercise_alternative'),
    session_swap: table('session_swap'),
  };
}
