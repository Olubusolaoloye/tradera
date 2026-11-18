# Tradera

**Plan it. Wait for it. Log it.**

Tradera is a private trading journal, setup watchlist and entry-price alerting app.
Myfxbook-style trade documentation with no account, no broker connection and no tracking.

It runs two ways with the same code:

- **Locally** — one Node file, no cloud, data in `data/db.json`.
- **Online on Netlify** — static frontend + serverless API + Netlify Blobs + scheduled price checks.

| Area | What it does |
| --- | --- |
| **Journal** | Entry, stop, target, exit, size, risk, fees, tags and notes. Closed trades produce P&L, R multiples, win rate, profit factor, expectancy, drawdown, an equity curve and a monthly breakdown. |
| **Priority watchlist** | Planned setups ranked by pair priority, setup priority, then distance to entry. |
| **Entry alerts** | Fires once when price comes within a setup's alert distance; re-arms after price moves 1.6× that distance away. |
| **Push delivery** | In-app toasts, browser notifications, free ntfy phone push, or a Telegram bot. |
| **Overview** | A plain-English brief ("EURUSD is 6.0 pips from entry"), balance, six key stats, a setup checklist for new users and live market-session status (Sydney, Tokyo, London, New York). |
| **Price runway** | Every watched setup shows a bar that fills as price closes in on the entry, with live prices that flash green or red on each tick. |
| **Mobile** | Bottom tab bar, compact header, card-style tables, bottom-sheet forms, 16px inputs and safe-area support. Installable as a PWA. |
| **Comfort** | Dark and light themes (follows your device by default), keyboard shortcuts (`N` new trade, `S` new setup, `1`–`6` switch views) and in-app confirmations for anything destructive. |

## Run locally

