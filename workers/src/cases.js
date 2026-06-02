// Cases CRUD + time tracker + admin user-management routes.

import { Hono } from 'hono';
import { db } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';

export const casesRouter = new Hono();

// ---- Admin: user management ----
casesRouter.get('/users', requireAdmin, async (c) => {
  return c.json({ users: await db.listUsers(c.env) });
});

casesRouter.post('/users', requireAdmin, async (c) => {
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  try {
    const user = await db.createUser(c.env, {
      email: body?.email,
      password: body?.password,
      name: body?.name,
      role: body?.role,
    });
    return c.json({ user });
  } catch (err) {
    return c.json({ error: err.message || 'Could not create user.' }, 400);
  }
});

casesRouter.delete('/users/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  if (id === user.id) return c.json({ error: 'Cannot delete your own account.' }, 400);
  await db.deleteUser(c.env, id);
  return c.json({ ok: true });
});

// ---- Cases ----
casesRouter.get('/cases', requireAuth, async (c) => {
  const includeArchived = c.req.query('archived') === '1';
  return c.json({ cases: await db.listCases(c.env, { includeArchived }) });
});

casesRouter.post('/cases', requireAuth, async (c) => {
  let body; try { body = await c.req.json(); } catch { body = {}; }
  const user = c.get('user');
  const label = (body?.label || '').trim();
  const created = await db.createCase(c.env, { label, userId: user.id });
  return c.json({ case: created });
});

casesRouter.get('/cases/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const caseObj = await db.getCase(c.env, id);
  if (!caseObj) return c.json({ error: 'Case not found.' }, 404);
  const entries = await db.listEntries(c.env, id);
  const timer = await db.getTimer(c.env, id);
  return c.json({ case: caseObj, entries, timer });
});

casesRouter.patch('/cases/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const allowed = [
    'label', 'data', 'imeDraft',
    'retainerDate', 'recordsDate', 'examDate', 'softDeadline', 'hardDeadline',
    'archived',
  ];
  const patch = {};
  for (const k of allowed) {
    if (body && Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
  }
  const updated = await db.updateCase(c.env, id, patch);
  if (!updated) return c.json({ error: 'Case not found.' }, 404);
  return c.json({ case: updated });
});

casesRouter.delete('/cases/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  if (c.req.query('hard') === '1' && user.role === 'admin') {
    await db.deleteCase(c.env, id);
  } else {
    await db.updateCase(c.env, id, { archived: true });
  }
  return c.json({ ok: true });
});

// ---- Time entries ----
casesRouter.get('/cases/:id/entries', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  return c.json({ entries: await db.listEntries(c.env, id) });
});

casesRouter.post('/cases/:id/entries', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  let body; try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  try {
    const r = await db.addEntry(c.env, id, {
      entryDate: body?.entryDate,
      activity: body?.activity,
      hours: Number(body?.hours),
      userId: user.id,
    });
    return c.json(r);
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

casesRouter.delete('/cases/:caseId/entries/:entryId', requireAuth, async (c) => {
  await db.deleteEntry(
    c.env,
    Number(c.req.param('caseId')),
    Number(c.req.param('entryId')),
  );
  return c.json({ ok: true });
});

// ---- Live timer ----
casesRouter.post('/cases/:id/timer/start', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const user = c.get('user');
  return c.json({ timer: await db.startTimer(c.env, id, user.id) });
});

casesRouter.post('/cases/:id/timer/stop', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const result = await db.stopTimer(c.env, id) || { stoppedHours: 0 };
  return c.json(result);
});
