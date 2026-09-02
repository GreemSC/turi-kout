import { db, isFreshDatabase } from './db.ts';
import type { Equipment } from '../../shared/types.ts';

// Section 9 : programme haut/bas en quatre journees.
// increment_kg : 2,5 kg haut du corps, 5 kg bas du corps.
// rest_seconds : 120 s sur les exercices a 6-8 repetitions, 90 s sur les autres.

const EXERCISES: [name: string, group: string, increment: number, bodyweight?: 1][] = [
  ['Développé couché', 'Pectoraux', 2.5],
  ['Rowing barre', 'Dos', 2.5],
  ['Développé militaire', 'Épaules', 2.5],
  ['Tirage vertical', 'Dos', 2.5],
  ['Élévations latérales', 'Épaules', 2.5],
  ['Curl biceps', 'Biceps', 2.5],
  ['Squat', 'Quadriceps', 5],
  ['Soulevé de terre roumain', 'Ischios', 5],
  ['Presse à cuisses', 'Quadriceps', 5],
  ['Leg curl', 'Ischios', 5],
  ['Mollets', 'Mollets', 5],
  ['Développé incliné haltères', 'Pectoraux', 2.5],
  ['Tractions', 'Dos', 2.5, 1],
  ['Dips', 'Pectoraux', 2.5, 1],
  ['Rowing haltère', 'Dos', 2.5],
  ['Curl marteau', 'Biceps', 2.5],
  ['Soulevé de terre', 'Dos', 5],
  ['Fentes', 'Quadriceps', 5],
  ['Leg extension', 'Quadriceps', 5],
];

type Slot = [exercise: string, sets: number, repMin: number, repMax: number];

const PROGRAM: [day: string, slots: Slot[]][] = [
  ['Haut A', [
    ['Développé couché', 4, 6, 8],
    ['Rowing barre', 4, 8, 8],
    ['Développé militaire', 3, 10, 10],
    ['Tirage vertical', 3, 10, 10],
    ['Élévations latérales', 3, 12, 12],
    ['Curl biceps', 3, 12, 12],
  ]],
  ['Bas A', [
    ['Squat', 4, 6, 8],
    ['Soulevé de terre roumain', 3, 8, 8],
    ['Presse à cuisses', 3, 12, 12],
    ['Leg curl', 3, 12, 12],
    ['Mollets', 3, 15, 15],
  ]],
  ['Haut B', [
    ['Développé incliné haltères', 4, 8, 8],
    ['Tractions', 4, 8, 8],
    ['Dips', 3, 10, 10],
    ['Rowing haltère', 3, 10, 10],
    ['Élévations latérales', 3, 15, 15],
    ['Curl marteau', 3, 12, 12],
  ]],
  ['Bas B', [
    ['Soulevé de terre', 3, 5, 5],
    ['Fentes', 3, 10, 10],
    ['Presse à cuisses', 3, 12, 12],
    ['Leg extension', 3, 15, 15],
    ['Mollets', 3, 15, 15],
  ]],
];

const DEFAULT_SETTINGS: [string, string][] = [
  ['kcal_target', '3000'],
  ['protein_target_g', '160'],
  ['weekly_gain_target_kg', '0.25'],
];

/** Un exercice ecrit "6-8" merite 120 s de repos, les autres 90 s. */
function restSeconds(repMin: number, repMax: number): number {
  return repMin !== repMax ? 120 : 90;
}

