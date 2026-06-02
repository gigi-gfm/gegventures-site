-- Garcia Family Medicine — Clinic Studio
-- Initial D1 schema. Mirrors the SQLite schema in db.js so we can
-- copy the existing Node app's behavior 1:1.
--
-- Note: D1 / Cloudflare uses unixepoch() seconds rather than the
-- SQLite-flavored datetime('now'). Both default to the same idea —
-- "when the row was created" — but the stored representation is a
-- bigint (seconds since 1970) rather than a TEXT timestamp.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  data_json       TEXT NOT NULL DEFAULT '{}',
  ime_draft       TEXT,
  retainer_date   TEXT,
  records_date    TEXT,
  exam_date       TEXT,
  soft_deadline   TEXT,
  hard_deadline   TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS time_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  entry_date   TEXT NOT NULL,
  activity     TEXT NOT NULL DEFAULT '',
  hours        REAL NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS timers (
  case_id     INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  started_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_case ON time_entries(case_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
