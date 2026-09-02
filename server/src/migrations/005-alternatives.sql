-- v5 : que faire quand la machine est prise, et a quoi ressemble le mouvement.

-- Identifiant du schema du mouvement. Les dessins vivent dans le client : la
-- base ne transporte qu'une cle, pas de l'image.
ALTER TABLE exercise ADD COLUMN diagram TEXT;

-- Alternatives, enregistrees dans les deux sens : si le chest press remplace le
-- developpe couche, l'inverse est vrai aussi.
CREATE TABLE exercise_alternative (
  exercise_id    INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  alternative_id INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (exercise_id, alternative_id)
);

-- Remplacement pour une seance donnee. La cle est l'exercice PREVU, et non la
-- ligne de programme : celle-ci est supprimee et recreee a chaque edition du
-- programme, ce qui emporterait le remplacement avec elle.
CREATE TABLE session_swap (
  session_id TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  planned_id INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  actual_id  INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, planned_id)
);
