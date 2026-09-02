import { api, ApiError } from './api.ts';
import * as idb from './idb.ts';
import {
  detectRecords, makeLoadResolver, toSnapshot,
  type DetectedRecord, type LoadResolver,
} from '../../../shared/domain.ts';
import type {
  Bodyweight, Bootstrap, EquipmentItem, Exercise, ExerciseAlternative,
  ExerciseMuscle, ExerciseNote, FoodLog, MealTemplate, Muscle, PersonalRecord,
  RoutineDay, RoutineExercise, Session, SessionSwap, SetEntry, SetKind,
  Settings, SyncOp,
} from '../../../shared/types.ts';

const HISTORY_DAYS = 90;
const FOOD_DAYS = 30;

const DEFAULT_SETTINGS: Settings = {
  kcal_target: 3000,
  protein_target_g: 160,
  weekly_gain_target_kg: 0.25,
  rpe_enabled: 0,
  warmup_enabled: 1,
  deload_percent: 10,
};

export const uuid = (): string =>
  crypto.randomUUID?.() ??
  // Repli pour les contextes non securises (http://ip-locale en developpement).
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;

export const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const olderThan = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Etat unique de l'application.
 *
 * Toute ecriture suit le meme chemin (section 3.3) : mutation en memoire —
 * affichage immediat —, puis persistance IndexedDB, puis mise en file. Rien
 * n'attend le reseau. Aucune resolution de conflit : un seul utilisateur.
 */
class AppStore {
  ready = $state(false);
  authed = $state(false);
  online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
  pending = $state(0);
  syncing = $state(false);
  syncError = $state<string | null>(null);

  exercises = $state<Exercise[]>([]);
  routineDays = $state<RoutineDay[]>([]);
  routineExercises = $state<RoutineExercise[]>([]);
  mealTemplates = $state<MealTemplate[]>([]);
  sessions = $state<Session[]>([]);
  sets = $state<SetEntry[]>([]);
  bodyweights = $state<Bodyweight[]>([]);
  foodLogs = $state<FoodLog[]>([]);
  settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  muscles = $state<Muscle[]>([]);
  exerciseMuscles = $state<ExerciseMuscle[]>([]);
  equipment = $state<EquipmentItem[]>([]);
  /** Meilleures performances de toute l'histoire, envoyees par le serveur. */
  records = $state<PersonalRecord[]>([]);
  exerciseNotes = $state<ExerciseNote[]>([]);
  alternatives = $state<ExerciseAlternative[]>([]);
  swaps = $state<SessionSwap[]>([]);

  private seq = Date.now();

  // --- Selecteurs ----------------------------------------------------------

  get openSession(): Session | null {
    return this.sessions.find((s) => !s.ended_at) ?? null;
  }

  exercise(id: number): Exercise | undefined {
    return this.exercises.find((e) => e.id === id);
  }

  routineDay(id: number): RoutineDay | undefined {
    return this.routineDays.find((d) => d.id === id);
  }

  /** Exercices d'une journee type, dans l'ordre du programme. */
  slotsFor(dayId: number): RoutineExercise[] {
    return this.routineExercises.filter((r) => r.routine_day_id === dayId).sort((a, b) => a.position - b.position);
  }

  setsOf(sessionId: string): SetEntry[] {
    return this.sets.filter((s) => s.session_id === sessionId);
  }

  setsOfExercise(sessionId: string, exerciseId: number): SetEntry[] {
    return this.sets
      .filter((s) => s.session_id === sessionId && s.exercise_id === exerciseId)
      .sort((a, b) => a.set_index - b.set_index);
  }

  /** Instantane des records, indexe pour la detection en direct. */
  get recordSnapshot() {
    return toSnapshot($state.snapshot(this.records));
  }

  /**
   * Resolution des charges : sans elle une traction pese zero et n'entre ni
   * dans le tonnage, ni dans le 1RM estime, ni dans les records.
   */
  get resolveLoad(): LoadResolver {
    return makeLoadResolver($state.snapshot(this.exercises), $state.snapshot(this.bodyweights));
  }

  noteFor(exerciseId: number, sessionId: string): string {
    return this.exerciseNotes.find((n) => n.exercise_id === exerciseId && n.session_id === sessionId)?.note ?? '';
  }

