/**
 * Schemas des mouvements.
 *
 * Dessines plutot que photographies : aucune dependance a un service externe
 * (section 2), rien a telecharger, et le trait reste lisible sur fond sombre a
 * bout de bras.
 *
 * REGLE DE VUE. Squat, charniere de hanche, poussee, tirage et flexion de coude
 * appartiennent au plan sagittal : ils se montrent DE PROFIL. Et de profil, une
 * barre se voit par la tranche — un disque rond, pas un trait horizontal a deux
 * disques. Melanger les deux donnait des silhouettes de cote tenant du materiel
 * vu de face.
 *
 * La vue de face est reservee au plan frontal — elevations laterales, ecartes —
 * et aux tirages suspendus, ou les deux bras se superposeraient de profil.
 *
 * Les pieds sont dessines : sans eux, une silhouette ne dit pas de quel cote
 * elle regarde. Toutes les figures de profil regardent a droite.
 *
 * Repere : 120 x 68, sol a y = 60. Corps en gris, charge en accent, materiel
 * fixe en filet.
 */

export type Tone = 'body' | 'load' | 'frame';

export type Shape =
  | { k: 'l'; x1: number; y1: number; x2: number; y2: number; t: Tone; w?: number }
  | { k: 'c'; cx: number; cy: number; r: number; t: Tone; fill?: boolean }
  | { k: 'p'; d: string; t: Tone };

const GROUND = 60;

const line = (x1: number, y1: number, x2: number, y2: number, t: Tone = 'body', w?: number): Shape =>
  ({ k: 'l', x1, y1, x2, y2, t, ...(w ? { w } : {}) });
const circle = (cx: number, cy: number, r: number, t: Tone = 'body', fill = false): Shape =>
  ({ k: 'c', cx, cy, r, t, fill });
const path = (d: string, t: Tone = 'body'): Shape => ({ k: 'p', d, t });

const ground = (): Shape[] => [line(10, GROUND, 110, GROUND, 'frame')];

/** Pied de profil : c'est lui qui dit de quel cote regarde la silhouette. */
const foot = (x: number, y: number, dir = 1): Shape => line(x, y, x + 8 * dir, y);

// --- Materiel vu par la tranche ---------------------------------------------

/** Barre chargee de profil : le disque est un cercle, le fut son moyeu. */
const plate = (cx: number, cy: number, r = 8): Shape[] => [
  circle(cx, cy, r, 'load'),
  circle(cx, cy, 1.5, 'load', true),
];

/** Haltere de profil : meme principe, plus petit. */
const bell = (cx: number, cy: number): Shape[] => [
  circle(cx, cy, 5, 'load'),
  circle(cx, cy, 1.2, 'load', true),
];

/** Poignee de machine, vue par la tranche. */
const handle = (cx: number, cy: number): Shape[] => [
  circle(cx, cy, 4, 'load'),
  circle(cx, cy, 1.2, 'load', true),
];

// --- Materiel vu de face (plan frontal uniquement) --------------------------

const barFront = (cx: number, cy: number, half = 24): Shape[] => [
  line(cx - half, cy, cx + half, cy, 'load'),
  line(cx - half + 3, cy - 7, cx - half + 3, cy + 7, 'load', 3.5),
  line(cx + half - 3, cy - 7, cx + half - 3, cy + 7, 'load', 3.5),
];

const bellFront = (cx: number, cy: number): Shape[] => [
  line(cx - 6, cy, cx + 6, cy, 'load'),
  line(cx - 6, cy - 4.5, cx - 6, cy + 4.5, 'load', 3.5),
  line(cx + 6, cy - 4.5, cx + 6, cy + 4.5, 'load', 3.5),
];

// --- Machines ---------------------------------------------------------------

/** Colonne de poids : les plaques chargees en accent, le reste en filet. */
const stack = (x: number, y: number): Shape[] => [
  line(x, y - 3, x, y + 23, 'frame'),
  line(x - 5, y + 4, x + 5, y + 4, 'load', 3),
  line(x - 5, y + 9, x + 5, y + 9, 'load', 3),
  line(x - 5, y + 14, x + 5, y + 14, 'frame', 3),
  line(x - 5, y + 19, x + 5, y + 19, 'frame', 3),
];

