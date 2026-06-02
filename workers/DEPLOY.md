# Clinic Studio Worker — Deployment Guide

End-to-end deployment of the Cloudflare Workers + D1 version of the
clinic studio. After this is done, the app runs at the edge on
Cloudflare and no longer depends on Gigi's laptop.

## What you'll end up with

- A Cloudflare Worker named `clinic-studio` serving the IME Studio,
  Cases dashboard, Referrals, RTW, and Users admin
- A D1 database named `clinic-studio` storing users, sessions, cases,
  time entries, timers
- A custom domain like `ime.gegventures.com` (optional but recommended)
- All secrets (Anthropic API key, admin password, VoiceRx token) stored
  in Worker Secrets, not in any file

## Prerequisites

- A Cloudflare account (free tier is fine)
- Wrangler CLI installed locally (`npm install -g wrangler` if you
  don't have it)
- Your Anthropic API key
- Your VoiceRx provider token

## One-time setup

```bash
# 1. Authenticate with Cloudflare (opens browser).
wrangler login

# 2. Install Node deps for the Worker.
cd workers
npm install

# 3. Create the D1 database. This prints a database_id — copy it.
wrangler d1 create clinic-studio
# Output looks like:
#   ✅ Successfully created DB 'clinic-studio'
#   [[d1_databases]]
#   binding = "DB"
#   database_name = "clinic-studio"
#   database_id = "abcdef12-3456-7890-...."

# 4. Open wrangler.toml and paste the database_id into the
#    [[d1_databases]] block (replacing REPLACE_WITH_DATABASE_ID_...).

# 5. Run the initial schema migration on the remote D1.
npm run db:migrate:remote
# This creates the users, sessions, cases, time_entries, timers tables.

# 6. Set the secrets. Each command prompts for the value:
wrangler secret put ANTHROPIC_API_KEY   # sk-ant-...
wrangler secret put ADMIN_EMAIL         # your admin login email
wrangler secret put ADMIN_PASSWORD      # min 8 chars
wrangler secret put ADMIN_NAME          # display name
wrangler secret put VOICERX_TOKEN       # the 64-char hex string

# 7. Deploy.
npm run deploy
# Wrangler prints:
#   ✨ Compiled Worker successfully
#   Uploaded clinic-studio (X.Y sec)
#   Published clinic-studio (X.Y sec)
#     https://clinic-studio.<your-subdomain>.workers.dev
```

Test the deployed URL: visit
`https://clinic-studio.<your-subdomain>.workers.dev/setup.html`. If
no users exist yet, you'll see the setup form. Otherwise visit
`/login.html` and sign in with the admin credentials you set.

## Local development against D1 (optional)

```bash
cd workers
wrangler d1 execute clinic-studio --local --file=./migrations/0001_init.sql
wrangler dev
# Opens at http://localhost:8787 with a local D1 mirror.
```

The local `.dev.vars` file (gitignored) can hold secrets for local dev:
```
ANTHROPIC_API_KEY=sk-ant-...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
ADMIN_NAME=...
VOICERX_TOKEN=...
```

## Custom domain (recommended)

Once the Worker is live and tested at the `.workers.dev` URL:

1. In the Cloudflare dashboard, go to **Workers & Pages →
   clinic-studio → Settings → Triggers → Custom Domains**.
2. Click **Add Custom Domain**.
3. Enter `ime.gegventures.com` (or whatever subdomain you prefer).
4. Cloudflare auto-creates the DNS record if `gegventures.com` is
   already on Cloudflare DNS.
5. Wait ~30 seconds for the TLS cert to provision.

After that, the studio is at `https://ime.gegventures.com/` and
`https://ime.gegventures.com/cases.html` etc.

## Rotating the admin password

There's no built-in password change yet. To rotate:

```bash
# 1. Update the secret.
wrangler secret put ADMIN_PASSWORD

# 2. Manually delete the existing admin user from D1 (forces re-bootstrap
#    on next request).
wrangler d1 execute clinic-studio --remote \
  --command "DELETE FROM users WHERE email = 'your-admin-email@example.com';"

# 3. Visit any /api/ URL to trigger ensureBootstrapped() — a new admin
#    with the new password is created automatically.
```

## Troubleshooting

- **"D1 not bound"** → check `[[d1_databases]]` in wrangler.toml; the
  `database_id` value must be the real one from `wrangler d1 create`.
- **"VoiceRx integration not configured"** → run
  `wrangler secret put VOICERX_TOKEN` and redeploy.
- **Login returns 401 with the right password** → the admin was
  bootstrapped with a different password. Follow "Rotating the admin
  password" above.
- **Static HTML pages 404** → the `[assets]` block in wrangler.toml
  must point at `directory = "../"` (the repo root) since that's where
  login.html, ime-studio.html, etc. live.

## Monitoring

In the Cloudflare dashboard:

- **Workers & Pages → clinic-studio → Logs** — live tail of console.log
  output and errors
- **Workers & Pages → clinic-studio → Metrics** — request volume, CPU
  time, errors
- **D1 → clinic-studio → Console** — run ad-hoc SQL queries
