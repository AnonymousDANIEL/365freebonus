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

After signing in, use **更改密码** in the dashboard sidebar. Enter the current password, then a new password of 12–128 characters twice. A successful change signs out every device and requires a new login. Only a salted scrypt hash is stored in the private persistent database, and it takes precedence over the bootstrap `ADMIN_PASSWORD_HASH` after the first change. Deployments do not reset it. Keep `SESSION_SECRET` unchanged so saved Telegram credentials remain readable. Recovery of a forgotten password requires an authenticated infrastructure operator; there is no public password-reset endpoint.

## Railway

The Dockerfile builds a standalone Next.js server with Node.js 24. Connect this repository to one Railway service, mount a persistent volume at `/data`, set `APP_URL` to the Railway or custom domain, and configure the admin variables. Use a single service replica with SQLite. `railway.json` configures `/api/health` and restart behavior. GitHub pushes to the connected branch trigger deployment.

The volume keeps brands, settings, sessions and login-rate limits across restarts and deployments. Back up the SQLite database using SQLite's online backup API before moving or replacing the volume.

## Content management

- **安全笔记** stores private editable records behind the administrator login and an independent 6–12 digit PIN. First use requires the current administrator password to set the PIN. Titles and note contents are encrypted in the private `/data` database. PIN unlock is remembered in the same browser across section changes, tab switches, refreshes and a later administrator login using the same credentials. It locks after 12 hours without real administrator activity. Visible notes are cleared when the tab hides or the section unmounts and are restored after checking server authorization. Passive status queries and background polling do not extend the timeout. Every notes request still requires an active administrator login; signing out, locking manually, or changing the administrator password revokes the remembered unlock. PIN attempts are rate limited, and changing the PIN revokes every notes unlock. Keep the PIN safe: there is no bypass reset. The former website auto-login menu, API and worker have been removed; migration 13 removed its saved account configuration; migration 14 replaces only temporary unlock sessions and preserves the PIN, encrypted notes, brands, settings and Telegram data.

- Add, edit or delete brands; upload is currently through a public image URL.
- Publish or hide entries, change display order and select homepage features.
- Use 弹窗公告 in the dashboard to upload a banner, set its click-through URL, and control its visibility and order. Enabled banners rotate every three seconds in a centered 2:1 frame on the homepage.
- Set a Malaysia date and time for a brand to enter Update or New. Saving a new time for a draft schedules its first public appearance without a second action. Already published brands stay in All until their promotion starts. The duration starts at the scheduled time.
- Connect @FreeBonus365Bot to a group or channel under Telegram 通知 in the dashboard sidebar. Channel bots need administrator permission to post. The running Node service checks the SQLite notification queue and sends when the promotion starts. Enabling notifications or switching destinations skips pending announcements for promotions that already started. Keep the service running for scheduled delivery and the same session secret for saved bot credentials.
- Edit the automatic promotion message using `{category}`, `{name}`, `{tagline}` and `{description}`. Leave it blank to use the default; brand descriptions are also appended to existing templates when absent. Notifications attach a brand-name button to the brand's directory page, 🌐 Visit website to the homepage, and 🚀 Join Now to its valid HTTP(S) brand link (omitted if empty or unsafe). The old `{link}` placeholder and the current brand-page URL no longer appear as raw text. Photo/GIF/file captions are shortened to Telegram's 1,024-character limit while retaining the media and buttons; text fallback is limited to 4,096 characters. The brand button opens the full description. This applies to future queued deliveries and does not resend historical notifications.
- Give @FreeBonus365ChatBot its own Token and administrator access to the target group for group welcomes and keyword replies. The ChatBot target can differ from the promotion destination. Use `{name}` and `{group}` in the join welcome text. Exact keyword matches take priority over the longest partial match. The ChatBot must have no webhook or other update receiver.
- Enable 1 对 1 私聊 to use the keyword rules in private chat. Each rule can be set to **按键关键字** (shown as a clickable private menu option and also matches typed messages) or **文字关键字** (typed matching only, with no reply buttons). The two lists are managed separately in the dashboard and a rule can be moved between them when edited. Existing rules remain button rules after migration 15. Use `/start` or `/menu` to receive the current menu; only button rules are included, and obsolete buttons for a rule changed to text-only are ignored. Members can start the bot at `https://t.me/FreeBonus365ChatBot?start=welcome`. With both private chat and welcome enabled, new group or channel members who have already contacted the bot receive a private welcome. Group newcomers can follow the Start button, and the channel's native welcome can include the same link. Use a group target when group keyword replies are enabled.
- When no custom keyword rule matches, the ChatBot searches published brands from the website's All list using a partial name or slug (2–100 letters/numbers, with case, spacing and punctuation ignored). Exact names take priority. A unique match returns the brand image, introduction and website/join buttons; multiple matches show up to eight brand choices and invite a narrower search. This works in enabled private chat and the configured group when group keywords are enabled. Hidden and future-published brands remain unavailable, and pending promotion labels are not revealed early. Brand callbacks recheck visibility and enabled settings before sending. A recognized brand search cancels the unmatched-message follow-up. Existing custom rules and chat commands retain priority.
- **私聊品牌更新通知** lets @FreeBonus365ChatBot send future Update/New brand announcements to customers who have already opened its private chat. It uses the same brand image, introduction, template and three website buttons as channel announcements, with its own dashboard switch and delivery counts. Enabling notifications never sends a historical backlog; scheduled brands are sent only after becoming public. Migration 17 enables this requested feature for an existing configured private ChatBot, preserving prior `/stop` opt-outs; other setups remain off until enabled. Each customer can send `/stop` to pause both brand notifications and unmatched-message follow-ups, and `/start` to resume future notifications. Ordinary messages and `/menu` do not silently re-subscribe an opted-out customer. Delivery is persistent, throttled and deduplicated; uncertain sends are not automatically repeated.
- **未识别消息自动跟进** can send one editable text follow-up in an existing ChatBot private conversation when the latest customer message did not match a keyword and remains unanswered for one hour. A newer customer message resets the timer; a recognized interaction or a later bot reply cancels the old pending message. Enable it with 1 对 1 私聊 and a follow-up message. Changes apply to new inbound messages, with old pending work cancelled. It uses persisted message IDs and timestamps, not message text, to track the last speaker. Follow-ups wait for a fresh, drained update poll; ambiguous delivery is not retried automatically. This tracks only messages received and sent by this bot, not separate staff accounts. Each unmatched message can trigger one follow-up, never an hourly loop. Users can send `/stop` to opt out and `/start` to resume.
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
