// SQLite-backed persistence for IME cases, users, and time tracking.
// File-based, lives at ./data/gegventures.db. Schema is created/migrated
// on every server start so the DB is always at the latest version.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'gegventures.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'user',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
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
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    entry_date   TEXT NOT NULL,
    activity     TEXT NOT NULL DEFAULT '',
    hours        REAL NOT NULL,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timers (
    case_id     INTEGER PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    started_at  TEXT NOT NULL,
    started_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cases_updated ON cases(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_entries_case ON time_entries(case_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Lightweight migrations for columns added after initial schema.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('cases', 'exam_date', 'TEXT');

// Bootstrap an admin user on first startup from env vars (ADMIN_EMAIL / ADMIN_PASSWORD)
// or fall back to a printed setup message.
export function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = (process.env.ADMIN_PASSWORD || '').trim();
  const name = (process.env.ADMIN_NAME || '').trim() || 'Admin';
  if (!email || !password) {
    console.warn(
      '[db] No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set in .env.\n' +
        '     Add them and restart, or visit /setup.html to create the first admin.'
    );
    return;
  }
  if (password.length < 8) {
    console.warn('[db] ADMIN_PASSWORD must be at least 8 characters. Skipping bootstrap.');
    return;
  }
  const hash = bcrypt.hashSync(password, 11);
  db.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
  ).run(email, hash, name, 'admin');
  console.log(`[db] Bootstrapped admin user: ${email}`);
}

// -------- Users --------
export function listUsers() {
  return db
    .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY id ASC')
    .all();
}
export function getUserById(id) {
  return db
    .prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?')
    .get(id);
}
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
export function createUser({ email, password, name, role = 'user' }) {
  if (!email || !password || !name) throw new Error('email, password, and name are required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const hash = bcrypt.hashSync(password, 11);
  const info = db
    .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(email.toLowerCase().trim(), hash, name.trim(), role === 'admin' ? 'admin' : 'user');
  return getUserById(info.lastInsertRowid);
}
export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
export function verifyUserPassword(email, password) {
  const user = getUserByEmail(email);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

// -------- Sessions --------
const SESSION_DAYS = 30;
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    expires,
  );
  return { token, expires };
}
export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    deleteSession(token);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
export function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

// -------- Cases --------
export function listCases({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? `SELECT c.*, u.name AS created_by_name
       FROM cases c LEFT JOIN users u ON u.id = c.created_by
       ORDER BY c.updated_at DESC`
    : `SELECT c.*, u.name AS created_by_name
       FROM cases c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.archived = 0
       ORDER BY c.updated_at DESC`;
  return db.prepare(sql).all().map(parseCase);
}
export function getCase(id) {
  const row = db
    .prepare(
      `SELECT c.*, u.name AS created_by_name
       FROM cases c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.id = ?`,
    )
    .get(id);
  return row ? parseCase(row) : null;
}
function parseCase(row) {
  let data = {};
  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch (e) { /* corrupt — start fresh */ }
  return {
    id: row.id,
    label: row.label,
    data,
    imeDraft: row.ime_draft || '',
    retainerDate: row.retainer_date || '',
    recordsDate: row.records_date || '',
    examDate: row.exam_date || '',
    softDeadline: row.soft_deadline || '',
    hardDeadline: row.hard_deadline || '',
    archived: !!row.archived,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function createCase({ label, userId }) {
  const info = db
    .prepare('INSERT INTO cases (label, created_by) VALUES (?, ?)')
    .run(label || 'New case', userId);
  return getCase(info.lastInsertRowid);
}
export function updateCase(id, patch) {
  const existing = getCase(id);
  if (!existing) return null;
  const fields = [];
  const values = [];
  const colMap = {
    label: 'label',
    imeDraft: 'ime_draft',
    retainerDate: 'retainer_date',
    recordsDate: 'records_date',
    examDate: 'exam_date',
    softDeadline: 'soft_deadline',
    hardDeadline: 'hard_deadline',
    archived: 'archived',
  };
  for (const key of Object.keys(patch)) {
    if (colMap[key]) {
      fields.push(`${colMap[key]} = ?`);
      values.push(key === 'archived' ? (patch[key] ? 1 : 0) : patch[key]);
    }
  }
  if (patch.data !== undefined) {
    fields.push('data_json = ?');
    values.push(JSON.stringify(patch.data));
  }
  fields.push("updated_at = datetime('now')");
  if (fields.length === 1) return existing; // nothing to update
  values.push(id);
  db.prepare(`UPDATE cases SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getCase(id);
}
export function deleteCase(id) {
  db.prepare('DELETE FROM cases WHERE id = ?').run(id);
}

// -------- Time entries --------
export function listEntries(caseId) {
  return db
    .prepare(
      `SELECT e.id, e.entry_date AS entryDate, e.activity, e.hours,
              u.name AS createdByName
       FROM time_entries e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.case_id = ?
       ORDER BY e.entry_date DESC, e.id DESC`,
    )
    .all(caseId);
}
export function addEntry(caseId, { entryDate, activity, hours, userId }) {
  if (!hours || hours <= 0) throw new Error('Hours must be > 0');
  const date = entryDate || new Date().toISOString().slice(0, 10);
  const info = db
    .prepare(
      'INSERT INTO time_entries (case_id, entry_date, activity, hours, created_by) VALUES (?, ?, ?, ?, ?)',
    )
    .run(caseId, date, activity || '', hours, userId || null);
  db.prepare("UPDATE cases SET updated_at = datetime('now') WHERE id = ?").run(caseId);
  return { id: info.lastInsertRowid };
}
export function deleteEntry(caseId, entryId) {
  db.prepare('DELETE FROM time_entries WHERE id = ? AND case_id = ?').run(entryId, caseId);
}

// -------- Live timers --------
export function getTimer(caseId) {
  return db.prepare('SELECT started_at AS startedAt, started_by AS startedBy FROM timers WHERE case_id = ?').get(caseId) || null;
}
export function startTimer(caseId, userId) {
  db.prepare(
    `INSERT INTO timers (case_id, started_at, started_by) VALUES (?, datetime('now'), ?)
     ON CONFLICT(case_id) DO UPDATE SET started_at = datetime('now'), started_by = excluded.started_by`,
  ).run(caseId, userId || null);
  return getTimer(caseId);
}
export function stopTimer(caseId) {
  const t = getTimer(caseId);
  if (!t) return null;
  const startedAt = new Date(t.startedAt + 'Z');
  const elapsedHours = (Date.now() - startedAt.getTime()) / 1000 / 3600;
  const rounded = Math.round(elapsedHours * 4) / 4;
  db.prepare('DELETE FROM timers WHERE case_id = ?').run(caseId);
  if (rounded > 0) {
    addEntry(caseId, {
      entryDate: new Date().toISOString().slice(0, 10),
      activity: 'Timer session',
      hours: rounded,
      userId: t.startedBy,
    });
  }
  return { stoppedHours: rounded };
}

export default db;
