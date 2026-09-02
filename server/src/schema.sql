PRAGMA foreign_keys = ON;

CREATE TABLE exercise (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE,
  muscle_group  TEXT    NOT NULL,
  -- increment de charge suggere quand la progression est validee
  increment_kg  REAL    NOT NULL DEFAULT 2.5,
  is_bodyweight INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT
);

-- Une "journee type" du programme : Haut A, Bas A, Haut B, Bas B
CREATE TABLE routine_day (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  position INTEGER NOT NULL UNIQUE   -- ordre dans la rotation
);

CREATE TABLE routine_exercise (
  id             INTEGER PRIMARY KEY,
  routine_day_id INTEGER NOT NULL REFERENCES routine_day(id) ON DELETE CASCADE,
  exercise_id    INTEGER NOT NULL REFERENCES exercise(id),
  position       INTEGER NOT NULL,
  target_sets    INTEGER NOT NULL,
  rep_min        INTEGER NOT NULL,
  rep_max        INTEGER NOT NULL,
  rest_seconds   INTEGER NOT NULL DEFAULT 120,
  UNIQUE (routine_day_id, position)
);

CREATE TABLE session (
  id             TEXT    PRIMARY KEY,          -- UUID client
  routine_day_id INTEGER NOT NULL REFERENCES routine_day(id),
  started_at     TEXT    NOT NULL,             -- ISO 8601
  ended_at       TEXT,
  note           TEXT
);
CREATE INDEX idx_session_started ON session (started_at DESC);

CREATE TABLE set_entry (
  id          TEXT    PRIMARY KEY,             -- UUID client
  session_id  TEXT    NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercise(id),
  set_index   INTEGER NOT NULL,
  weight_kg   REAL    NOT NULL,
  reps        INTEGER NOT NULL,
  done_at     TEXT    NOT NULL
);
CREATE INDEX idx_set_exercise_date ON set_entry (exercise_id, done_at DESC);
CREATE INDEX idx_set_session ON set_entry (session_id);

CREATE TABLE bodyweight (
  measured_on TEXT PRIMARY KEY,                -- YYYY-MM-DD, une mesure par jour
  weight_kg   REAL NOT NULL
);

-- Repas recurrents pre-enregistres, loggables en un tap
CREATE TABLE meal_template (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL,
  kcal      INTEGER NOT NULL,
  protein_g INTEGER NOT NULL,
  position  INTEGER NOT NULL
);

CREATE TABLE food_log (
  id          TEXT    PRIMARY KEY,             -- UUID client
  logged_on   TEXT    NOT NULL,                -- YYYY-MM-DD
  label       TEXT    NOT NULL,
  kcal        INTEGER NOT NULL,
  protein_g   INTEGER NOT NULL,
  template_id INTEGER REFERENCES meal_template(id)
);
CREATE INDEX idx_food_log_date ON food_log (logged_on);

CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
