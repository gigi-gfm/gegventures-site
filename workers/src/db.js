// Thin D1 helpers. Mirrors the surface of the Node version's db.js so the
// rest of the Worker code reads naturally.

import { hashPassword, verifyPassword, randomToken } from './crypto.js';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const db = {
  // ---- Setup ----
  async bootstrapAdmin(env) {
    const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
    if (count > 0) return null;
    const email = (env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = (env.ADMIN_PASSWORD || '').trim();
    const name = (env.ADMIN_NAME || '').trim() || 'Admin';
    if (!email || !password || password.length < 8) {
      return null;
    }
    return await db.createUser(env, { email, password, name, role: 'admin' });
  },

  // ---- Users ----
  async listUsers(env) {
    const { results } = await env.DB
      .prepare('SELECT id, email, name, role, created_at FROM users ORDER BY id ASC')
      .all();
    return results || [];
  },

  async getUserById(env, id) {
    return await env.DB
      .prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?')
      .bind(id)
      .first();
  },

  async getUserByEmail(env, email) {
    return await env.DB
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(email.trim().toLowerCase())
      .first();
  },

  async createUser(env, { email, password, name, role = 'user' }) {
    if (!email || !password || !name) throw new Error('email, password, and name are required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    const e = email.trim().toLowerCase();
    const existing = await db.getUserByEmail(env, e);
    if (existing) throw new Error('A user with that email already exists');
    const hash = await hashPassword(password);
    const r = await env.DB
      .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
      .bind(e, hash, name.trim(), role === 'admin' ? 'admin' : 'user')
      .run();
    const id = r.meta?.last_row_id;
    return await db.getUserById(env, id);
  },

  async deleteUser(env, id) {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  },

  async verifyUserPassword(env, email, password) {
    const u = await db.getUserByEmail(env, email);
    if (!u) return null;
    const ok = await verifyPassword(password, u.password_hash);
    return ok ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
  },

  // ---- Sessions ----
  async createSession(env, userId) {
    const token = randomToken(32);
    const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    await env.DB
      .prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(token, userId, expires)
      .run();
    return { token, expires };
  },

  async getSessionUser(env, token) {
    if (!token) return null;
    const row = await env.DB
      .prepare(
        `SELECT u.id, u.email, u.name, u.role, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .bind(token)
      .first();
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at < now) {
      await db.deleteSession(env, token);
      return null;
    }
    return { id: row.id, email: row.email, name: row.name, role: row.role };
  },

  async deleteSession(env, token) {
    if (!token) return;
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  },

  async purgeExpiredSessions(env) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  },

  // ---- Cases ----
  async listCases(env, { includeArchived = false } = {}) {
    const sql = includeArchived
      ? `SELECT c.*, u.name AS created_by_name
         FROM cases c LEFT JOIN users u ON u.id = c.created_by
         ORDER BY c.updated_at DESC`
      : `SELECT c.*, u.name AS created_by_name
         FROM cases c LEFT JOIN users u ON u.id = c.created_by
         WHERE c.archived = 0
         ORDER BY c.updated_at DESC`;
    const { results } = await env.DB.prepare(sql).all();
    return (results || []).map(parseCase);
  },

  async getCase(env, id) {
    const row = await env.DB
      .prepare(
        `SELECT c.*, u.name AS created_by_name
         FROM cases c LEFT JOIN users u ON u.id = c.created_by
         WHERE c.id = ?`,
      )
      .bind(id)
      .first();
    return row ? parseCase(row) : null;
  },

  async createCase(env, { label, userId }) {
    const r = await env.DB
      .prepare('INSERT INTO cases (label, created_by) VALUES (?, ?)')
      .bind(label || 'New case', userId)
      .run();
    return await db.getCase(env, r.meta?.last_row_id);
  },

  async updateCase(env, id, patch) {
    const existing = await db.getCase(env, id);
    if (!existing) return null;
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
    const sets = [];
    const vals = [];
    for (const k of Object.keys(patch)) {
      if (colMap[k]) {
        sets.push(`${colMap[k]} = ?`);
        vals.push(k === 'archived' ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (patch.data !== undefined) {
      sets.push('data_json = ?');
      vals.push(JSON.stringify(patch.data));
    }
    sets.push('updated_at = unixepoch()');
    if (sets.length === 1) return existing;
    vals.push(id);
    await env.DB.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    return await db.getCase(env, id);
  },

  async deleteCase(env, id) {
    await env.DB.prepare('DELETE FROM cases WHERE id = ?').bind(id).run();
  },

  // ---- Time entries ----
  async listEntries(env, caseId) {
    const { results } = await env.DB
      .prepare(
        `SELECT e.id, e.entry_date AS entryDate, e.activity, e.hours,
                u.name AS createdByName
         FROM time_entries e LEFT JOIN users u ON u.id = e.created_by
         WHERE e.case_id = ?
         ORDER BY e.entry_date DESC, e.id DESC`,
      )
      .bind(caseId)
      .all();
    return results || [];
  },

  async addEntry(env, caseId, { entryDate, activity, hours, userId }) {
    if (!hours || hours <= 0) throw new Error('Hours must be > 0');
    const date = entryDate || new Date().toISOString().slice(0, 10);
    const r = await env.DB
      .prepare(
        'INSERT INTO time_entries (case_id, entry_date, activity, hours, created_by) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(caseId, date, activity || '', hours, userId || null)
      .run();
    await env.DB.prepare('UPDATE cases SET updated_at = unixepoch() WHERE id = ?').bind(caseId).run();
    return { id: r.meta?.last_row_id };
  },

  async deleteEntry(env, caseId, entryId) {
    await env.DB
      .prepare('DELETE FROM time_entries WHERE id = ? AND case_id = ?')
      .bind(entryId, caseId)
      .run();
  },

  // ---- Live timer ----
  async getTimer(env, caseId) {
    const row = await env.DB
      .prepare('SELECT started_at AS startedAt, started_by AS startedBy FROM timers WHERE case_id = ?')
      .bind(caseId)
      .first();
    return row || null;
  },

  async startTimer(env, caseId, userId) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare(
        `INSERT INTO timers (case_id, started_at, started_by) VALUES (?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET started_at = excluded.started_at, started_by = excluded.started_by`,
      )
      .bind(caseId, now, userId || null)
      .run();
    return await db.getTimer(env, caseId);
  },

  async stopTimer(env, caseId) {
    const t = await db.getTimer(env, caseId);
    if (!t) return null;
    const elapsedHours = (Date.now() / 1000 - t.startedAt) / 3600;
    const rounded = Math.round(elapsedHours * 4) / 4;
    await env.DB.prepare('DELETE FROM timers WHERE case_id = ?').bind(caseId).run();
    if (rounded > 0) {
      await db.addEntry(env, caseId, {
        entryDate: new Date().toISOString().slice(0, 10),
        activity: 'Timer session',
        hours: rounded,
        userId: t.startedBy,
      });
    }
    return { stoppedHours: rounded };
  },
};

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