const pulley = (cx: number, cy: number): Shape[] => [circle(cx, cy, 3.5, 'frame')];

/** Fleche du sens du mouvement. */
const arrow = (x: number, y1: number, y2: number): Shape[] => {
  const tip = y2 < y1 ? y2 + 5 : y2 - 5;
  return [line(x, y1, x, y2, 'frame'), line(x - 3, tip, x, y2, 'frame'), line(x + 3, tip, x, y2, 'frame')];
};

// --- Poses de profil, regardant a droite ------------------------------------

/** Debout, jambes tendues. Chaque exercice dessine le bras. */
const standing = (x = 50): Shape[] => [
  ...ground(),
  circle(x, 12, 5),
  line(x, 17, x - 1, 36),
  line(x - 1, 36, x - 3, GROUND), foot(x - 3, GROUND),
  line(x - 1, 36, x + 3, GROUND), foot(x + 3, GROUND),
];

/** Charniere de hanche : dos gaine, buste vers l'avant. */
const hinge = (): Shape[] => [
  ...ground(),
  circle(30, 24, 5),
  line(35, 27, 66, 38),
  line(66, 38, 63, GROUND), foot(63, GROUND),
  line(66, 38, 69, GROUND), foot(69, GROUND),
];

/** Allonge sur un banc. `rise` releve le dossier cote tete. */
const onBench = (rise = 0): Shape[] => [
  ...ground(),
  line(28, 40 - rise, 92, 40, 'frame', 3),
  line(38, 42, 38, GROUND, 'frame'),
  line(86, 42, 86, GROUND, 'frame'),
  circle(34, 34 - rise, 5),
  line(40, 37 - rise, 70, 37),
  line(70, 37, 80, 47),
  line(80, 47, 80, GROUND), foot(80, GROUND),
];

/** Assis dans une machine : assise, dossier, montant. */
const seatedMachine = (): Shape[] => [
  ...ground(),
  line(40, 44, 70, 44, 'frame', 3),
  line(40, 44, 36, 22, 'frame', 3),
  line(34, 20, 34, 58, 'frame'),
  line(28, 58, 78, 58, 'frame'),
  circle(44, 17, 5),
  line(45, 22, 42, 42),
  line(42, 42, 66, 45),
  line(66, 45, 68, 56), foot(68, 56),
];

// --- Poses de face (plan frontal) -------------------------------------------

const hangingFront = (): Shape[] => [
  circle(60, 26, 5),
  line(60, 31, 60, 45),
  line(57, 28, 50, 13),
  line(63, 28, 70, 13),
  line(60, 45, 53, 56),
  line(60, 45, 67, 56),
];

const standingFront = (x = 58): Shape[] => [
  ...ground(),
  circle(x, 12, 5),
  line(x, 17, x, 36),
  line(x, 36, x - 7, GROUND),
  line(x, 36, x + 7, GROUND),
];

// --- Schemas ----------------------------------------------------------------

