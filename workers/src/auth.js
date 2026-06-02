// Auth + session helpers and the auth router.

import { Hono } from 'hono';
import { db } from './db.js';

export const SESSION_COOKIE = 'geg_session';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function getSessionTokenFromRequest(c) {
  const cookieHeader = c.req.header('cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export async function currentUser(c) {
  const token = getSessionTokenFromRequest(c);
  if (!token) return null;
  return await db.getSessionUser(c.env, token);
}

export function setSessionCookie(c, token) {
  const isProd = (c.env.NODE_ENV || 'production') === 'production';
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(c) {
  const isProd = (c.env.NODE_ENV || 'production') === 'production';
  const parts = [
    `${SESSION_COOKIE}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  c.header('Set-Cookie', parts.join('; '));
}

// Middleware: require a logged-in user. Use on every protected /api/ route.
export async function requireAuth(c, next) {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Not signed in.' }, 401);
  c.set('user', user);
  await next();
}
// Middleware: require admin role.
export async function requireAdmin(c, next) {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Not signed in.' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'Admin only.' }, 403);
  c.set('user', user);
  await next();
}

// ---- Router ----
export const authRouter = new Hono();

authRouter.get('/setup-available', async (c) => {
  const users = await db.listUsers(c.env);
  return c.json({ available: users.length === 0 });
});

authRouter.post('/setup', async (c) => {
  const users = await db.listUsers(c.env);
  if (users.length > 0) {
    return c.json({ error: 'Setup is already complete. Use the login page.' }, 403);
  }
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  try {
    const user = await db.createUser(c.env, {
      email: body?.email,
      password: body?.password,
      name: body?.name,
      role: 'admin',
    });
    const { token } = await db.createSession(c.env, user.id);
    setSessionCookie(c, token);
    return c.json({ user });
  } catch (err) {
    return c.json({ error: err.message || 'Could not create admin.' }, 400);
  }
});

authRouter.post('/login', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const email = (body?.email || '').trim().toLowerCase();
  const password = body?.password || '';
  if (!email || !password) return c.json({ error: 'Email and password are required.' }, 400);
  const user = await db.verifyUserPassword(c.env, email, password);
  if (!user) return c.json({ error: 'Incorrect email or password.' }, 401);
  const { token } = await db.createSession(c.env, user.id);
  setSessionCookie(c, token);
  return c.json({ user });
});

authRouter.post('/logout', async (c) => {
  const token = getSessionTokenFromRequest(c);
  if (token) await db.deleteSession(c.env, token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRouter.get('/me', async (c) => {
  const user = await currentUser(c);
  return c.json({ user });
});
