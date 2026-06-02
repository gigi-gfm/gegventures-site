# Clinic Studio Worker

Cloudflare Workers + D1 version of the Garcia Family Medicine clinic studio.
Replaces the Node/Express app in the repo root with an edge-deployed Worker.

## One-time setup

```bash
cd workers
npm install
wrangler login                       # opens browser to auth Cloudflare
wrangler d1 create clinic-studio     # prints a database_id
# paste the database_id into wrangler.toml under [[d1_databases]]

npm run db:migrate:remote            # creates the tables (later stages)

# Set the secrets (one per command — wrangler prompts for the value):
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put ADMIN_EMAIL
wrangler secret put ADMIN_PASSWORD
wrangler secret put ADMIN_NAME
wrangler secret put SESSION_SECRET   # any random 32+ char string
wrangler secret put VOICERX_TOKEN

npm run deploy
```

## Local development

```bash
cd workers
npm install
wrangler d1 execute clinic-studio --local --file=./migrations/0001_init.sql
wrangler dev
```

Opens at http://localhost:8787.

## Stage roadmap

This Worker is being built in stages, each landing in its own commit:

1. ✅ Scaffold (this commit) — Hono + assets fallback
2. ⏳ Schema — D1 migrations
3. ⏳ Auth — login, sessions, password hashing
4. ⏳ Cases CRUD
5. ⏳ Time tracker
6. ⏳ AI endpoints
7. ⏳ VoiceRx proxy
8. ⏳ Static assets verified end-to-end
9. ⏳ Deploy + custom domain
