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

### 3. Set environment variables

**Site configuration → Environment variables:**

| Key | Required | Purpose |
| --- | --- | --- |
| `DESK_PASSCODE` | **Yes** | Shared passcode for the app. Without it the API is public. |
| `DESK_STORE` | No | Netlify Blobs store name. Default `trading-desk` (kept from before the Tradera rename so existing sites keep their data). |

Redeploy after adding the passcode. On first load the app shows a lock screen; enter the passcode to unlock that device. Settings has **Lock desk** to forget it.

### 4. Data storage

Online data is stored in **Netlify Blobs** (free tier). Nothing needs provisioning — the
function creates the `trading-desk` store on first save. Export a JSON backup from
**Settings → Export JSON** before changing deployments.

### 5. Scheduled price checks

`netlify/functions/poll.mjs` is wired in `netlify.toml` to run every 2 minutes:

```toml
[functions."poll"]
  schedule = "*/2 * * * *"
```

That function fetches quotes, evaluates entry alerts and sends ntfy/Telegram push while
nobody is on the site. Change it to `*/5 * * * *` to reduce free-tier usage. Scheduled
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
