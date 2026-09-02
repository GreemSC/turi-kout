-- v3 : rendre les charges justes la ou elles etaient muettes ou fausses.
--
-- Une traction consignait un lest de 0 : tonnage nul, aucun 1RM estime, aucun
-- record possible. Un rowing halteres consignait 30 kg sans dire si c'etait par
-- bras ou au total, donc un tonnage faux d'un facteur deux.

-- Part du poids de corps reellement soulevee. NULL = exercice a charge externe.
-- 1,0 en traction ou aux dips, ~0,65 en pompes.
ALTER TABLE exercise ADD COLUMN bodyweight_factor REAL;

-- Un cote a la fois : les repetitions sont par membre, le tonnage compte double.
ALTER TABLE exercise ADD COLUMN unilateral INTEGER NOT NULL DEFAULT 0;

-- Une note par exercice et par seance. La note de seance existait deja, mais au
-- mauvais niveau : on ne relit jamais une note globale, alors qu'on relit
-- toujours ce qu'on s'etait dit sur l'exercice qu'on a devant soi.
CREATE TABLE exercise_note (
  exercise_id INTEGER NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  session_id  TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  note        TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (exercise_id, session_id)
);
CREATE INDEX idx_note_exercise ON exercise_note (exercise_id, updated_at DESC);
