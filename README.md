# 365freebonus

A restrained purple and champagne-gold brand directory with an animated 3D-style cover, matching avatar, multilingual browsing, search, filters, saved brands and an independent admin dashboard.

The included brands are fictional demonstration content. The application contains no payment, wagering or bonus redemption system.

## Run locally

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

The public directory works without admin configuration. The dashboard requires administrator login at `/login`. The content database is stored in `.data/directory.sqlite` by default.

## Administrator configuration

Run `node scripts/create-admin.mjs` locally to generate a random password, scrypt password hash and session secret. Store the returned environment values in your deployment provider, and keep the password private. Never commit the output.

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Administrator username, normally `admin` |
| `ADMIN_PATH` | Optional dashboard path, one lowercase URL segment with a leading slash. Defaults to `/admin`. |
| `ADMIN_PASSWORD_HASH` | `scrypt$saltHex$hashHex`; 64-byte scrypt key |
| `SESSION_SECRET` | A random secret of at least 32 characters |
| `APP_URL` | Exact canonical origin for CSRF validation |
| `DATA_DIR` | Database directory; `/data` on Railway |
| `PORT` | HTTP port, normally `3000` |

If using `.env.local`, escape each `$` in the password hash as `\$` because Next.js expands dotenv variables. Railway variables store the raw value without escaping. `.env*`, database files, dependencies and generated builds are excluded from source control. Admin writes fail closed when authentication has not been configured.

## Railway

The Dockerfile builds a standalone Next.js server with Node.js 24. Connect this repository to one Railway service, mount a persistent volume at `/data`, set `APP_URL` to the Railway or custom domain, and configure the admin variables. Use a single service replica with SQLite. `railway.json` configures `/api/health` and restart behavior. GitHub pushes to the connected branch trigger deployment.

The volume keeps brands, settings, sessions and login-rate limits across restarts and deployments. Back up the SQLite database using SQLite's online backup API before moving or replacing the volume.

## Content management

- Add, edit or delete brands; upload is currently through a public image URL.
- Publish or hide entries, change display order and select homepage features.
- Set a Malaysia date and time for a brand to enter Update or New. Saving a new time for a draft schedules its first public appearance without a second action. Already published brands stay in All until their promotion starts. The duration starts at the scheduled time.
- Connect a Telegram bot and a group or channel under Telegram 通知 in the dashboard sidebar. Channel bots need administrator permission to post. The running Node service checks the SQLite notification queue and sends when the promotion starts. Enabling notifications or switching destinations skips pending announcements for promotions that already started. Keep the service running for scheduled delivery and the same session secret for saved bot credentials.
- Edit site name, headline, description, announcement and contact URL.
- Public saved brands and language preference are stored only in the visitor's current browser.
- `/login` uses HttpOnly signed session cookies, server-side revocation, scrypt password verification, same-origin checks and a persistent login rate limit.

## Brand assets

`public/brand/cover.webp` is the wide cover. `public/brand/avatar.webp` is the square avatar, also used as the favicon. Motion uses CSS floating, soft light and pointer tilt, with reduced-motion support. Original generated PNG artwork is kept separately from the optimized web assets.

## Checks

```sh
npm run typecheck
npm test
npm run build
```
