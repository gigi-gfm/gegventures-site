// Garcia Family Medicine — Clinic Studio Worker entry point.
//
// Stage 3 (this commit): auth + sessions + admin bootstrap.

import { Hono } from 'hono';
import { db } from './db.js';
import {
  authRouter,
  currentUser,
  requireAuth,
} from './auth.js';

const app = new Hono();

// ---- Status (public) ----
app.get('/api/status', async (c) => {
  return c.json({
    status: 'Clinic Studio Worker running',
    version: '1.0.0',
    stage: 3,
    aiConfigured: !!c.env.ANTHROPIC_API_KEY,
    voicerxConfigured: !!c.env.VOICERX_TOKEN,
    dbConfigured: !!c.env.DB,
  });
});

app.get('/healthz', (c) => c.text('ok'));

// ---- One-time admin bootstrap on each cold start (idempotent) ----
// If no users exist and ADMIN_EMAIL/ADMIN_PASSWORD are set as env vars,
// creates the first admin. After the first user is created this is a no-op.
async function ensureBootstrapped(env) {
  try { await db.bootstrapAdmin(env); } catch (e) { /* swallow */ }
  try { await db.purgeExpiredSessions(env); } catch (e) { /* swallow */ }
}

// Run before any request that touches DB. Cheap once tables exist.
app.use('*', async (c, next) => {
  if (c.env.DB && c.req.path.startsWith('/api/')) {
    await ensureBootstrapped(c.env);
  }
  await next();
});

// ---- Auth routes (public) ----
app.route('/api/auth', authRouter);

// ---- Sanity check for auth ----
// Returns the user's name; uses requireAuth so this 401s if not logged in.
app.get('/api/whoami', requireAuth, (c) => {
  const user = c.get('user');
  return c.json({ user });
});

// ---- Public marketing pages and logged-out HTML pages: pass through to assets.
// Protected HTML pages: redirect to /login.html if no session.
const PROTECTED_HTML = new Set([
  '/ime-studio.html',
  '/referral.html',
  '/return-to-work.html',
  '/cases.html',
  '/users.html',
]);

app.all('*', async (c) => {
  const path = new URL(c.req.url).pathname;

  if (PROTECTED_HTML.has(path)) {
    const u = await currentUser(c);
    if (!u) return c.redirect('/login.html?next=' + encodeURIComponent(path));
  }

  // Any /api/* that wasn't matched above is a 404.
  if (path.startsWith('/api/')) {
    return c.json({ error: 'Not found', path }, 404);
  }

  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Not found', 404);
});

export default app;
