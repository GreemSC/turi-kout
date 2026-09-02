-- v2 : ce qu'il faut pour mesurer, et non plus seulement consigner.
-- Strictement additif. Les lignes existantes prennent kind = 'work' et
-- rpe = NULL, ce qui reproduit exactement le comportement de la v1.

-- Nature de la serie. Un echauffement compte aujourd'hui comme du volume de
-- travail, ce qui fausse toute statistique construite dessus.
ALTER TABLE set_entry ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
-- Effort percu, 6 a 10 par pas de 0,5. NULL = non saisi.
ALTER TABLE set_entry ADD COLUMN rpe REAL;

-- Exercices enchaines sans repos intermediaire.
ALTER TABLE routine_exercise ADD COLUMN superset_group INTEGER;

-- De quoi savoir si une charge est reellement chargeable.
ALTER TABLE exercise ADD COLUMN equipment TEXT NOT NULL DEFAULT 'barbell';
ALTER TABLE exercise ADD COLUMN bar_kg REAL;

CREATE INDEX idx_set_kind ON set_entry (exercise_id, kind, done_at DESC);

-- Reperes de volume hebdomadaire, en sets fractionnes.
CREATE TABLE muscle (
  id       TEXT PRIMARY KEY,
  name     TEXT    NOT NULL,
  mev      REAL    NOT NULL,   -- minimum pour progresser
  mav_low  REAL    NOT NULL,   -- zone la plus productive, borne basse
  mav_high REAL    NOT NULL,   -- borne haute
  mrv      REAL    NOT NULL,   -- plafond recuperable
  position INTEGER NOT NULL
);

-- Comptage fractionne : 1,0 pour le muscle moteur, 0,5 pour un synergiste.
CREATE TABLE exercise_muscle (
  exercise_id INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  muscle_id   TEXT    NOT NULL REFERENCES muscle(id),
  share       REAL    NOT NULL,
  PRIMARY KEY (exercise_id, muscle_id)
);

-- Inventaire reel de la salle.
CREATE TABLE equipment_item (
  kind      TEXT    NOT NULL,           -- 'plate' | 'dumbbell'
  weight_kg REAL    NOT NULL,
  count     INTEGER NOT NULL DEFAULT 2, -- paires disponibles, pour les disques
  PRIMARY KEY (kind, weight_kg)
);
