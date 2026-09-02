// Types partages entre le serveur et le client. Aucune dependance runtime.

/** Materiel utilise : determine comment une charge est arrondie et chargee. */
export type Equipment = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight';

export interface Exercise {
  id: number;
  name: string;
  muscle_group: string;
  increment_kg: number;
  is_bodyweight: number;
  archived_at: string | null;
  equipment: Equipment;
  /** Poids de la barre. null : on retombe sur le defaut de l'equipement. */
  bar_kg: number | null;
  /**
   * Part du poids de corps reellement soulevee : 1,0 en traction, ~0,65 en
   * pompes. null pour un exercice a charge externe.
   */
  bodyweight_factor: number | null;
  /** 1 quand un seul cote travaille a la fois : le tonnage compte double. */
  unilateral: number;
  /** Cle du schema du mouvement. Le dessin vit dans le client. */
  diagram: string | null;
}

/** Exercice de remplacement, quand le materiel prevu est pris. */
export interface ExerciseAlternative {
  exercise_id: number;
  alternative_id: number;
  position: number;
}

/** Ce qui a reellement ete fait a la place de ce qui etait prevu. */
export interface SessionSwap {
  session_id: string;
  planned_id: number;
  actual_id: number;
}

/** Une note attachee a un exercice pour une seance donnee. */
export interface ExerciseNote {
  exercise_id: number;
  session_id: string;
  note: string;
  updated_at: string;
}

export interface RoutineDay {
  id: number;
  name: string;
  position: number;
}

export interface RoutineExercise {
  id: number;
  routine_day_id: number;
  exercise_id: number;
  position: number;
  target_sets: number;
  rep_min: number;
  rep_max: number;
  rest_seconds: number;
  /** Exercices d'un meme groupe enchaines en superset. null : exercice seul. */
  superset_group: number | null;
}

export interface Session {
  id: string;
  routine_day_id: number;
  started_at: string;
  ended_at: string | null;
  note: string | null;
}

/**
 * Nature d'une serie. Seules les series `work`, `failure`, `drop` et `amrap`
 * comptent comme du volume de travail : un echauffement fausserait toute
 * statistique construite dessus.
 */
export type SetKind = 'warmup' | 'work' | 'failure' | 'drop' | 'amrap';

export const WORKING_KINDS: readonly SetKind[] = ['work', 'failure', 'drop', 'amrap'];

export const isWorkingSet = (set: Pick<SetEntry, 'kind'>): boolean => set.kind !== 'warmup';

export interface SetEntry {
  id: string;
  session_id: string;
  exercise_id: number;
  set_index: number;
  weight_kg: number;
  reps: number;
  done_at: string;
  kind: SetKind;
  /** Effort percu, 6 a 10 par pas de 0,5. null quand la saisie est desactivee. */
  rpe: number | null;
}

/** Reperes de volume hebdomadaire, en sets fractionnes (Renaissance Periodization). */
export interface Muscle {
  id: string;
  name: string;
  mev: number;
  mav_low: number;
  mav_high: number;
  mrv: number;
  position: number;
}

/**
 * Part d'un exercice attribuee a un muscle : 1,0 pour le muscle moteur, 0,5
 * pour un synergiste. C'est le comptage fractionne, celui qui predit le mieux
 * l'hypertrophie dans la litterature.
 */
export interface ExerciseMuscle {
  exercise_id: number;
  muscle_id: string;
  share: number;
}

/** Inventaire reel de la salle : ce qu'on peut effectivement charger. */
export interface EquipmentItem {
  kind: 'plate' | 'dumbbell';
  weight_kg: number;
  /** Nombre de paires disponibles pour les disques. */
  count: number;
}

export type RecordKind = 'weight' | 'e1rm' | 'set_volume' | 'session_volume';

export interface PersonalRecord {
  exercise_id: number;
  kind: RecordKind;
  value: number;
  achieved_at: string;
}

export interface Bodyweight {
  measured_on: string;
  weight_kg: number;
}

export interface MealTemplate {
  id: number;
  name: string;
  kcal: number;
  protein_g: number;
  position: number;
}

export interface FoodLog {
  id: string;
  logged_on: string;
  label: string;
  kcal: number;
  protein_g: number;
  template_id: number | null;
}

export interface Settings {
  kcal_target: number;
  protein_target_g: number;
  weekly_gain_target_kg: number;
  /** 0 ou 1. Stockes en nombres : la table `setting` ne connait que des nombres. */
  rpe_enabled: number;
  warmup_enabled: number;
  /** Allegement propose apres stagnation, en pourcentage de la charge. */
  deload_percent: number;
}

export interface Bootstrap {
  exercises: Exercise[];
  routineDays: RoutineDay[];
  routineExercises: RoutineExercise[];
  mealTemplates: MealTemplate[];
  sessions: Session[];
  sets: SetEntry[];
  bodyweights: Bodyweight[];
  foodLogs: FoodLog[];
  settings: Settings;
  muscles: Muscle[];
  exerciseMuscles: ExerciseMuscle[];
  equipment: EquipmentItem[];
  exerciseNotes: ExerciseNote[];
  alternatives: ExerciseAlternative[];
  swaps: SessionSwap[];
  /**
   * Meilleures performances de TOUTE l'histoire, par exercice et par type.
   * Le client n'a que 90 jours en memoire : sans cet instantane il annoncerait
   * un record contre un passe qu'il ne voit pas.
   */
  records: PersonalRecord[];
  serverTime: string;
}

// --- File de synchronisation ---

/**
 * Types d'operations, en un seul endroit.
 *
 * La validation JSON du serveur lit cette liste : elle a deja diverge deux fois
 * de la realite, laissant des ecritures partir en ligne pour etre refusees en
 * silence au retour du reseau. `SyncOpType` et l'union `SyncOp` sont verifies
 * l'un contre l'autre plus bas — en ajouter un ici sans le traiter ne compile
 * pas.
 */
export const SYNC_OP_TYPES = [
  'session.create', 'session.update',
  'set.create', 'set.update', 'set.delete',
  'bodyweight.upsert',
  'food.create', 'food.delete',
  'note.upsert',
  'swap.set', 'swap.clear',
] as const;

export type SyncOpType = (typeof SYNC_OP_TYPES)[number];

export type SyncOp =
  | { opId: string; type: 'session.create'; payload: Session }
  | { opId: string; type: 'session.update'; payload: { id: string; ended_at?: string | null; note?: string | null } }
  | { opId: string; type: 'set.create'; payload: SetEntry }
  | { opId: string; type: 'set.update'; payload: { id: string; weight_kg?: number; reps?: number; set_index?: number; kind?: SetKind; rpe?: number | null } }
  | { opId: string; type: 'set.delete'; payload: { id: string } }
  | { opId: string; type: 'bodyweight.upsert'; payload: Bodyweight }
  | { opId: string; type: 'food.create'; payload: FoodLog }
  | { opId: string; type: 'food.delete'; payload: { id: string } }
  | { opId: string; type: 'note.upsert'; payload: { exercise_id: number; session_id: string; note: string } }
  | { opId: string; type: 'swap.set'; payload: { session_id: string; planned_id: number; actual_id: number } }
  | { opId: string; type: 'swap.clear'; payload: { session_id: string; planned_id: number } };

/** Verifie que la liste et l'union decrivent exactement les memes operations. */
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _syncOpsAgree: AssertSame<SyncOp['type'], SyncOpType> = true;
void _syncOpsAgree;

export interface SyncResult {
  applied: string[];
  failed: { opId: string; error: string }[];
}