  /** Derniere note ecrite sur cet exercice, hors seance en cours. */
  lastNote(exerciseId: number, exceptSessionId?: string): ExerciseNote | null {
    return this.exerciseNotes
      .filter((n) => n.exercise_id === exerciseId && n.session_id !== exceptSessionId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
  }

  /** Exercices de remplacement, dans l'ordre. */
  alternativesOf(exerciseId: number): Exercise[] {
    return this.alternatives
      .filter((a) => a.exercise_id === exerciseId)
      .sort((a, b) => a.position - b.position)
      .map((a) => this.exercise(a.alternative_id))
      .filter((e): e is Exercise => e !== undefined && !e.archived_at);
  }

  /** Exercice reellement fait a la place de celui prevu, pour cette seance. */
  swapFor(sessionId: string, plannedId: number): number | null {
    return this.swaps.find((w) => w.session_id === sessionId && w.planned_id === plannedId)?.actual_id ?? null;
  }

  /**
   * Remplace l'exercice prevu pour cette seance seulement. `null` remet le
   * prevu. Le programme n'est pas touche : la machine sera peut-etre libre
   * la prochaine fois.
   */
  swapExercise(sessionId: string, plannedId: number, actualId: number | null): void {
    this.swaps = this.swaps.filter((w) => !(w.session_id === sessionId && w.planned_id === plannedId));
    if (actualId !== null) {
      this.swaps = [...this.swaps, { session_id: sessionId, planned_id: plannedId, actual_id: actualId }];
    }

    void this.queue(
      actualId === null ? 'swap.clear' : 'swap.set',
      actualId === null
        ? { session_id: sessionId, planned_id: plannedId }
        : { session_id: sessionId, planned_id: plannedId, actual_id: actualId },
      { swaps: $state.snapshot(this.swaps) },
    );
  }

  musclesOf(exerciseId: number): ExerciseMuscle[] {
    return this.exerciseMuscles.filter((m) => m.exercise_id === exerciseId);
  }

  muscle(id: string): Muscle | undefined {
    return this.muscles.find((m) => m.id === id);
  }

  bodyweightOn(date: string): number | null {
    return this.bodyweights.find((b) => b.measured_on === date)?.weight_kg ?? null;
  }

  foodOn(date: string): FoodLog[] {
    return this.foodLogs.filter((f) => f.logged_on === date);
  }

  // --- Demarrage -----------------------------------------------------------

  async boot(): Promise<void> {
    await this.loadLocal();
    this.pending = await idb.pendingCount();
    this.ready = true;

    window.addEventListener('online', () => {
      this.online = true;
      void this.flush();
    });
    window.addEventListener('offline', () => { this.online = false; });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.flush();
    });
    // Filet de securite si l'evenement `online` ment (portail captif, wifi ouvert
    // mais sans route) : une nouvelle tentative reguliere, sans bruit.
    setInterval(() => void this.flush(), 60_000);

