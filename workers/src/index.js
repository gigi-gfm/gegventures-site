// Garcia Family Medicine — Clinic Studio Worker entry point.
//
// Stage 1 (this file): Hono scaffold with /api/status, healthcheck,
//   and static-asset fallback so the existing HTML pages work.
//
// Subsequent stages will add the auth, cases, time tracker, AI,
// and VoiceRx endpoints. Each one will be imported here as its own
// router and mounted under a path prefix.

import { Hono } from 'hono';

const app = new Hono();

// ---- Public ----
app.get('/api/status', (c) => {
  return c.json({
    status: 'Clinic Studio Worker running',
    version: '1.0.0',
    stage: 1,
    aiConfigured: !!c.env.ANTHROPIC_API_KEY,
    voicerxConfigured: !!c.env.VOICERX_TOKEN,
    dbConfigured: !!c.env.DB,
  });
});

app.get('/healthz', (c) => c.text('ok'));

// ---- Static assets (HTML/CSS/JS from the repo root) ----
// The [assets] block in wrangler.toml binds the parent directory at
// /, but for any path Hono doesn't know about we fall through to
// the ASSETS binding manually to serve the right file.
app.all('*', async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Not found', 404);
});

export default app;