Requires [Node.js](https://nodejs.org) 18 or newer. The local server has **zero runtime dependencies**.

On Windows, double-click **`start.cmd`**. Or:

```powershell
cd tradera
node server.js
```

Open <http://127.0.0.1:4173>. Data is saved to `data/db.json` and created on first run.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Keep it local unless you add auth and HTTPS. |
| `NO_OPEN` | unset | Set to `1` to stop the browser opening automatically. |
| `DATA_DIR` | `./data` | Folder for `db.json`. Point a second copy somewhere else to test without touching your real journal. |

Local mode uses Server-Sent Events for instant quote and alert updates.

## Deploy to Netlify

### 1. Push the `tradera` folder to a Git repo

Netlify builds from Git (drag-and-drop deploys do not include scheduled functions). If you use the Netlify CLI you can also run `netlify deploy --prod` from the folder.

### 2. Create the site

In Netlify: **Add new site → Import an existing project**, pick the repo, then set:

| Setting | Value |
| --- | --- |
| Base directory | `tradera` (omit if the repo root *is* this folder) |
| Build command | leave empty |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |

`netlify.toml` already declares those paths, so Netlify should detect them.

### 3. Accounts and environment variables

On Netlify, Tradera uses **email + password accounts**. Anyone who opens the site can
create an account, and every account gets its own private journal, setups, alerts and
settings. Logins last 30 days per device. There is no password reset by email, so keep
your password safe (you can change it in **Settings → Account** while logged in).

**Site configuration → Environment variables** (all optional):

| Key | Purpose |
| --- | --- |
| `TRADERA_SIGNUPS` | `closed` stops new sign-ups; existing accounts keep working. |
| `TRADERA_ACCOUNTS` | `off` goes back to the old single-user mode (one journal, app password or `DESK_PASSCODE`). |
| `DESK_PASSCODE` | Single-user mode only: shared passcode and master key. |
| `DESK_STORE` | Netlify Blobs store name. Default `trading-desk` (kept from before the Tradera rename so existing sites keep their data). |

**Moving an existing journal into an account.** If the site already had a journal from
before accounts, the sign-up screen asks for that journal's current password. Enter it
and the journal, setups and alert settings move into the new account. This works once;
a copy of the old data is kept at `backup/db-before-accounts.json` in the Blobs store.

### 4. Data storage

Online data is stored in **Netlify Blobs** (free tier), with strong consistency so a
read right after a save always sees it. Nothing needs provisioning.

| Key | Holds |
| --- | --- |
| `accounts/users/<hash>.json` | one per email: password hash (scrypt), sign-in version |
| `accounts/db/<id>.json` | that account's journal, setups, alerts and settings |
| `accounts/meta.json` | token signing secret |

Every save is conditional on the version that was loaded, so a phone and a laptop (or
the price checker and you) can never overwrite each other's changes. Export a JSON
backup from **Settings** before changing deployments.

### 5. Scheduled price checks

`netlify/functions/poll.mjs` is wired in `netlify.toml` to run every 2 minutes:

```toml
[functions."poll"]
  schedule = "*/2 * * * *"
```

That function fetches quotes, evaluates entry alerts and sends ntfy/Telegram push for
every account while nobody is on the site. It checks four journals at a time and stops
before the 30-second scheduled-function limit, which comfortably covers a few dozen
accounts; beyond that, prices for the remaining accounts refresh when they open the app. Change it to `*/5 * * * *` to reduce free-tier usage. Scheduled
functions are not exposed as HTTP endpoints.

The browser falls back to polling `/api/state` every 60 seconds when realtime SSE is not
available. New alert IDs are deduplicated so you never get the same toast twice.

### Netlify limits worth knowing

- Serverless functions cannot keep a timer or an SSE connection open. That is why online
  mode polls on a schedule and the page polls while open.
- Netlify Blobs is eventually consistent. Two simultaneous writers could overwrite each
  other; this is a single-user desk, so that trade-off is intentional.
- Yahoo Finance is unofficial and may rate-limit cloud IPs. If online prices stop, add a
  free **Twelve Data** key in Settings and switch the feed. Twelve Data polling is forced
  to 60 seconds or slower.
- Browser notifications need the tab open. ntfy or Telegram reach your phone even when it
  is closed, as long as the deployed function is running.

## Price feeds

TradingView has **no public price API**, so Tradera cannot read TradingView prices directly.
Unofficial scrapers break TradingView's terms and stop working without warning. Instead:

1. **Deriv** (default, recommended): live **bid and ask** for forex, gold, silver, platinum and
   major indices (US 30, US Tech 100, US 500, Germany 40, UK 100, Japan 225…) from Deriv's public
   market-data API. No account, no key. Needs Node.js 22 or newer (local and on Netlify).
2. **OANDA**: live bid and ask from a free OANDA demo account, where OANDA operates. Create a token
   under **Manage API Access**, paste it into **Settings → Price feed** and choose *OANDA*.
3. **Binance**: exact live crypto prices (BTC, ETH, SOL…), no key. On by default for crypto.
4. **Yahoo Finance**: no key, used as the automatic backup for anything the sources above
   can't price. Gold and silver come from gold-api.com spot.
5. **Twelve Data** with your own free API key. Polling is forced to 60s or slower.
6. **Demo feed**: random walk for offline testing.

Alerts use the side of the book your order would fill on: **long setups are judged on the ask,
shorts on the bid**. Market cards show the live spread when the feed provides it.

If a source fails, its markets fall back to Yahoo and an orange note appears on the Overview.
If every source fails, a red badge appears and entry alerts pause until prices return.

### Markets you can watch

**Markets** has one-click **Add a group** buttons:

| Group | Markets | Priced by |
| --- | --- | --- |
| Forex majors | EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, NZDUSD | Deriv |
| Forex minors | All 21 crosses (EURGBP, GBPJPY, AUDNZD…) | Deriv; CADJPY, CADCHF, CHFJPY, NZDCAD and NZDCHF via Yahoo |
| Metals | XAUUSD, XAGUSD | Deriv |
| Stock indices | US30, NAS100, SPX500, GER40, UK100, JP225 | Deriv |
| Crypto | BTCUSD, ETHUSD | Binance |
| Volatility indices | V10, V25, V50, V75, V100 (`R_10`…`R_100`) and the 1-second versions V10–V100 (1s) (`1HZ10V`…`1HZ100V`) | Deriv |
| Step indices | Step 100–500 (`STPRNG`…`STPRNG5`) | Deriv |

Deriv synthetics trade 24/7 and are always priced by Deriv, whichever feed you choose. Alert
distances on synthetics are in **points**: 1.0 price unit on Volatility indices and 0.1 (one step)
on Step indices. TradingView does not chart synthetics, so their chart button points you to Deriv.
Deriv prices every market in a single request per check, so a large watchlist stays well inside
Deriv's rate limits.

## Set up pairs and alerts

1. Open **Pairs**. Add instruments such as `EURUSD`, `GBPUSD`, `USDJPY`, `XAUUSD`,
   `BTCUSD`. Mark important ones **Priority**; use **Live** to pause monitoring.
2. Open **Setups → New setup**. Add pair, direction, entry, stop, target, alert distance,
   priority and an optional label/note.
3. The setup appears under **Monitoring** and on **Dashboard → Priority watchlist**.
4. Every price check compares live price with each watching setup. When price is within
   the alert distance you get an alert; at the entry the message becomes **ENTRY REACHED**.
5. Press **Trigger** on a setup to open a prefilled trade. Saving marks it triggered;
   closing the trade marks the setup done.

### ntfy phone push (free, recommended)

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), [iOS](https://apps.apple.com/us/app/ntfy/id1625396347)).
2. In **Settings → Push notifications**, press **Generate** for a private topic.
3. Save, then subscribe to that exact topic in the ntfy app.
4. Press **Send test alert** to confirm.

### Telegram messages (optional)

Create a bot with [@BotFather](https://t.me/BotFather), paste its token into Settings, then fill in your chat ID
by pressing **Find** next to the chat ID field once you have pressed Start in your bot.

### Phone calls on entry (optional)

Telegram bots can't place voice calls, so Tradera uses the free **CallMeBot** service. It rings
your Telegram and reads the alert aloud.

1. In Telegram, send `/start` to **@CallMeBot_txtbot** once to allow calls. Your Telegram
   username must be public.
2. In **Settings → Notifications**, enter your `@username` under *Call me on Telegram* and save.
3. Press **Test call**.

Calls ring when price reaches an entry; tick *Also call when price is getting close* for more.
CallMeBot is a free third-party service with no uptime guarantee, so keep ntfy or Telegram
messages on too. Entry alerts on ntfy are sent as **urgent**, which sounds through Do Not Disturb
on Android.

## Paste or upload a setup

On **Setups** (or the dashboard) tap **Paste or upload**. Paste a signal, for example
`XAUUSD BUY LIMIT 2345 SL 2338 TP1 2352 TP2 2360`, or add or paste a screenshot. Tradera reads
the pair, direction, entry, stop and target (several setups in one paste work too), shows them
for you to check and fix, and **Start watching** puts them on watch with alerts.

- Text and screenshots of written signals (Telegram, WhatsApp…) are read for free; screenshot
  text is read on the device with Tesseract.js.
- Chart screenshots with only drawn lines need the optional AI chart reader: add
  `ANTHROPIC_API_KEY` (your own key from console.anthropic.com) to the site's environment
  variables on Netlify, or to the environment before `node server.js`. It uses Claude Opus 5.5
  (change it with `TRADERA_AI_MODEL`), and each chart read is billed to that key.
- Reading chart pictures with AI is a **Pro** feature on the online (accounts) version.

## Finished setups and the journal

After price reaches a setup's entry, Tradera keeps watching it. When the stop or the target is
hit, the setup moves to **Finished**, you get a "Setup finished" alert, and Setups and the
dashboard ask **Did you take it?** **Yes, log it** opens the trade form already filled in
(entry, stop, exit, open and close times); **No, I didn't** clears the prompt. A target reached
before the entry ever filled is marked **missed**. Setups you invalidate yourself ask too.
Prices are checked every 2 minutes online, so a quick wick between checks can be missed.

## Pushover alarm (recommended for entries)

Pushover rings entry alerts as an alarm that sounds through silent mode and Do Not Disturb
and repeats every 30 seconds for 10 minutes until tapped. Each user pays Pushover once ($5,
30-day free trial) and pastes their **User Key** in Settings → Notifications.

Site owner, once: create a free application at pushover.net → *Create an Application/API
Token* and add the token to Netlify as `PUSHOVER_APP_TOKEN`. The free allowance is 10,000
messages a month for the whole site; Pushover sells more if you outgrow it. Until the token is
set, each user can paste their own app token instead.

## Pro accounts

Until payments are added, give an account Pro from the admin dashboard (Users → Make Pro, or
the Pro list), or by listing its email in the Netlify variable `TRADERA_PRO_EMAILS` (comma
separated). Pro today: reading chart pictures with AI. Planned: real phone calls (Twilio).

## Admin dashboard

`https://<your-site>/admin/` (online version only). From there you can switch features on and off
for everyone, close the app for maintenance, show an announcement banner, manage the Pro list,
make accounts Pro, sign people out, disable or delete accounts, and read the activity log.

**Set it up once (Netlify → Site configuration → Environment variables), then redeploy:**

1. `TRADERA_ADMIN_EMAILS`: the email(s) of the admin accounts, comma separated. Sign up in the
   app with that email first.
2. Optional, `TRADERA_ADMIN_SETUP_CODE`: a long random secret you make up. When set, it is also
   asked for the first time an admin connects an authenticator app, so a stolen password alone
   can't connect a different phone. Without it, the password is enough for that first step, so
   connect your phone straight away.
3. Open `/admin/`, sign in with the email and password, add Tradera to an authenticator app
   (Google Authenticator, Authy, 1Password…), type its code, and save the 8 recovery codes.

**How it is protected**

- Admin sign-in needs the password **and** a 6-digit code (or a one-time recovery code); a code
  can't be used twice. The 2-step secret is stored encrypted; recovery codes only as hashes.
- 3 wrong admin attempts lock that email for 15 minutes (doubling up to a day); 5 from one IP lock
  the IP. Every attempt, success and change is in the activity log with the IP.
- Admin sessions are separate from app logins, last 2 hours (15 minutes idle), live only in that
  browser tab, are sent in a header (not a cookie), and end on sign-out, password change, or
  removal from `TRADERA_ADMIN_EMAILS`.
- Admin passwords (12+ characters) can only be changed in the dashboard, with the current
  password and a fresh code; that signs the account out everywhere. Deleting a user needs their
  email typed and a fresh code. Admins can't be disabled or deleted from the dashboard.
- The page allows only its own scripts and styles (strict Content-Security-Policy), can't be framed,
  is never cached or listed by search engines, and isn't stored by the app's offline cache.

**App logins are hardened too:** wrong passwords are limited per email (5 → lockout, growing) and per
IP (20 across all accounts), stored so the limits hold on every server; unknown emails get the same
answer; at most 5 sign-ups per IP per hour; new passwords need 10+ characters and can't be common
ones or contain the email; wrong "current password" tries when changing a password or deleting an
account are limited; and disabled accounts are signed out at once.

## Chart check reminders

**Alerts → Chart check reminders** nudges you to open your charts on a schedule: every
30 minutes to 12 hours, between a first and last time, on the days you pick, in your
device's time zone. Reminders go out through ntfy, Telegram and browser alerts (never a
phone call) and list the setups closest to entry. Online, the 2-minute scheduled check
sends them even when the app is closed.

**On an iPhone** (websites cannot write to Apple's Reminders app directly):

- **Calendar subscription:** *Add to iPhone Calendar* subscribes to
  `/api/reminders/calendar.ics`, a repeating event with an alert for every check. Turn
  off "Remove Alerts" for the subscribed calendar so the alerts ring.
- **Reminders app:** an Apple Shortcut reads `/api/reminders/today.json` (today's
  remaining checks) and adds each one to a *Tradera* list with an alert. A daily
  Shortcuts automation runs it every morning. The steps are in the app.

Both links carry a private key instead of a login; *make new links* in the app revokes
the old ones.

## Install on your phone

Open the deployed site in Safari or Chrome and use **Add to Home Screen**. The manifest,
icons and service worker are included, so it installs as an app and keeps a cached shell
for a cold offline load. API data always comes from the network.

The layout is tuned for phones:

- fixed compact header with feed status and alert bell
- six-item bottom tab bar with safe-area padding
- dashboard stats in a 2×2 grid
- tables become labelled cards — no sideways scrolling
- forms become bottom sheets with sticky Save/Cancel buttons
- 16px inputs so iOS does not zoom on focus
- all primary touch targets at least 40px

## Test

```powershell
cd tradera
node test/core.test.js      # domain logic + serverless handler
node test/http.test.js      # local HTTP API (server must be running)
node test/harness.js        # local Netlify-handler harness on :4180
```

The harness serves `public/` and routes `/api/*` through the serverless handler using an
in-memory store, so you can test the passcode lock screen and polling mode without Netlify.

## Notes and limitations

- This is a journal and alerting tool. It never places trades.
- P&L auto-calculation uses risk amount and entry-to-stop distance. Leave P&L blank when
  closing to derive it; type a value to override.
- Pips vs points: FX and metals use pips; crypto and indices use points (`pts`).
- Only setups with status **Watching** are alerted.
- Trade screenshots are shrunk in the browser (max 1800px JPEG, up to 8 per trade) and
  stored outside the journal: `data/images/` locally, and per account in Netlify Blobs
  online. JSON backups do not include them. Removing a screenshot or deleting a trade
  deletes its files.
- Each trade has a review: whether it worked, whether you followed your plan, why, and
  the lesson. The journal footer counts how often you followed your plan.
- Keep the local bind address at `127.0.0.1` unless you add authentication.

## Upgrading from Trading Desk

Tradera is the same app, renamed and redesigned. Your data carries over untouched:

- Local data stays in `data/db.json`; the Netlify Blobs store keeps its `trading-desk` name.
- Saved passcodes and browser-alert preferences are read from their old keys, so devices stay unlocked.
- Backups exported by Trading Desk import into Tradera as-is. New backups are named `tradera-backup-<date>.json`.

## File map

```
tradera/
  server.js                  local HTTP server, SSE, file storage, auto-open
  lib/
    desk-core.js             shared domain logic: feeds, alerts, stats, API actions
    serverless.js            Netlify handler + Blobs storage + passcode auth
  netlify/functions/
    api.mjs                  /api/* function
    poll.mjs                 scheduled quote + alert function
  netlify.toml               publish dir, functions, redirects, cron
  public/
    index.html               shell, mobile header, tab bar, passcode gate
    styles.css               design tokens, dark + light themes, responsive layout
    app.js                   views, forms, charts, sessions, shortcuts, SSE, polling, auth
    sw.js                    service worker (installable + offline shell)
    manifest.webmanifest     PWA manifest
    icons/                   app icons
  test/                      core, HTTP and Netlify-handler tests
  data/db.json               local book (created on first run)
```
