# Hiyo — say hi to the world 👋

Random 1-on-1 **video and text chat** with strangers from every corner of the planet — in the spirit of Omegle and
Monkey, rebuilt for a worldwide audience with safety, speed and 12 languages from day one.

> **Working name.** "Hiyo" is a placeholder brand — change it with one setting (`APP_NAME`). See
> [docs/DESIGN.md](docs/DESIGN.md) for the name shortlist and the full UI design system.

<p align="center">
  <img src="docs/screenshots/home-desktop.jpg" alt="Landing page: the name spelled out of hellos in many languages" width="45%">
  <img src="docs/screenshots/lobby-desktop.jpg" alt="Lobby: camera preview, video/text switch, interests and Start" width="45%">
</p>
<p align="center">
  <img src="docs/screenshots/chat-desktop.jpg" alt="Video chat on desktop" width="66%">
  <img src="docs/screenshots/chat-mobile.jpg" alt="Video chat on a phone" width="24%">
</p>
<p align="center">
  <img src="docs/screenshots/signin-desktop.jpg" alt="Sign in or create an account" width="45%">
  <img src="docs/screenshots/guidelines-dialog.jpg" alt="Community guidelines to accept once" width="45%">
</p>

**The journey:** landing page → **Start** → sign in (Google or email) → accept the community guidelines (once) →
lobby with your camera preview → **Start** → meet someone. Nobody is matched until they press Start in the lobby.

## Features

**Landing & sign-in**
- ✨ Intro animation: hellos in 30+ languages float in and fly together to spell the brand name (respects reduced motion)
- 🃏 Rich landing page: illustrated cards band, desktop + phone showcase, how it works, safety, interests & flags, FAQ
- 🔐 **Sign in with Google** or **email & password** before chatting — throwaway trolls can't just reload, and bans stick to the account
- ✅ **Community guidelines** (18+, Terms, Privacy, Guidelines) accepted once per account, versioned so you can ask again after changes
- 🎛️ **Lobby** like a video call's pre-join screen: camera preview, Video/Text switch, interests, language filter, Start

**Chat**
- 🎥 Peer-to-peer **video** (WebRTC) and **text-only** mode, side-by-side text chat with typing indicator & quick replies
- ⚡ Instant matching; **interests** first (people who share the most tags), then random after a few seconds — like Omegle
- 🌐 **Cross-language interests**: “Music”, “Música” and “音楽” are the same tag, so people match across languages
- 🗣️ Optional **“only people who speak my language”** filter
- 🏳️ Stranger's **country flag** (renders on Windows too) — from Cloudflare/Vercel/CloudFront geo headers or the device time zone
- 👉 **Swipe to skip** on phones, **Esc** on desktop, auto-find-next, switch camera, device picker
- 🎙️ Camera & mic are requested once and stay on during video chat — like Monkey, no mute/camera-off buttons
- 📱 Mobile-first split-screen layout, desktop layout with picture-in-picture, installable PWA

**Worldwide**
- 🌍 **12 languages**, server-rendered (instant, SEO-indexed `/es`, `/hi`, `/ar`… with `hreflang`):
  English, Español, Português, Français, Deutsch, العربية (RTL), हिन्दी, Bahasa Indonesia, Türkçe, Русский, 日本語, 简体中文