    try {
      await api.check();
      this.authed = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Hors ligne au demarrage : on garde les donnees locales et on considere
        // la session valide jusqu'a preuve du contraire.
        this.authed = false;
        return;
      }
      this.authed = this.exercises.length > 0;
      return;
    }

    // Vider la file d'abord, recharger ensuite : `flush` sort immediatement
    // quand il n'y a rien a envoyer, il ne peut donc pas servir de chargement
    // initial.
    await this.flush();
    if (this.pending === 0) await this.refresh().catch(() => undefined);
  }

  private async loadLocal(): Promise<void> {
    const [exercises, routineDays, routineExercises, mealTemplates, sessions, sets,
      bodyweights, foodLogs, settings, muscles, exerciseMuscles, equipment, records,
      exerciseNotes, alternatives, swaps] =
      await Promise.all([
        idb.get<Exercise[]>('exercises'),
        idb.get<RoutineDay[]>('routineDays'),
        idb.get<RoutineExercise[]>('routineExercises'),
        idb.get<MealTemplate[]>('mealTemplates'),
        idb.get<Session[]>('sessions'),
        idb.get<SetEntry[]>('sets'),
        idb.get<Bodyweight[]>('bodyweights'),
        idb.get<FoodLog[]>('foodLogs'),
        idb.get<Settings>('settings'),
        idb.get<Muscle[]>('muscles'),
        idb.get<ExerciseMuscle[]>('exerciseMuscles'),
        idb.get<EquipmentItem[]>('equipment'),
        idb.get<PersonalRecord[]>('records'),
        idb.get<ExerciseNote[]>('exerciseNotes'),
        idb.get<ExerciseAlternative[]>('alternatives'),
        idb.get<SessionSwap[]>('swaps'),
      ]);

    this.exercises = exercises ?? [];
    this.routineDays = routineDays ?? [];
    this.routineExercises = routineExercises ?? [];
    this.mealTemplates = mealTemplates ?? [];
    this.sessions = sessions ?? [];
    this.sets = sets ?? [];
    this.bodyweights = bodyweights ?? [];
    this.foodLogs = foodLogs ?? [];
    // Une base locale ecrite par la v1 n'a pas les reglages v2.
    this.settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    this.muscles = muscles ?? [];
    this.exerciseMuscles = exerciseMuscles ?? [];
    this.equipment = equipment ?? [];
    this.records = records ?? [];
    this.exerciseNotes = exerciseNotes ?? [];
    this.alternatives = alternatives ?? [];
    this.swaps = swaps ?? [];
  }

  async signIn(token: string): Promise<void> {
    await api.login(token);
    this.authed = true;
    await this.refresh();
  }

  async signOut(): Promise<void> {
    await api.logout().catch(() => undefined);
    await idb.clearAll();
    location.reload();
  }

  // --- Synchronisation (section 3.4) ---------------------------------------

  /**
   * Recharge l'etat depuis le serveur. Uniquement quand la file est vide :
   * ecraser l'etat local alors que des ecritures sont en attente ferait
   * disparaitre de l'ecran des series deja loggees.
   */
  async refresh(): Promise<void> {
    if ((await idb.pendingCount()) > 0) return;

    const data: Bootstrap = await api.bootstrap();
    this.exercises = data.exercises;
    this.routineDays = data.routineDays;
    this.routineExercises = data.routineExercises;
    this.mealTemplates = data.mealTemplates;
    this.sessions = data.sessions;
    this.sets = data.sets;
    this.bodyweights = data.bodyweights;
    this.foodLogs = data.foodLogs;
    this.settings = data.settings;
    this.muscles = data.muscles;
    this.exerciseMuscles = data.exerciseMuscles;
    this.equipment = data.equipment;
    this.records = data.records;
    this.exerciseNotes = data.exerciseNotes;
    this.alternatives = data.alternatives;
    this.swaps = data.swaps;

    await idb.putMany({
      exercises: data.exercises,
      routineDays: data.routineDays,
      routineExercises: data.routineExercises,
      mealTemplates: data.mealTemplates,
      sessions: data.sessions,
      sets: data.sets,
      bodyweights: data.bodyweights,
      foodLogs: data.foodLogs,
      settings: data.settings,
      muscles: data.muscles,
      exerciseMuscles: data.exerciseMuscles,
      equipment: data.equipment,
      records: data.records,
      exerciseNotes: data.exerciseNotes,
      alternatives: data.alternatives,
      swaps: data.swaps,
    });
  }

  /** Vide la file vers le serveur. Silencieuse : jamais de modale, jamais de blocage. */
  async flush(): Promise<void> {
    if (this.syncing || !this.online || !this.authed) return;

    const rows = await idb.pending();
    if (rows.length === 0) {
      this.pending = 0;
      return;
    }

    this.syncing = true;
    try {
      const ops = rows.map((r) => ({ opId: r.opId, type: r.type, payload: r.payload })) as SyncOp[];
      const result = await api.sync(ops);

      // Une operation refusee par le serveur ne le sera pas davantage au
      // prochain essai : on la retire de la file et on le signale.
      const settled = [...result.applied, ...result.failed.map((f) => f.opId)];
      await idb.dequeue(settled);
      this.pending = await idb.pendingCount();
      this.syncError = result.failed.length > 0
        ? `${result.failed.length} écriture(s) refusée(s) par le serveur`
        : null;

      if (this.pending === 0) await this.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) this.authed = false;
      // Reseau absent : on garde tout en file, sans rien dire de plus que le
      // compteur d'attente deja visible.
    } finally {
      this.syncing = false;
    }
  }

  private async queue(type: SyncOp['type'], payload: unknown, persist: Record<string, unknown>): Promise<void> {
    await idb.putMany(persist);
    await idb.enqueue({ opId: uuid(), seq: this.seq++, type, payload, queuedAt: Date.now() });
    this.pending = await idb.pendingCount();
    void this.flush();
  }

  private snapshotSets() { return { sets: $state.snapshot(this.sets) }; }
  private snapshotSessions() { return { sessions: $state.snapshot(this.sessions) }; }

  // --- Seances -------------------------------------------------------------

  startSession(routineDayId: number): Session {
    const session: Session = {
      id: uuid(),
      routine_day_id: routineDayId,
      started_at: new Date().toISOString(),
      ended_at: null,
      note: null,
    };
    this.sessions = [session, ...this.sessions];
    void this.queue('session.create', { ...session }, this.snapshotSessions());
    return session;
  }

  endSession(id: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session || session.ended_at) return;
    session.ended_at = new Date().toISOString();
    void this.queue('session.update', { id, ended_at: session.ended_at }, this.snapshotSessions());
  }

  annotateSession(id: string, note: string): void {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    session.note = note;
    void this.queue('session.update', { id, note }, this.snapshotSessions());
  }

  // --- Series --------------------------------------------------------------

  logSet(input: {
    sessionId: string; exerciseId: number; setIndex: number;
    weightKg: number; reps: number; kind?: SetKind; rpe?: number | null;
  }): { entry: SetEntry; records: DetectedRecord[] } {
    const entry: SetEntry = {
      id: uuid(),
      session_id: input.sessionId,
      exercise_id: input.exerciseId,
      set_index: input.setIndex,
      weight_kg: input.weightKg,
      reps: input.reps,
      done_at: new Date().toISOString(),
      kind: input.kind ?? 'work',
      rpe: input.rpe ?? null,
    };
    this.sets = [...this.sets, entry];

    // Detection en direct contre l'instantane du serveur : le client n'a que
    // 90 jours en memoire et annoncerait sinon des records contre un passe
    // qu'il ne voit pas.
    const sessionSets = this.setsOfExercise(input.sessionId, input.exerciseId);
    const records = detectRecords(entry, sessionSets, this.recordSnapshot, this.resolveLoad);

    // L'instantane local avance aussi, pour ne pas re-annoncer le meme record
    // a la serie suivante avant la prochaine synchronisation.
    for (const record of records) {
      const existing = this.records.find((r) => r.exercise_id === entry.exercise_id && r.kind === record.kind);
      if (existing) existing.value = record.value;
      else this.records = [...this.records, {
        exercise_id: entry.exercise_id, kind: record.kind, value: record.value, achieved_at: entry.done_at,
      }];
    }

    void this.queue('set.create', { ...entry }, {
      ...this.snapshotSets(),
      records: $state.snapshot(this.records),
    });
    return { entry, records };
  }

  editSet(id: string, patch: { weight_kg?: number; reps?: number; kind?: SetKind; rpe?: number | null }): void {
    const entry = this.sets.find((s) => s.id === id);
    if (!entry) return;
    if (patch.weight_kg !== undefined) entry.weight_kg = patch.weight_kg;
    if (patch.reps !== undefined) entry.reps = patch.reps;
    if (patch.kind !== undefined) entry.kind = patch.kind;
    if (patch.rpe !== undefined) entry.rpe = patch.rpe;
    void this.queue('set.update', { id, ...patch }, this.snapshotSets());
  }

  removeSet(id: string): void {
    this.sets = this.sets.filter((s) => s.id !== id);
    void this.queue('set.delete', { id }, this.snapshotSets());
  }

  /** Note sur un exercice pour la seance en cours. Passe par la file hors ligne. */
  setExerciseNote(exerciseId: number, sessionId: string, note: string): void {
    const trimmed = note.trim();
    const existing = this.exerciseNotes.find((n) => n.exercise_id === exerciseId && n.session_id === sessionId);

    if (!trimmed) {
      this.exerciseNotes = this.exerciseNotes.filter((n) => n !== existing);
    } else if (existing) {
      existing.note = trimmed;
      existing.updated_at = new Date().toISOString();
    } else {
      this.exerciseNotes = [...this.exerciseNotes, {
        exercise_id: exerciseId, session_id: sessionId, note: trimmed, updated_at: new Date().toISOString(),
      }];
    }

    void this.queue(
      'note.upsert',
      { exercise_id: exerciseId, session_id: sessionId, note: trimmed },
      { exerciseNotes: $state.snapshot(this.exerciseNotes) },
    );
  }

  // --- Poids corporel ------------------------------------------------------

  setBodyweight(date: string, weightKg: number): void {
    const existing = this.bodyweights.find((b) => b.measured_on === date);
    if (existing) existing.weight_kg = weightKg;
    else this.bodyweights = [...this.bodyweights, { measured_on: date, weight_kg: weightKg }]
      .sort((a, b) => a.measured_on.localeCompare(b.measured_on));

    void this.queue(
      'bodyweight.upsert',
      { measured_on: date, weight_kg: weightKg },
      { bodyweights: $state.snapshot(this.bodyweights) },
    );
  }

  // --- Nutrition -----------------------------------------------------------

  logFood(input: { label: string; kcal: number; protein_g: number; templateId?: number | null; date?: string }): FoodLog {
    const entry: FoodLog = {
      id: uuid(),
      logged_on: input.date ?? todayKey(),
      label: input.label,
      kcal: input.kcal,
      protein_g: input.protein_g,
      template_id: input.templateId ?? null,
    };
    this.foodLogs = [...this.foodLogs, entry];
    void this.queue('food.create', { ...entry }, { foodLogs: $state.snapshot(this.foodLogs) });
    return entry;
  }

  removeFood(id: string): void {
    this.foodLogs = this.foodLogs.filter((f) => f.id !== id);
    void this.queue('food.delete', { id }, { foodLogs: $state.snapshot(this.foodLogs) });
  }

  // --- Reglages et programme -----------------------------------------------
  // Ces ecrans se consultent au calme, a la maison : ils passent directement
  // par l'API plutot que par la file hors ligne.

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await idb.put('settings', $state.snapshot(this.settings));
    await api.saveSettings(patch as Record<string, number>);
  }

  async saveMealTemplates(templates: { name: string; kcal: number; protein_g: number }[]): Promise<void> {
    this.mealTemplates = (await api.saveMealTemplates(templates)) as MealTemplate[];
    await idb.put('mealTemplates', $state.snapshot(this.mealTemplates));
  }

  async saveRoutine(
    dayId: number,
    slots: {
      exercise_id: number; target_sets: number; rep_min: number;
      rep_max: number; rest_seconds: number; superset_group?: number | null;
    }[],
  ): Promise<void> {
    const saved = (await api.saveRoutineExercises(dayId, slots)) as RoutineExercise[];
    this.routineExercises = [...this.routineExercises.filter((r) => r.routine_day_id !== dayId), ...saved];
    await idb.put('routineExercises', $state.snapshot(this.routineExercises));
  }

  async updateExercise(id: number, patch: Partial<Exercise>): Promise<void> {
    const updated = (await api.updateExercise(id, patch)) as Exercise;
    this.exercises = this.exercises.map((e) => (e.id === id ? updated : e));
    await idb.put('exercises', $state.snapshot(this.exercises));
  }

  async saveEquipment(items: EquipmentItem[]): Promise<void> {
    this.equipment = (await api.saveEquipment(items)) as EquipmentItem[];
    await idb.put('equipment', $state.snapshot(this.equipment));
  }

  async saveAlternatives(exerciseId: number, ids: number[]): Promise<void> {
    await api.saveAlternatives(exerciseId, ids);
    // Le serveur reecrit les deux sens : on relit plutot que de deviner.
    await this.refresh();
  }

  async saveExerciseMuscles(exerciseId: number, rows: { muscle_id: string; share: number }[]): Promise<void> {
    const saved = (await api.saveExerciseMuscles(exerciseId, rows)) as ExerciseMuscle[];
    this.exerciseMuscles = [...this.exerciseMuscles.filter((m) => m.exercise_id !== exerciseId), ...saved];
    await idb.put('exerciseMuscles', $state.snapshot(this.exerciseMuscles));
  }

  async renameDay(id: number, name: string): Promise<void> {
    await api.renameRoutineDay(id, name);
    const day = this.routineDays.find((d) => d.id === id);
    if (day) day.name = name;
    await idb.put('routineDays', $state.snapshot(this.routineDays));
  }

  async addExercise(input: {
    name: string; muscle_group: string; increment_kg: number;
    is_bodyweight: number; equipment: Exercise['equipment']; unilateral?: number;
  }): Promise<Exercise> {
    const created = (await api.createExercise(input)) as Exercise;
    this.exercises = [...this.exercises, created].sort(
      (a, b) => a.muscle_group.localeCompare(b.muscle_group) || a.name.localeCompare(b.name),
    );
    await idb.put('exercises', $state.snapshot(this.exercises));
    return created;
  }

  /** Elague les donnees hors fenetre, pour que le stockage local ne derive pas. */
  async prune(): Promise<void> {
    const cutoff = olderThan(HISTORY_DAYS);
    const foodCutoff = olderThan(FOOD_DAYS).slice(0, 10);
    const keep = new Set(this.sessions.filter((s) => s.started_at >= cutoff).map((s) => s.id));

    this.sessions = this.sessions.filter((s) => keep.has(s.id));
    this.sets = this.sets.filter((s) => keep.has(s.session_id));
    this.foodLogs = this.foodLogs.filter((f) => f.logged_on >= foodCutoff);

    await idb.putMany({
      sessions: $state.snapshot(this.sessions),
      sets: $state.snapshot(this.sets),
      foodLogs: $state.snapshot(this.foodLogs),
    });
  }
}

export const store = new AppStore();