export function seed(): void {
  // Garde-fou : le seed ne doit jamais s'ajouter a une base deja peuplee.
  const existing = db.prepare('SELECT COUNT(*) n FROM exercise').get() as { n: number };
  if (existing.n > 0) return;

  const insertExercise = db.prepare(
    'INSERT INTO exercise (name, muscle_group, increment_kg, is_bodyweight) VALUES (?, ?, ?, ?)',
  );
  const insertDay = db.prepare('INSERT INTO routine_day (name, position) VALUES (?, ?)');
  const insertSlot = db.prepare(`
    INSERT INTO routine_exercise
      (routine_day_id, exercise_id, position, target_sets, rep_min, rep_max, rest_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSetting = db.prepare('INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)');

  db.transaction(() => {
    const ids = new Map<string, number>();
    for (const [name, group, increment, bodyweight] of EXERCISES) {
      const info = insertExercise.run(name, group, increment, bodyweight ?? 0);
      ids.set(name, Number(info.lastInsertRowid));
    }

    PROGRAM.forEach(([dayName, slots], dayIndex) => {
      const dayId = Number(insertDay.run(dayName, dayIndex + 1).lastInsertRowid);
      slots.forEach(([exercise, sets, repMin, repMax], slotIndex) => {
        insertSlot.run(dayId, ids.get(exercise)!, slotIndex + 1, sets, repMin, repMax, restSeconds(repMin, repMax));
      });
    });

    for (const [key, value] of DEFAULT_SETTINGS) insertSetting.run(key, value);
  })();
}

/**
 * Joue le seed sur une base neuve, et dans tous les cas complete les donnees
 * v2 — c'est ce qui donne un equipement et des muscles aux exercices d'une base
 * v1 migree.
 */
export function seedIfFresh(): void {
  if (isFreshDatabase) seed();
  seedTrainingData();
  seedAlternatives();
}

// --- Donnees v2 : mesure de l'entrainement ---------------------------------
//
// Ce bloc est idempotent et s'applique aussi bien a une base neuve qu'a une
// base v1 migree : c'est lui qui donne un equipement et une cartographie
// musculaire aux exercices qui existaient deja.

/** Reperes de volume hebdomadaire, en sets fractionnes (Renaissance Periodization). */
const MUSCLES: [id: string, name: string, mev: number, mavLow: number, mavHigh: number, mrv: number][] = [
  ['chest', 'Pectoraux', 8, 12, 20, 22],
  ['back_width', 'Dos (largeur)', 8, 12, 20, 25],
  ['back_thickness', 'Dos (épaisseur)', 6, 10, 16, 20],
  ['traps', 'Trapèzes', 4, 6, 12, 16],
  ['front_delts', 'Épaules (antérieures)', 0, 0, 6, 12],
  ['side_delts', 'Épaules (latérales)', 6, 12, 20, 25],
  ['biceps', 'Biceps', 6, 10, 16, 20],
  ['triceps', 'Triceps', 4, 8, 14, 18],
  ['quads', 'Quadriceps', 6, 10, 18, 20],
  ['hamstrings', 'Ischios', 4, 8, 14, 16],
  ['glutes', 'Fessiers', 4, 8, 16, 20],
  ['calves', 'Mollets', 6, 10, 16, 20],
];

/**
 * Materiel et cartographie musculaire des exercices du programme initial.
 * La part vaut 1,0 pour le muscle moteur et 0,5 pour un synergiste : c'est le
 * comptage fractionne, celui qui predit le mieux l'hypertrophie.
 */
interface Profile {
  equipment: Equipment;
  muscles: [string, number][];
  /** Part du poids de corps soulevee : 1,0 en traction, ~0,65 en pompes. */
  bodyweight?: number;
  /** Un cote a la fois : les repetitions sont par membre. */
  unilateral?: true;
}

const EXERCISE_PROFILE: Record<string, Profile> = {
  'Développé couché': { equipment: 'barbell', muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },
  'Rowing barre': { equipment: 'barbell', muscles: [['back_thickness', 1], ['back_width', 0.5], ['biceps', 0.5], ['side_delts', 0.5]] },
  'Développé militaire': { equipment: 'barbell', muscles: [['front_delts', 1], ['side_delts', 0.5], ['triceps', 0.5]] },
  'Tirage vertical': { equipment: 'cable', muscles: [['back_width', 1], ['biceps', 0.5]] },
  'Élévations latérales': { equipment: 'dumbbell', muscles: [['side_delts', 1]] },
  'Curl biceps': { equipment: 'barbell', muscles: [['biceps', 1]] },
  'Squat': { equipment: 'barbell', muscles: [['quads', 1], ['glutes', 0.5]] },
  'Soulevé de terre roumain': { equipment: 'barbell', muscles: [['hamstrings', 1], ['glutes', 0.5], ['back_thickness', 0.5]] },
  'Presse à cuisses': { equipment: 'machine', muscles: [['quads', 1], ['glutes', 0.5]] },
  'Leg curl': { equipment: 'machine', muscles: [['hamstrings', 1]] },
  'Mollets': { equipment: 'machine', muscles: [['calves', 1]] },
  'Développé incliné haltères': { equipment: 'dumbbell', muscles: [['chest', 1], ['front_delts', 0.5], ['triceps', 0.5]] },
  'Tractions': { equipment: 'bodyweight', bodyweight: 1, muscles: [['back_width', 1], ['biceps', 0.5]] },
  'Dips': { equipment: 'bodyweight', bodyweight: 1, muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },
  'Rowing haltère': { equipment: 'dumbbell', unilateral: true, muscles: [['back_thickness', 1], ['back_width', 0.5], ['biceps', 0.5]] },
  'Curl marteau': { equipment: 'dumbbell', muscles: [['biceps', 1]] },
  'Soulevé de terre': { equipment: 'barbell', muscles: [['back_thickness', 1], ['hamstrings', 0.5], ['glutes', 0.5], ['traps', 0.5], ['quads', 0.5]] },
  'Fentes': { equipment: 'dumbbell', unilateral: true, muscles: [['quads', 1], ['glutes', 0.5]] },
  'Leg extension': { equipment: 'machine', muscles: [['quads', 1]] },
};

/** Inventaire par defaut d'une salle ordinaire. Modifiable dans Reglages. */
const PLATES: [weightKg: number, pairs: number][] = [[20, 4], [15, 2], [10, 2], [5, 2], [2.5, 2], [1.25, 2]];
const DUMBBELLS = Array.from({ length: 20 }, (_, i) => (i + 1) * 2); // 2 a 40 kg par pas de 2

const V2_SETTINGS: [string, string][] = [
  ['rpe_enabled', '0'],
  ['warmup_enabled', '1'],
  ['deload_percent', '10'],
];

/**
 * Complete une base — neuve ou migree depuis la v1 — avec les donnees de la v2.
 * Idempotent : rejouable sans effet sur ce qui est deja en place.
 */
export function seedTrainingData(): void {
  const insertMuscle = db.prepare(`
    INSERT INTO muscle (id, name, mev, mav_low, mav_high, mrv, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertMapping = db.prepare(`
    INSERT INTO exercise_muscle (exercise_id, muscle_id, share) VALUES (?, ?, ?)
    ON CONFLICT(exercise_id, muscle_id) DO NOTHING
  `);
  const setProfile = db.prepare(`
    UPDATE exercise
       SET equipment = ?, bar_kg = ?, bodyweight_factor = ?, unilateral = ?
     WHERE name = ?
  `);
  const insertItem = db.prepare(`
    INSERT INTO equipment_item (kind, weight_kg, count) VALUES (?, ?, ?)
    ON CONFLICT(kind, weight_kg) DO NOTHING
  `);
  const insertSetting = db.prepare('INSERT OR IGNORE INTO setting (key, value) VALUES (?, ?)');
  const findExercise = db.prepare('SELECT id FROM exercise WHERE name = ?');
  const hasMapping = db.prepare('SELECT 1 FROM exercise_muscle WHERE exercise_id = ? LIMIT 1');

  db.transaction(() => {
    MUSCLES.forEach(([id, name, mev, mavLow, mavHigh, mrv], index) => {
      insertMuscle.run(id, name, mev, mavLow, mavHigh, mrv, index + 1);
    });

    for (const [name, profile] of Object.entries(EXERCISE_PROFILE)) {
      const row = findExercise.get(name) as { id: number } | undefined;
      if (!row) continue;

      setProfile.run(
        profile.equipment,
        profile.equipment === 'barbell' ? 20 : null,
        profile.bodyweight ?? null,
        profile.unilateral ? 1 : 0,
        name,
      );

      // Une cartographie deja saisie par l'utilisateur ne doit pas etre ecrasee.
      if (hasMapping.get(row.id)) continue;
      for (const [muscleId, share] of profile.muscles) insertMapping.run(row.id, muscleId, share);
    }

    for (const [weight, pairs] of PLATES) insertItem.run('plate', weight, pairs);
    for (const weight of DUMBBELLS) insertItem.run('dumbbell', weight, 1);

    for (const [key, value] of V2_SETTINGS) insertSetting.run(key, value);
  })();
}

// --- Donnees v5 : alternatives et schemas ----------------------------------
//
// Le catalogue s'etend au materiel qu'on trouve dans un club Basic-Fit, pour
// qu'une machine prise n'arrete pas la seance. Les configurations varient d'un
// club a l'autre : tout ceci reste modifiable dans Programme.

/** Schema du mouvement pour les exercices deja presents. */
const DIAGRAMS: Record<string, string> = {
  'Développé couché': 'bench-barbell',
  'Rowing barre': 'row-barbell',
  'Développé militaire': 'ohp-barbell',
  'Tirage vertical': 'lat-pulldown',
  'Élévations latérales': 'lateral-raise',
  'Curl biceps': 'curl-barbell',
  'Squat': 'squat-barbell',
  'Soulevé de terre roumain': 'rdl-barbell',
  'Presse à cuisses': 'leg-press',
  'Leg curl': 'leg-curl-lying',
  'Mollets': 'calf-standing',
  'Développé incliné haltères': 'incline-dumbbell',
  'Tractions': 'pullup',
  'Dips': 'dips',
  'Rowing haltère': 'row-dumbbell',
  'Curl marteau': 'curl-dumbbell',
  'Soulevé de terre': 'deadlift',
  'Fentes': 'lunge',
  'Leg extension': 'leg-extension',
};

interface NewExercise {
  name: string;
  group: string;
  equipment: Equipment;
  increment: number;
  diagram: string;
  muscles: [string, number][];
  barKg?: number;
  bodyweight?: number;
  unilateral?: true;
}

const BASIC_FIT_EXERCISES: NewExercise[] = [
  // Pectoraux
  { name: 'Développé couché machine', group: 'Pectoraux', equipment: 'machine', increment: 5, diagram: 'chest-press-machine',
    muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },
  { name: 'Développé couché à la Smith', group: 'Pectoraux', equipment: 'barbell', increment: 2.5, barKg: 15, diagram: 'bench-smith',
    muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },
  { name: 'Écarté à la poulie vis-à-vis', group: 'Pectoraux', equipment: 'cable', increment: 2.5, diagram: 'cable-fly',
    muscles: [['chest', 1], ['front_delts', 0.5]] },
  { name: 'Pec deck', group: 'Pectoraux', equipment: 'machine', increment: 5, diagram: 'pec-deck',
    muscles: [['chest', 1], ['front_delts', 0.5]] },
  { name: 'Pompes', group: 'Pectoraux', equipment: 'bodyweight', increment: 2.5, bodyweight: 0.65, diagram: 'pushup',
    muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },
  { name: 'Dips assistés', group: 'Pectoraux', equipment: 'machine', increment: 5, diagram: 'dips-machine',
    muscles: [['chest', 1], ['triceps', 0.5], ['front_delts', 0.5]] },

  // Dos
  { name: 'Tirage horizontal machine', group: 'Dos', equipment: 'machine', increment: 5, diagram: 'seated-row-machine',
    muscles: [['back_thickness', 1], ['back_width', 0.5], ['biceps', 0.5]] },
  { name: 'Rowing à la poulie basse', group: 'Dos', equipment: 'cable', increment: 2.5, diagram: 'cable-row',
    muscles: [['back_thickness', 1], ['back_width', 0.5], ['biceps', 0.5]] },
  { name: 'Tractions assistées', group: 'Dos', equipment: 'machine', increment: 5, diagram: 'assisted-pullup',
    muscles: [['back_width', 1], ['biceps', 0.5]] },

  // Epaules
  { name: 'Développé épaules machine', group: 'Épaules', equipment: 'machine', increment: 5, diagram: 'shoulder-press-machine',
    muscles: [['front_delts', 1], ['side_delts', 0.5], ['triceps', 0.5]] },
  { name: 'Développé militaire haltères', group: 'Épaules', equipment: 'dumbbell', increment: 2, diagram: 'ohp-dumbbell',
    muscles: [['front_delts', 1], ['side_delts', 0.5], ['triceps', 0.5]] },
  { name: 'Élévations latérales à la poulie', group: 'Épaules', equipment: 'cable', increment: 2.5, unilateral: true, diagram: 'lateral-raise-cable',
    muscles: [['side_delts', 1]] },

  // Jambes
  { name: 'Hack squat', group: 'Quadriceps', equipment: 'machine', increment: 5, diagram: 'hack-squat',
    muscles: [['quads', 1], ['glutes', 0.5]] },
  { name: 'Squat à la Smith', group: 'Quadriceps', equipment: 'barbell', increment: 2.5, barKg: 15, diagram: 'squat-smith',
    muscles: [['quads', 1], ['glutes', 0.5]] },
  { name: 'Fentes bulgares', group: 'Quadriceps', equipment: 'dumbbell', increment: 2, unilateral: true, diagram: 'bulgarian-split',
    muscles: [['quads', 1], ['glutes', 0.5]] },
  { name: 'Soulevé de terre roumain haltères', group: 'Ischios', equipment: 'dumbbell', increment: 2, diagram: 'rdl-dumbbell',
    muscles: [['hamstrings', 1], ['glutes', 0.5], ['back_thickness', 0.5]] },
  { name: 'Leg curl assis', group: 'Ischios', equipment: 'machine', increment: 5, diagram: 'leg-curl-seated',
    muscles: [['hamstrings', 1]] },
  { name: 'Presse à mollets', group: 'Mollets', equipment: 'machine', increment: 5, diagram: 'calf-press',
    muscles: [['calves', 1]] },

  // Bras
  { name: 'Curl à la poulie basse', group: 'Biceps', equipment: 'cable', increment: 2.5, diagram: 'curl-cable',
    muscles: [['biceps', 1]] },
  { name: 'Curl machine', group: 'Biceps', equipment: 'machine', increment: 5, diagram: 'curl-machine',
    muscles: [['biceps', 1]] },
  { name: 'Curl barre EZ', group: 'Biceps', equipment: 'barbell', increment: 2.5, barKg: 10, diagram: 'curl-ez',
    muscles: [['biceps', 1]] },
  { name: 'Extension triceps à la poulie', group: 'Triceps', equipment: 'cable', increment: 2.5, diagram: 'triceps-pushdown',
    muscles: [['triceps', 1]] },
  { name: 'Barre au front', group: 'Triceps', equipment: 'barbell', increment: 2.5, barKg: 10, diagram: 'skullcrusher',
    muscles: [['triceps', 1]] },
];

/**
 * Groupes de substitution. Tout exercice d'un groupe peut remplacer les autres :
 * ils sollicitent le meme muscle sur le meme schema moteur. Un exercice peut
 * appartenir a plusieurs groupes — les dips remplacent aussi bien un mouvement
 * de pectoraux qu'un mouvement de triceps.
 */
const ALTERNATIVE_GROUPS: string[][] = [
  ['Développé couché', 'Développé couché machine', 'Développé couché à la Smith', 'Développé incliné haltères', 'Dips assistés', 'Pompes', 'Dips'],
  ['Écarté à la poulie vis-à-vis', 'Pec deck'],
  ['Rowing barre', 'Tirage horizontal machine', 'Rowing à la poulie basse', 'Rowing haltère'],
  ['Tirage vertical', 'Tractions assistées', 'Tractions'],
  ['Développé militaire', 'Développé épaules machine', 'Développé militaire haltères'],
  ['Élévations latérales', 'Élévations latérales à la poulie'],
  ['Squat', 'Hack squat', 'Presse à cuisses', 'Squat à la Smith'],
  ['Fentes', 'Fentes bulgares'],
  ['Soulevé de terre roumain', 'Soulevé de terre roumain haltères', 'Soulevé de terre'],
  ['Leg curl', 'Leg curl assis'],
  ['Mollets', 'Presse à mollets'],
  ['Curl biceps', 'Curl barre EZ', 'Curl à la poulie basse', 'Curl machine', 'Curl marteau'],
  ['Extension triceps à la poulie', 'Barre au front', 'Dips assistés', 'Dips'],
];

/** Complete le catalogue avec le materiel de salle et les remplacements. */
export function seedAlternatives(): void {
  const insertExercise = db.prepare(`
    INSERT INTO exercise (name, muscle_group, increment_kg, is_bodyweight, equipment, bar_kg, bodyweight_factor, unilateral, diagram)
    VALUES (@name, @group, @increment, @isBodyweight, @equipment, @barKg, @bodyweight, @unilateral, @diagram)
    ON CONFLICT(name) DO NOTHING
  `);
  const insertMapping = db.prepare(`
    INSERT INTO exercise_muscle (exercise_id, muscle_id, share) VALUES (?, ?, ?)
    ON CONFLICT(exercise_id, muscle_id) DO NOTHING
  `);
  const setDiagram = db.prepare('UPDATE exercise SET diagram = ? WHERE name = ? AND diagram IS NULL');
  const insertAlternative = db.prepare(`
    INSERT INTO exercise_alternative (exercise_id, alternative_id, position) VALUES (?, ?, ?)
    ON CONFLICT(exercise_id, alternative_id) DO NOTHING
  `);
  const findExercise = db.prepare('SELECT id FROM exercise WHERE name = ?');
  const hasMapping = db.prepare('SELECT 1 FROM exercise_muscle WHERE exercise_id = ? LIMIT 1');

  /**
   * Exercices dont les remplacants ont deja ete choisis. Releve AVANT toute
   * insertion : sans cela, un remplacant retire parce qu'il n'existe pas dans
   * la salle revenait a chaque redemarrage. Un exercice appartenant a deux
   * groupes doit aussi etre juge sur son etat d'origine, pas sur celui que le
   * premier groupe vient de lui donner.
   */
  const curated = new Set(
    (db.prepare('SELECT DISTINCT exercise_id FROM exercise_alternative').all() as { exercise_id: number }[])
      .map((r) => r.exercise_id),
  );

  db.transaction(() => {
    for (const [name, diagram] of Object.entries(DIAGRAMS)) setDiagram.run(diagram, name);

    for (const exercise of BASIC_FIT_EXERCISES) {
      insertExercise.run({
        name: exercise.name,
        group: exercise.group,
        increment: exercise.increment,
        isBodyweight: exercise.equipment === 'bodyweight' ? 1 : 0,
        equipment: exercise.equipment,
        barKg: exercise.equipment === 'barbell' ? (exercise.barKg ?? 20) : null,
        bodyweight: exercise.bodyweight ?? null,
        unilateral: exercise.unilateral ? 1 : 0,
        diagram: exercise.diagram,
      });

      const row = findExercise.get(exercise.name) as { id: number } | undefined;
      if (!row || hasMapping.get(row.id)) continue;
      for (const [muscleId, share] of exercise.muscles) insertMapping.run(row.id, muscleId, share);
    }

    // Chaque groupe devient un maillage complet, dans les deux sens.
    for (const group of ALTERNATIVE_GROUPS) {
      const ids = group
        .map((name) => (findExercise.get(name) as { id: number } | undefined)?.id)
        .filter((id): id is number => id !== undefined);

      ids.forEach((id, i) => {
        if (curated.has(id)) return;
        ids.filter((_, j) => j !== i).forEach((other, position) => {
          insertAlternative.run(id, other, position + 1);
        });
      });
    }
  })();
}