const DIAGRAMS: Record<string, () => Shape[]> = {
  // --- Pectoraux ---
  'bench-barbell': () => [...onBench(), line(56, 36, 58, 24), ...plate(58, 18), ...arrow(102, 34, 16)],
  'bench-smith': () => [
    ...onBench(), line(30, 6, 30, 56, 'frame'), line(88, 6, 88, 56, 'frame'),
    line(56, 36, 58, 24), ...plate(58, 18), ...arrow(102, 34, 16),
  ],
  'incline-dumbbell': () => [...onBench(10), line(52, 31, 56, 20), ...bell(57, 15), ...arrow(102, 34, 16)],
  'chest-press-machine': () => [
    ...seatedMachine(), ...stack(100, 22),
    line(45, 24, 70, 28), ...handle(74, 28), line(78, 28, 96, 26, 'frame'),
  ],
  'pec-deck': () => [
    ...seatedMachine(), ...stack(100, 22),
    line(45, 24, 72, 22), ...handle(76, 21), path('M 82 14 Q 94 24 92 36', 'frame'),
  ],
  'cable-fly': () => [
    ...standingFront(58), ...pulley(14, 14), ...pulley(102, 14),
    line(14, 14, 42, 28, 'load'), line(102, 14, 74, 28, 'load'),
    line(58, 21, 42, 28), line(58, 21, 74, 28),
  ],
  'pushup': () => [
    ...ground(), circle(24, 30, 5), line(29, 32, 60, 42), line(60, 42, 88, 55), foot(88, 55),
    line(32, 34, 32, GROUND - 2), line(26, GROUND, 38, GROUND, 'load', 3.5),
    ...arrow(78, 26, 14),
  ],
  'dips': () => [
    ...ground(),
    line(48, 34, 48, GROUND, 'frame'), line(70, 34, 70, GROUND, 'frame'),
    line(46, 34, 72, 34, 'load', 3.5),
    circle(58, 11, 5), line(58, 16, 57, 33), line(58, 18, 53, 33),
    line(57, 33, 63, 45), line(63, 45, 56, 51),
    ...arrow(98, 16, 36),
  ],
  'dips-machine': () => [
    ...ground(),
    line(48, 32, 48, GROUND, 'frame'), line(70, 32, 70, GROUND, 'frame'),
    line(46, 32, 72, 32, 'load', 3.5),
    circle(58, 9, 5), line(58, 14, 57, 31), line(58, 16, 53, 31),
    line(52, 46, 70, 46, 'frame', 3), line(57, 31, 58, 46),
    ...stack(100, 24),
  ],

  // --- Dos ---
  'row-barbell': () => [...hinge(), line(40, 28, 42, 44), ...plate(42, 48), ...arrow(100, 46, 28)],
  'row-dumbbell': () => [
    ...ground(), line(26, 40, 70, 40, 'frame', 3), line(32, 42, 32, GROUND, 'frame'),
    circle(26, 30, 5), line(31, 32, 62, 36), line(62, 36, 70, 46), line(70, 46, 70, GROUND), foot(70, GROUND),
    line(44, 34, 44, 44), ...bell(44, 48), ...arrow(100, 46, 30),
  ],
  'seated-row-machine': () => [
    ...ground(), line(38, 44, 68, 44, 'frame', 3), line(32, 44, 32, GROUND, 'frame'),
    circle(42, 20, 5), line(43, 25, 40, 42), line(40, 42, 64, 45), line(64, 45, 68, 56), foot(68, 56),
    line(44, 28, 74, 30), ...handle(78, 30), ...stack(100, 22),
  ],
  'cable-row': () => [
    ...ground(), line(38, 44, 68, 44, 'frame', 3),
    circle(42, 20, 5), line(43, 25, 40, 42), line(40, 42, 64, 45), line(64, 45, 68, 56), foot(68, 56),
    line(44, 28, 86, 38, 'load'), ...pulley(92, 40), line(92, 44, 92, 56, 'frame'),
  ],
  'lat-pulldown': () => [
    ...ground(), line(38, 44, 70, 44, 'frame', 3), line(32, 44, 32, GROUND, 'frame'),
    circle(46, 22, 5), line(47, 27, 44, 42), line(44, 42, 66, 45), line(66, 45, 70, 56), foot(70, 56),
    line(47, 26, 56, 15), ...plate(58, 12, 6),
    line(30, 5, 90, 5, 'frame'), line(58, 5, 58, 6, 'load'),
    ...arrow(88, 18, 36),
  ],
  'pullup': () => [...hangingFront(), ...barFront(60, 10, 30), ...arrow(100, 40, 22)],
  'assisted-pullup': () => [
    ...hangingFront(), ...barFront(60, 10, 30),
    line(46, 54, 74, 54, 'frame', 3), line(60, 45, 55, 54), line(60, 45, 65, 54),
    ...stack(102, 28),
  ],

  // --- Epaules ---
  'ohp-barbell': () => [...standing(50), line(50, 20, 52, 12), ...plate(53, 6), ...arrow(96, 28, 8)],
  'ohp-dumbbell': () => [...seatedMachine(), line(45, 22, 50, 13), ...bell(51, 8), ...arrow(94, 30, 10)],
  'shoulder-press-machine': () => [
    ...seatedMachine(), ...stack(100, 22),
    line(45, 22, 54, 13), ...handle(56, 9), line(60, 9, 96, 18, 'frame'),
  ],
  'lateral-raise': () => [
    ...standingFront(58), line(58, 21, 34, 24), line(58, 21, 82, 24),
    ...bellFront(28, 25), ...bellFront(88, 25), ...arrow(104, 44, 24),
  ],
  'lateral-raise-cable': () => [
    ...standingFront(52), line(52, 21, 78, 25), ...bellFront(84, 26),
    line(88, 27, 100, 50, 'load'), ...pulley(103, 53),
    line(52, 21, 44, 38), ...arrow(20, 44, 24),
  ],

  // --- Jambes ---
  'squat-barbell': () => [
    ...ground(), circle(48, 14, 5), line(48, 19, 46, 32),
    line(46, 32, 36, 44), line(36, 44, 40, GROUND), foot(40, GROUND),
    line(46, 32, 58, 44), line(58, 44, 58, GROUND), foot(58, GROUND),
    ...plate(50, 21), ...arrow(96, 42, 22),
  ],
  'squat-smith': () => [
    ...ground(), line(28, 4, 28, 56, 'frame'), line(80, 4, 80, 56, 'frame'),
    circle(48, 14, 5), line(48, 19, 46, 32),
    line(46, 32, 36, 44), line(36, 44, 40, GROUND), foot(40, GROUND),
    line(46, 32, 58, 44), line(58, 44, 58, GROUND), foot(58, GROUND),
    ...plate(50, 21),
  ],
  'hack-squat': () => [
    ...ground(), line(20, 52, 78, 20, 'frame', 3), line(20, 52, 20, GROUND, 'frame'),
    circle(36, 38, 5), line(41, 40, 58, 32), line(58, 32, 60, 46), line(60, 46, 76, 44), foot(76, 44),
    line(76, 38, 76, 50, 'load', 3.5), ...stack(98, 18), ...arrow(66, 14, 30),
  ],
  'leg-press': () => [
    ...ground(), line(16, 48, 48, 42, 'frame', 3), line(16, 48, 16, GROUND, 'frame'),
    circle(22, 36, 5), line(27, 38, 50, 42), line(50, 42, 72, 32), line(72, 32, 84, 28),
    line(84, 16, 94, 40, 'load', 3.5), ...stack(104, 18), ...arrow(68, 12, 24),
  ],
  'leg-extension': () => [
    ...seatedMachine(), ...stack(100, 22), line(66, 45, 86, 36), ...handle(90, 34), ...arrow(80, 56, 38),
  ],
  'leg-curl-seated': () => [
    ...seatedMachine(), ...stack(100, 22), line(66, 45, 84, 54), ...handle(88, 56), ...arrow(78, 36, 54),
  ],
  'leg-curl-lying': () => [
    ...ground(), line(24, 40, 82, 40, 'frame', 3), line(30, 42, 30, GROUND, 'frame'),
    circle(24, 34, 5), line(29, 36, 68, 38), line(68, 38, 78, 28), ...handle(82, 26),
    ...stack(102, 22), ...arrow(94, 44, 26),
  ],
  'lunge': () => [
    ...ground(), circle(48, 12, 5), line(48, 17, 47, 32),
    line(47, 32, 68, 44), line(68, 44, 68, GROUND), foot(68, GROUND),
    line(47, 32, 34, 46), line(34, 46, 40, GROUND), foot(40, GROUND, -1),
    line(48, 20, 44, 34), ...bell(44, 39),
  ],
  'bulgarian-split': () => [
    ...ground(), line(74, 40, 102, 40, 'frame', 3), line(80, 42, 80, GROUND, 'frame'),
    circle(44, 12, 5), line(44, 17, 43, 32),
    line(43, 32, 38, 46), line(38, 46, 42, GROUND), foot(42, GROUND),
    line(43, 32, 64, 38), line(64, 38, 78, 38),
    line(44, 20, 38, 34), ...bell(38, 39),
  ],
  'deadlift': () => [...hinge(), line(40, 28, 42, 48), ...plate(42, 52), ...arrow(100, 50, 24)],
  'rdl-barbell': () => [
    ...ground(), circle(30, 22, 5), line(35, 25, 64, 34),
    line(64, 34, 62, GROUND), foot(62, GROUND), line(64, 34, 68, GROUND), foot(68, GROUND),
    line(40, 27, 42, 40), ...plate(42, 44), ...arrow(100, 44, 24),
  ],
  'rdl-dumbbell': () => [
    ...ground(), circle(30, 22, 5), line(35, 25, 64, 34),
    line(64, 34, 62, GROUND), foot(62, GROUND), line(64, 34, 68, GROUND), foot(68, GROUND),
    line(40, 27, 42, 41), ...bell(42, 46), ...arrow(100, 44, 24),
  ],
  'calf-standing': () => [
    ...ground(), line(32, 6, 32, 56, 'frame'), line(76, 6, 76, 56, 'frame'),
    line(40, 52, 70, 52, 'frame', 3), line(42, 52, 42, GROUND, 'frame'),
    circle(52, 12, 5), line(52, 17, 51, 34),
    line(51, 34, 49, 50), foot(49, 50), line(51, 34, 55, 50), foot(55, 50),
    line(51, 16, 51, 23, 'load', 6),
    ...arrow(90, 40, 24),
  ],
  'calf-press': () => [
    ...ground(), line(16, 48, 48, 42, 'frame', 3), line(16, 48, 16, GROUND, 'frame'),
    circle(22, 36, 5), line(27, 38, 50, 42), line(50, 42, 78, 34), line(78, 34, 86, 30),
    line(84, 20, 94, 38, 'load', 3.5), ...stack(104, 18), ...arrow(68, 18, 28),
  ],

  // --- Bras ---
  'curl-barbell': () => [
    ...standing(48), line(48, 20, 46, 34), line(46, 34, 53, 30), ...plate(58, 28, 7), ...arrow(96, 44, 26),
  ],
  'curl-ez': () => [
    ...standing(48), line(48, 20, 46, 34), line(46, 34, 53, 30), ...plate(58, 28, 6),
    ...arrow(96, 44, 26),
  ],
  'curl-dumbbell': () => [
    ...standing(48), line(48, 20, 46, 34), line(46, 34, 53, 28), ...bell(57, 26), ...arrow(96, 44, 26),
  ],
  'curl-cable': () => [
    ...standing(44), line(44, 20, 42, 34), line(42, 34, 51, 30), ...plate(56, 28, 6),
    line(61, 30, 92, 48, 'load'), ...pulley(96, 51),
  ],
  'curl-machine': () => [
    ...seatedMachine(), ...stack(100, 22),
    line(52, 34, 78, 28, 'frame', 3), line(45, 24, 58, 32), ...handle(62, 30), ...arrow(88, 46, 26),
  ],
  'triceps-pushdown': () => [
    ...ground(), circle(42, 12, 5), line(42, 17, 41, 36),
    line(41, 36, 39, GROUND), foot(39, GROUND), line(41, 36, 45, GROUND), foot(45, GROUND),
    line(20, 5, 92, 5, 'frame'), ...pulley(66, 9),
    line(66, 12, 66, 30, 'load'), ...plate(66, 36, 6),
    line(42, 20, 60, 26), line(60, 26, 64, 33),
    ...arrow(92, 26, 44),
  ],
  'skullcrusher': () => [
    ...onBench(), line(56, 36, 56, 25), line(56, 25, 49, 19), ...plate(44, 16, 7), ...arrow(102, 30, 14),
  ],
};

export const DIAGRAM_KEYS = Object.keys(DIAGRAMS);

/** Formes du schema, ou tableau vide si l'exercice n'en a pas. */
export function diagram(key: string | null | undefined): Shape[] {
  if (!key) return [];
  return DIAGRAMS[key]?.() ?? [];
}