- Auto-detects the browser language; remembers manual choice
- Low-bandwidth defaults (640×480, capped bitrate) for mobile networks; WebSocket with HTTP long-polling fallback for restrictive networks
- STUN + **TURN** support (self-hosted coturn, any provider, or Cloudflare's global TURN) so strict NATs and mobile carriers connect

**Safety** (the reason Omegle shut down in 2023 — take it seriously)
- Accounts + 18+ guidelines acceptance before anyone is matched; Terms, Privacy Policy and Community Guidelines pages
- **Report** button (also works for the person you *just* skipped); reported people are never re-matched with the reporter
- **Automatic temporary bans** after reports from several different people — on the account *and* the browser; bans survive restarts
- Video **blurs while you're reporting**; optional “blur new people until I tap”
- Links blocked in chat (anti-spam/scam), message cleaning, rate limits on everything
- Admin API to review reports (with the last messages of the reported chat), accounts, and ban/unban
- Strangers never see names or emails — only a country flag; passwords hashed with scrypt; no ads/trackers;
  IPs stored only as keyed hashes; optional `FORCE_RELAY` hides IPs from strangers
- Strict security headers (CSP with no inline scripts, no framing, camera/mic limited to the site), HttpOnly session cookies

## Quick start

Requires **Node.js 20.11+** (check with `node -v`).

**1. Get the code.** Until it's merged into `main`, the app lives on the `claude/beautiful-volta-k7nkqw` branch:

```bash
git clone -b claude/beautiful-volta-k7nkqw https://github.com/Amartyyaaa/live-cam.git
```

```bash
cd live-cam
```

No Git? On GitHub switch to that branch, click **Code → Download ZIP**, unzip it, and open a terminal *inside*
the unzipped folder.

**2. Install and start — inside the project folder** (the one that contains `package.json`):

```bash
npm install
```

```bash
npm start
```

> **Windows:** running `npm install` anywhere else — e.g. directly in `C:\Users\<you>` — fails with
> `EPERM: operation not permitted`. Keep the project in a plain folder such as `C:\dev\live-cam`
> (OneDrive-synced folders and antivirus "controlled folder access" can also block npm).

Open http://localhost:3000 in two different browsers (or one normal + one private window). In each one: click
**Start video chat**, choose **Create account** (any made-up email works locally), tick both boxes and
**Agree all & continue**, then press **Start video chat** in the lobby.
Cameras need a secure context: `localhost` works; anything else needs **HTTPS**.

**Updating** an existing copy: stop the server (Ctrl+C), then inside the project folder:

```bash
git pull
```

```bash
npm install
```

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

## How it works

```mermaid
sequenceDiagram
    participant A as Browser A
    participant S as Server (Node.js + Socket.IO)
    participant B as Browser B
    A->>S: find {mode, interests, language}
    B->>S: find {mode, interests, language}
    S-->>A: matched (you create the offer)
    S-->>B: matched
    A->>S: SDP offer + ICE candidates
    S->>B: relayed (validated, same pair only)
    B->>S: SDP answer + ICE candidates
    S->>A: relayed
    A--)B: video & audio, peer-to-peer (or via TURN relay)
    A->>S: chat message
    S->>B: relayed (cleaned, rate-limited, links blocked)
```

Video and audio **never pass through the app server** — it only introduces people and relays small messages, so one
modest server can host thousands of simultaneous users. The only heavy traffic is TURN relaying for users who can't
connect directly.

## Configuration

Everything is set with environment variables — see [`.env.example`](.env.example) for the full, commented list.

| Variable | Default | What it does |
|---|---|---|
| `APP_NAME` | `Hiyo` | Brand name on every page, title and the PWA manifest |
| `PUBLIC_URL` | — | Your site URL (canonical / hreflang / social links, allowed origin) |
| `CONTACT_EMAIL` | `support@example.com` | Shown on legal pages — **set it** |
| `REQUIRE_SIGN_IN` | `true` | Sign in + accept the guidelines before chatting (`false` = anonymous, 18+ dialog only) |
| `GOOGLE_CLIENT_ID` | — | Turns on **Continue with Google** (see [Accounts & sign-in](#accounts--sign-in)) |
| `ALLOW_EMAIL_SIGNUP` | `true` | Email + password accounts |
| `SESSION_DAYS` | `30` | How long people stay signed in |
| `AUTH_ATTEMPTS_PER_MINUTE` | `10` | Sign-in attempts per IP per minute |
| `SERVER_SECRET` | saved in `DATA_DIR/.secret` | Signs session cookies and keys the IP hashes — keep it stable and secret |
| `ADMIN_TOKEN` | — | Enables the admin API |
| `TURN_URLS` + `TURN_SECRET` | — | Your coturn server (time-limited credentials) |
| `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` | — | Use Cloudflare's TURN instead |
| `CLIENT_IP_HEADER` | — | e.g. `cf-connecting-ip` when the site sits behind Cloudflare |
| `TRUST_PROXY` | private networks | Which proxies may set `X-Forwarded-For` |
| `REPORT_THRESHOLD` / `BAN_HOURS` / `IP_BAN_HOURS` | `3` / `24` / `1` | Auto-ban policy |
| `BLOCK_LINKS` | `true` | Refuse chat messages containing links |
| `FORCE_RELAY` | `false` | Send all media through TURN (hides IPs; costs bandwidth) |
| `DATA_DIR` | `./data` | Where `users.json`, `bans.json` and `reports.jsonl` live — back it up |

## Accounts & sign-in

Before anyone is matched they must be signed in and have accepted the community guidelines; the server enforces this
too, not just the page.

- **Email & password** accounts are stored in `DATA_DIR/users.json` with scrypt-hashed passwords. There is **no email
  verification or password reset yet** (both need an email provider). For a public launch either add them, or set
  `ALLOW_EMAIL_SIGNUP=false` and offer Google sign-in only.
- **Continue with Google** — create a client ID (free):
  1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → OAuth consent screen**: set it up
     (app name, support email; the default scopes are enough).
  2. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
  3. Under **Authorized JavaScript origins** add `http://localhost:3000` and `http://localhost` for testing, plus your
     real site, e.g. `https://hiyo.example`.
  4. Set `GOOGLE_CLIENT_ID=<the id>.apps.googleusercontent.com` and restart. The sign-in page then shows the Google
     button, with email under **More sign-in options**.

  The server checks Google's signature, audience and expiry on every sign-in itself — no client secret or SDK needed.
- **Sessions** are an HttpOnly, SameSite cookie signed with `SERVER_SECRET`, valid for `SESSION_DAYS`.
- **Guidelines** acceptance is stored per account with a version number (`GUIDELINES_VERSION` in `server/users.js`):
  bump it after changing the rules and everyone is asked again.
- Strangers only ever see a country flag — never a name, email or photo.

## Deploying

The app is a single Node.js process with no database. Anything that runs Node and supports WebSockets works:
**Render, Railway, Fly.io, DigitalOcean App Platform, a VPS…**

### Docker

```bash
docker build -t hiyo .
```

```bash
docker run -d -p 3000:3000 -v hiyo-data:/data --env-file .env --name hiyo hiyo
```

### VPS with automatic HTTPS (Caddy)

```caddyfile
hiyo.example {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy gets a Let's Encrypt certificate automatically and forwards WebSockets. The default `TRUST_PROXY` already trusts a
proxy on the same machine.

### Put Cloudflare in front (recommended for a worldwide audience)

Free DDoS protection, a global edge network, and the `CF-IPCountry` header gives exact visitor countries for the flags.
WebSockets are supported out of the box. Set `CLIENT_IP_HEADER=cf-connecting-ip` and allow only
[Cloudflare's IP ranges](https://www.cloudflare.com/ips/) to reach your server, so nobody can fake that header.

### TURN server — don't skip this

Without TURN, roughly 10–20% of people (strict NATs, many mobile carriers, corporate networks) will see “Couldn't
connect”. Options:

1. **Self-hosted [coturn](https://github.com/coturn/coturn)** on a small VPS with good bandwidth:

   ```ini
   # /etc/turnserver.conf
   listening-port=3478
   tls-listening-port=5349
   fingerprint
   use-auth-secret
   static-auth-secret=<same value as TURN_SECRET>
   realm=turn.hiyo.example
   cert=/etc/letsencrypt/live/turn.hiyo.example/fullchain.pem
   pkey=/etc/letsencrypt/live/turn.hiyo.example/privkey.pem
   no-cli
   no-multicast-peers
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   ```

   Then set `TURN_URLS=turn:turn.hiyo.example:3478?transport=udp,turn:turn.hiyo.example:3478?transport=tcp,turns:turn.hiyo.example:5349?transport=tcp` and `TURN_SECRET`.
   For global users, run a few TURN servers in different regions.
2. **Cloudflare Realtime TURN** — anycast across Cloudflare's network; set the two `CLOUDFLARE_TURN_*` variables.
3. **Any TURN provider** with static credentials (`TURN_USERNAME` / `TURN_CREDENTIAL`).

## Moderation & admin API

Reports are kept in memory and appended to `DATA_DIR/reports.jsonl`; bans are saved to `DATA_DIR/bans.json`.
Set `ADMIN_TOKEN` to enable:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://hiyo.example/api/admin/reports?limit=50
```

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://hiyo.example/api/admin/users?limit=50
```

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"u:<userId from a report>","hours":720,"reason":"nudity"}' \
  https://hiyo.example/api/admin/bans
```

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://hiyo.example/api/admin/bans/u:<userId>
```

Ban keys are `u:<userId>` (an account), `c:<clientId>` (one browser) or `i:<ipHash>` (a network — use sparingly;
many people can share one IP).

## ⚠️ Before you launch publicly

Anonymous video chat with strangers attracts abuse. Omegle shut down in November 2023 after 14 years, its founder citing
the cost of fighting misuse. Plan for it from day one:

- [ ] **HTTPS** everywhere and a **TURN** server
- [ ] Set `SERVER_SECRET`, `ADMIN_TOKEN`, `CONTACT_EMAIL`, `PUBLIC_URL`; mount a persistent, backed-up `DATA_DIR`
- [ ] Set up **Google sign-in**, and add email verification + password reset or turn email sign-up off
- [ ] **Have a lawyer review** the Terms, Privacy Policy and Guidelines (in `server/views/docs/`) for every market you
      target, and translate them. Laws that may apply include the EU Digital Services Act and GDPR, the UK Online Safety Act,
      US federal law requiring providers to report child sexual abuse material to NCMEC, Australia's Online Safety Act,
      India's IT Rules and DPDP Act, and Brazil's LGPD
- [ ] Decide on **age assurance**: a checkbox is the bare minimum, and regulators increasingly expect more
- [ ] Add **automated content moderation** for video and text (e.g. periodic frame sampling to a nudity/CSAM
      classifier, hash-matching services) plus a **human review** workflow for reports and appeals
- [ ] Watch `/healthz`, back up `DATA_DIR`, and review `reports.jsonl` daily

## Scaling

- **One instance** comfortably handles thousands of concurrent users (signalling is tiny; media is peer-to-peer).
- **Several instances**: the matchmaking queue lives in memory. Move it to Redis (the `Matchmaker` class is pure
  and isolated for exactly this) and add the Socket.IO Redis adapter, with sticky sessions for the polling fallback.
  Accounts live in one JSON file (`UserStore`): move them to a database such as PostgreSQL at the same time.
- **Bandwidth** goes almost entirely to TURN: budget roughly 0.5–1 Mbps per relayed participant.

## Languages

Each language is one JSON file in [`locales/`](locales). To add one:

1. Copy `locales/en.json` to `locales/<code>.json` (e.g. `vi.json`) and translate the values. Keep `{placeholders}` and
   the `*star*` around the highlighted word in `hero.title`. Missing keys fall back to English.
2. For right-to-left scripts, add the code to `RTL` in `server/render.js` (Arabic, Persian, Hebrew and Urdu are already listed).
3. Restart — the page appears at `/<code>`, in the language menu, the sitemap and `hreflang` tags.

## Renaming the brand

Set `APP_NAME` — the intro animation spells whatever name you choose. The logo is two overlapping circles (you + a stranger) drawn in code: its colours are the `--brand`,
`--violet` and `--sun` tokens in `public/css/app.css`; update `public/favicon.svg` and run `npm run gen:images` to rebuild
the PNG icons and the social-preview image.

## Testing

```bash
npm test
```

Unit and integration tests: matchmaking, moderation, sanitising, TURN credentials, geo, accounts (password hashing,
sessions, Google token checks, guidelines), real Socket.IO clients against the real server, HTTP security headers,
admin API.

```bash
npm run test:e2e
```

End-to-end: real Chromium browsers with fake cameras go through the whole journey on the real server — intro,
sign-up, guidelines, lobby, matching, peer-to-peer video, chat, link blocking, skipping, reporting & account bans,
sign out / sign in, text mode, RTL and the back button. Needs Playwright
(`npm i -D playwright && npx playwright install chromium`).
`npm run screenshots` regenerates `docs/screenshots/`; `npm run gen:landing` redraws the landing-page illustrations.

## Project structure

```
server/
  index.js          entry point (config, start, graceful shutdown)
  app.js            wires HTTP + Socket.IO + chat
  chat-server.js    sessions, pairing, signalling & message relay, reports
  matchmaker.js     the matching queue (pure, unit-tested)
  moderation.js     reports, strikes, bans, persistence
  auth.js           sign-in API, session cookies, Google ID-token checks
  users.js          accounts store (scrypt passwords, guidelines acceptance)
  web.js            pages, security headers, admin API
  render.js         server-side i18n templating
  ice.js geo.js sanitize.js rate-limit.js client-ip.js config.js
  views/            HTML templates (+ legal docs)
public/
  js/               browser modules: main (screens), intro (word-cloud animation), account (sign-in &
                    guidelines), lobby, camera, chat, peer (WebRTC), media, i18n…
  img/              landing-page illustrations and device mockups
  css/app.css       the design system
  fonts/ icons/     self-hosted fonts, Lucide icon sprite, app icons
locales/            one JSON file per language
scripts/            e2e test, screenshots, asset generators
test/               node:test suites
docs/               design system, screenshots
```

## Credits

[Socket.IO](https://socket.io) & [Express](https://expressjs.com) (MIT) ·
[Lucide](https://lucide.dev) icons (ISC) ·
[Bricolage Grotesque](https://github.com/ateliertriay/bricolage) (OFL) ·
flag font from [country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) with
[Twemoji](https://github.com/twitter/twemoji) artwork (CC-BY 4.0). See [`public/fonts/LICENSES.md`](public/fonts/LICENSES.md).
The illustrated people are original drawings generated by `scripts/gen-landing-assets.cjs`.
