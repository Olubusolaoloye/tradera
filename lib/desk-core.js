"use strict";

/**
 * Tradera core.
 *
 * All journal, setup, price-feed and alert logic lives here so the same code
 * runs in the local Node server and in Netlify Functions. Storage is injected:
 * the local server writes data/db.json, Netlify uses Netlify Blobs.
 */

const crypto = require("node:crypto");
const reader = require("./setup-reader");
const push = require("./webpush");

const SEED_PAIRS = [
  { symbol: "EURUSD", priority: true, monitor: true },
  { symbol: "GBPUSD", priority: false, monitor: true },
  { symbol: "USDJPY", priority: false, monitor: true },
  { symbol: "XAUUSD", priority: true, monitor: true },
  { symbol: "BTCUSD", priority: false, monitor: true }
];

const DEMO_BASE = {
  EURUSD: 1.085, GBPUSD: 1.27, USDJPY: 151.2, AUDUSD: 0.658, NZDUSD: 0.602,
  USDCAD: 1.36, USDCHF: 0.885, XAUUSD: 2350, XAGUSD: 28, BTCUSD: 68000,
  ETHUSD: 3500, SOLUSD: 150, US30: 39500, NAS100: 18200, SPX500: 5200
};

/*
 * Deriv synthetic indices: canonical Tradera symbol -> Deriv code, display
 * label and price decimals. Synthetics trade 24/7 and only Deriv prices them.
 * Distances are measured in points: 1.0 for Volatility, 0.1 (one step) for Step.
 */
const SYNTHETICS = {
  R_10: { code: "R_10", label: "V10", dec: 3 },
  R_25: { code: "R_25", label: "V25", dec: 3 },
  R_50: { code: "R_50", label: "V50", dec: 4 },
  R_75: { code: "R_75", label: "V75", dec: 4 },
  R_100: { code: "R_100", label: "V100", dec: 2 },
  "1HZ10V": { code: "1HZ10V", label: "V10 (1s)", dec: 2 },
  "1HZ15V": { code: "1HZ15V", label: "V15 (1s)", dec: 3 },
  "1HZ25V": { code: "1HZ25V", label: "V25 (1s)", dec: 2 },
  "1HZ30V": { code: "1HZ30V", label: "V30 (1s)", dec: 3 },
  "1HZ50V": { code: "1HZ50V", label: "V50 (1s)", dec: 2 },
  "1HZ75V": { code: "1HZ75V", label: "V75 (1s)", dec: 2 },
  "1HZ90V": { code: "1HZ90V", label: "V90 (1s)", dec: 3 },
  "1HZ100V": { code: "1HZ100V", label: "V100 (1s)", dec: 2 },
  STPRNG: { code: "stpRNG", label: "Step 100", dec: 1, step: true },
  STPRNG2: { code: "stpRNG2", label: "Step 200", dec: 1, step: true },
  STPRNG3: { code: "stpRNG3", label: "Step 300", dec: 1, step: true },
  STPRNG4: { code: "stpRNG4", label: "Step 400", dec: 1, step: true },
  STPRNG5: { code: "stpRNG5", label: "Step 500", dec: 1, step: true }
};

/** Forex pairs Deriv quotes (others fall back to Yahoo). */
const DERIV_FX = new Set([
  "AUDCAD", "AUDCHF", "AUDJPY", "AUDNZD", "AUDUSD", "EURAUD", "EURCAD", "EURCHF", "EURGBP", "EURJPY",
  "EURNZD", "EURUSD", "GBPAUD", "GBPCAD", "GBPCHF", "GBPJPY", "GBPNZD", "GBPUSD", "NZDJPY", "NZDUSD",
  "USDCAD", "USDCHF", "USDJPY", "USDMXN", "USDPLN"
]);

function synthetic(symbol) {
  return SYNTHETICS[String(symbol || "").toUpperCase()] || null;
}

/** Short human label used in alert messages and calls (V75 (1s), Step 200, EURUSD…). */
function symbolLabel(symbol) {
  const syn = synthetic(symbol);
  return syn ? syn.label : String(symbol || "");
}

// ------------------------------------------------------------------ helpers

function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
function uid() { return crypto.randomUUID(); }
// ------------------------------------------------------------------ images

const IMAGE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TRADE_IMAGES = 8;

/** A simple in-memory image store (tests, and the default when none is given). */
function createMemoryImages() {
  const map = new Map();
  return {
    async put(id, data, contentType) { map.set(id, { data: Buffer.from(data), contentType }); },
    async get(id) { return map.get(id) || null; },
    async remove(id) { map.delete(id); },
    size() { return map.size; }
  };
}

/** Decode a data: URL from the browser into an image buffer, or throw. */
function decodeImage(dataUrl) {
  const m = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!m) throw new Error("That file is not an image Tradera can store. Use a JPG, PNG or WebP screenshot.");
  const contentType = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
  if (!IMAGE_TYPES[contentType]) throw new Error("Use a JPG, PNG or WebP screenshot.");
  const data = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!data.length) throw new Error("That image is empty.");
  if (data.length > MAX_IMAGE_BYTES) throw new Error("That image is too large (over 4 MB). Try a smaller screenshot.");
  return { data, contentType };
}

/**
 * Image routes, shared by every wrapper. They never touch the journal itself,
 * so hosts can answer them without loading it. Returns null for other paths.
 */
async function imageRoute(images, method, pathname, body) {
  const m = String(method || "GET").toUpperCase();
  const p = String(pathname || "");
  if (p === "/api/images" && m === "POST") {
    let img;
    try { img = decodeImage(body && body.data); } catch (err) { return { status: 400, body: { error: err.message } }; }
    const id = uid();
    await images.put(id, img.data, img.contentType);
    return { status: 200, body: { id, bytes: img.data.length } };
  }
  if (p.startsWith("/api/images/") && m === "GET") {
    const id = decodeURIComponent(p.slice("/api/images/".length));
    if (!IMAGE_ID.test(id)) return { status: 404, body: { error: "Image not found" } };
    const img = await images.get(id);
    if (!img) return { status: 404, body: { error: "Image not found" } };
    return { status: 200, file: { data: img.data, contentType: img.contentType || "image/jpeg" } };
  }
  return null;
}

function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .map(x => (typeof x === "string" ? { id: x } : x))
    .filter(x => x && IMAGE_ID.test(String(x.id)) && !seen.has(x.id) && seen.add(x.id))
    .slice(0, MAX_TRADE_IMAGES)
    .map(x => ({ id: String(x.id), caption: String(x.caption || "").slice(0, 120) }));
}

function cleanSymbol(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "").replace(/\//g, "").slice(0, 24);
}
function num(value, fallback) {
  if (value === "" || value === null || value === undefined) return fallback === undefined ? null : fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? null : fallback);
}
function round(n, places) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const p = Math.pow(10, places === undefined ? 2 : places);
  return Math.round(n * p) / p;
}
function nowISO() { return new Date().toISOString(); }

function pipSize(symbol) {
  const s = String(symbol || "").toUpperCase();
  const syn = SYNTHETICS[s];
  if (syn) return syn.step ? 0.1 : 1;
  if (/XAU|GOLD/.test(s)) return 0.1;
  if (/XAG|SILVER/.test(s)) return 0.01;
  if (/JPY/.test(s)) return 0.01;
  if (/BTC|ETH|SOL|USDT|USDC|DOGE/.test(s)) return 1;
  if (/US30|NAS100|SPX500|GER40|UK100|JP225|US2000/.test(s)) return 1;
  return 0.0001;
}
function priceDecimals(symbol) {
  const syn = synthetic(symbol);
  if (syn) return syn.dec;
  const pip = pipSize(symbol);
  if (pip >= 1) return 2;
  if (pip >= 0.1) return 2;
  if (pip >= 0.01) return 3;
  return 5;
}
function unitName(symbol) {
  return synthetic(symbol) || pipSize(symbol) >= 1 ? "pts" : "pips";
}
function fmtPrice(symbol, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(priceDecimals(symbol));
}

function toYahooSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.startsWith("Y:")) return s.slice(2);
  const aliases = {
    XAUUSD: "GC=F",
    XAGUSD: "SI=F",
    GOLD: "GC=F",
    SILVER: "SI=F",
    US30: "^DJI",
    NAS100: "^NDX",
    SPX500: "^GSPC",
    GER40: "^GDAXI",
    UK100: "^FTSE",
    JP225: "^N225",
    USOIL: "CL=F",
    WTI: "CL=F",
    BTCUSD: "BTC-USD",
    ETHUSD: "ETH-USD",
    SOLUSD: "SOL-USD"
  };
  if (aliases[s]) return aliases[s];
  if (/^[A-Z]{6}$/.test(s)) return s + "=X";
  if (/^(BTC|ETH|SOL|DOGE|XRP|ADA|BNB)(USDT|USDC)$/.test(s)) {
    return s.replace(/(USDT|USDC)$/, "-USD");
  }
  return s;
}

/** OANDA v20 instrument names for the symbols Tradera understands. */
function toOandaInstrument(symbol) {
  const s = String(symbol || "").toUpperCase();
  const aliases = {
    GOLD: "XAU_USD", SILVER: "XAG_USD",
    US30: "US30_USD", NAS100: "NAS100_USD", SPX500: "SPX500_USD", US2000: "US2000_USD",
    GER40: "DE30_EUR", DE40: "DE30_EUR", UK100: "UK100_GBP", JP225: "JP225_USD",
    USOIL: "WTICO_USD", WTI: "WTICO_USD", UKOIL: "BCO_USD", BRENT: "BCO_USD"
  };
  if (aliases[s]) return aliases[s];
  if (/^(BTC|ETH|SOL|DOGE|XRP|ADA|BNB|LTC)/.test(s)) return null;
  if (/^[A-Z]{6}$/.test(s)) return s.slice(0, 3) + "_" + s.slice(3);
  return null;
}

/** Deriv underlying symbols (public market data, no key needed). */
function toDerivSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (SYNTHETICS[s]) return SYNTHETICS[s].code;
  const aliases = {
    GOLD: "frxXAUUSD", SILVER: "frxXAGUSD",
    US30: "OTC_DJI", NAS100: "OTC_NDX", SPX500: "OTC_SPC", US500: "OTC_SPC",
    GER40: "OTC_GDAXI", DE40: "OTC_GDAXI", UK100: "OTC_FTSE", JP225: "OTC_N225",
    FRA40: "OTC_FCHI", AUS200: "OTC_AS51", HK50: "OTC_HSI", EU50: "OTC_SX5E",
    BTCUSD: "cryBTCUSD", ETHUSD: "cryETHUSD"
  };
  if (aliases[s]) return aliases[s];
  if (/^(XAU|XAG|XPT|XPD)USD$/.test(s)) return "frx" + s;
  if (DERIV_FX.has(s)) return "frx" + s;
  return null;
}

/** Binance spot pairs for crypto symbols (USD is quoted against USDT). */
function toBinanceSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  const m = s.match(/^(BTC|ETH|SOL|DOGE|XRP|ADA|BNB|LTC|AVAX|LINK|DOT|MATIC|TRX|TON|SHIB|PEPE)(USD|USDT|USDC)$/);
  if (!m) return null;
  return m[1] + (m[2] === "USDC" ? "USDC" : "USDT");
}

/**
 * The price that actually fills a pending order: a buy (long) fills on the ask,
 * a sell (short) fills on the bid. Falls back to the last/mid price.
 */
function triggerPrice(quote, direction) {
  if (!quote) return null;
  const side = String(direction) === "short" ? quote.bid : quote.ask;
  return Number.isFinite(Number(side)) && side !== null ? Number(side) : quote.price;
}

function tvSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s === "XAUUSD" || s === "GOLD") return "OANDA:XAUUSD";
  if (s === "XAGUSD" || s === "SILVER") return "OANDA:XAGUSD";
  if (s === "BTCUSD") return "COINBASE:BTCUSD";
  if (s === "ETHUSD") return "COINBASE:ETHUSD";
  if (s === "US30") return "DJ:DJI";
  if (s === "NAS100") return "NASDAQ:NDX";
  if (s === "SPX500") return "SP:SPX";
  if (/^[A-Z]{6}$/.test(s)) return "FX:" + s;
  return s;
}

function rrOf(setup) {
  const entry = num(setup.entry), stop = num(setup.stop), target = num(setup.target);
  if (entry === null || stop === null || target === null) return null;
  const risk = Math.abs(entry - stop);
  if (!risk) return null;
  const reward = String(setup.direction) === "short" ? entry - target : target - entry;
  return round(reward / risk, 2);
}

// -------------------------------------------------------------- persistence

// --------------------------------------------------------- chart reminders

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const REMINDER_STEPS = [30, 60, 90, 120, 180, 240, 360, 480, 720];

function defaultReminders() {
  return { enabled: false, everyMinutes: 240, from: "08:00", to: "20:00", days: [1, 2, 3, 4, 5], tz: "UTC" };
}

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (_) { return false; }
}

const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
const toMinutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
const pad2 = n => String(n).padStart(2, "0");
const minutesText = m => pad2(Math.floor(m / 60)) + ":" + pad2(m % 60);

function cleanReminders(raw) {
  const r = { ...defaultReminders(), ...(raw && typeof raw === "object" ? raw : {}) };
  const every = Number(r.everyMinutes);
  return {
    enabled: r.enabled === true || r.enabled === "on" || r.enabled === "true",
    everyMinutes: REMINDER_STEPS.includes(every) ? every : 240,
    from: hhmm(r.from) ? r.from : "08:00",
    to: hhmm(r.to) ? r.to : "20:00",
    days: [...new Set((Array.isArray(r.days) ? r.days : String(r.days || "").split(","))
      .map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort(),
    tz: validTimeZone(r.tz) ? String(r.tz) : "UTC"
  };
}

/** Minutes after midnight at which a check is due, e.g. [480, 720, 960, 1200]. */
function reminderSlots(r) {
  const from = toMinutes(r.from);
  const to = toMinutes(r.to);
  const out = [];
  for (let m = from; m <= to && out.length < 48; m += r.everyMinutes) out.push(m);
  return out;
}

/** The wall-clock date, weekday and minute of `date` in a time zone. */
function zonedParts(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(date).map(p => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    ymd: parts.year + "-" + parts.month + "-" + parts.day,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday
  };
}

/** The instant at which a wall-clock day + minute happens in a time zone (DST-safe). */
function zonedInstant(y, mo, d, minutes, tz) {
  const wanted = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.minutes / 60), p.minutes % 60);
    guess += wanted - seen;
  }
  return new Date(guess);
}

function icsText(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function defaultDB(appUrl) {
  return {
    version: 1,
    settings: {
      accountCurrency: "USD",
      startingBalance: 10000,
      feed: "deriv",            // deriv | yahoo | oanda | twelvedata | demo
      twelveDataKey: "",
      oandaToken: "",
      oandaEnv: "practice",     // practice | live
      binanceCrypto: true,      // crypto prices from Binance on yahoo/oanda feeds
      callmebotUser: "",        // Telegram @username for CallMeBot voice calls
      callOnApproach: false,    // also ring for "getting close", not only entry
      pushoverUser: "",         // Pushover user key: emergency alarm that repeats until tapped
      pushoverToken: "",        // optional own Pushover app token (else PUSHOVER_APP_TOKEN)
      pollSeconds: 20,
      defaultThresholdPips: 15,
      ntfyServer: "https://ntfy.sh",
      ntfyTopic: "",
      telegramToken: "",
      telegramChatId: "",
      appUrl: appUrl || "",
      reminders: defaultReminders(),
      feedKey: ""               // secret in the iPhone calendar / Shortcut links
    },
    pairs: SEED_PAIRS.map(p => ({ ...p })),
    setups: [],
    trades: [],
    alerts: [],
    auth: null,               // { hash, salt, secret, version } once a password is set
    meta: { createdAt: nowISO(), quotes: {}, feedStatus: null }
  };
}

function normalizeDB(raw) {
  const base = defaultDB();
  const out = raw && typeof raw === "object" ? raw : {};
  const db = { ...base, ...out };
  db.settings = { ...base.settings, ...(out.settings || {}) };
  db.meta = { ...base.meta, ...(out.meta || {}) };
  for (const key of ["pairs", "setups", "trades", "alerts"]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  db.settings.pollSeconds = clamp(Number(db.settings.pollSeconds) || 20, 5, 600);
  if (db.settings.feed === "twelvedata") db.settings.pollSeconds = clamp(db.settings.pollSeconds, 60, 600);
  db.settings.startingBalance = Number(db.settings.startingBalance) || 0;
  db.settings.defaultThresholdPips = Number(db.settings.defaultThresholdPips) || 15;
  db.settings.reminders = cleanReminders(db.settings.reminders);
  db.settings.feedKey = /^[0-9a-f]{32,64}$/.test(String(db.settings.feedKey || "")) ? db.settings.feedKey : "";
  db.pairs = db.pairs
    .filter(p => p && typeof p.symbol === "string" && p.symbol.trim())
    .map(p => ({ symbol: cleanSymbol(p.symbol), priority: !!p.priority, monitor: p.monitor !== false }))
    .filter((p, i, arr) => arr.findIndex(x => x.symbol === p.symbol) === i);
  db.setups = db.setups.filter(s => s && typeof s === "object" && s.symbol);
  const a = db.auth;
  db.auth = a && typeof a === "object" && a.hash && a.salt && a.secret ? a : null;
  db.trades = db.trades.filter(t => t && typeof t === "object" && t.symbol);
  db.pushSubs = (Array.isArray(db.pushSubs) ? db.pushSubs : []).filter(x => x && x.endpoint && x.keys).slice(0, 10);
  db.alarmDevices = (Array.isArray(db.alarmDevices) ? db.alarmDevices : []).filter(x => x && x.id && x.keyHash).slice(0, 10);
  return db;
}

// ------------------------------------------------------------------- factory

/**
 * Prices fetched by one journal are reused by every other journal polled in
 * the same process for a short while, so 1,000 accounts watching EURUSD cost
 * one price request, not 1,000. Only hosts that pass shareQuotes use it.
 */
/**
 * Platform switches from the admin dashboard (online version). Anything not
 * switched off is on, so the local app and older configs behave as before.
 */
let FEATURES = {};
function setFeatures(f) { FEATURES = f && typeof f === "object" ? f : {}; }
const featureOn = name => FEATURES[name] !== false;

const SHARED_QUOTES = new Map();
const SHARED_QUOTE_MS = 25000;
function sharedQuote(feed, symbol) {
  const hit = SHARED_QUOTES.get(feed + "|" + symbol);
  return hit && Date.now() - hit.at < SHARED_QUOTE_MS ? hit.quote : null;
}
function shareQuote(feed, symbol, quote) {
  if (SHARED_QUOTES.size > 2000) SHARED_QUOTES.clear();
  SHARED_QUOTES.set(feed + "|" + symbol, { at: Date.now(), quote: { ...quote } });
}

function createDesk(options) {
  const opts = options || {};
  const store = opts.store;
  if (!store || typeof store.load !== "function" || typeof store.save !== "function") {
    throw new Error("createDesk requires a store with load() and save()");
  }
  const realtime = opts.realtime !== false;
  opts.accountId = opts.accountId || null;
  const images = opts.images || createMemoryImages();
  const onAlert = typeof opts.onAlert === "function" ? opts.onAlert : function () {};
  const onAlerts = typeof opts.onAlerts === "function" ? opts.onAlerts : function () {};
  const onSnapshot = typeof opts.onSnapshot === "function" ? opts.onSnapshot : function () {};

  let db = defaultDB(opts.appUrl);
  let quotes = {};
  let feedStatus = { ok: true, error: null, at: 0, source: db.settings.feed };
  let dirty = false;
  let pollPromise = null;
  let firedAlerts = []; // alerts this instance raised, oldest first (see mergePoll)
  // Serverless functions have a short execution budget, so wrappers can pass a
  // tighter network timeout. Local mode uses the generous default.
  const netTimeout = Math.max(1000, Number(opts.timeoutMs) || 15000);

  function markDirty() { dirty = true; }

  async function load() {
    const raw = await store.load();
    db = normalizeDB(raw);
    const meta = (raw && raw.meta) || {};
    quotes = meta.quotes && typeof meta.quotes === "object" && !Array.isArray(meta.quotes) ? meta.quotes : {};
    feedStatus = meta.feedStatus && typeof meta.feedStatus === "object"
      ? meta.feedStatus
      : { ok: true, error: null, at: 0, source: db.settings.feed };
    dirty = !raw;
    return fullState();
  }

  async function save(force) {
    if (!dirty && !force) return false;
    db.meta.quotes = quotes;
    db.meta.feedStatus = feedStatus;
    db.meta.updatedAt = nowISO();
    await store.save(db);
    dirty = false;
    return true;
  }

  function effectivePollSeconds() {
    let seconds = clamp(Number(db.settings.pollSeconds) || 20, 5, 600);
    if (db.settings.feed === "twelvedata") seconds = Math.max(60, seconds);
    // Serverless cannot run a 20s timer; align the effective cadence to the
    // scheduled function interval instead of burning invocations.
    if (!realtime) seconds = Math.max(60, seconds);
    return seconds;
  }

  function symbolList() {
    const set = new Set();
    db.pairs.filter(p => p.monitor).forEach(p => set.add(p.symbol));
    db.setups.filter(s => s.status === "watching").forEach(s => set.add(s.symbol));
    return Array.from(set);
  }

  // ------------------------------------------------------------------ prices

  function demoQuote(symbol) {
    const s = String(symbol).toUpperCase();
    const base = DEMO_BASE[s] || 100;
    const prev = quotes[s] && quotes[s].price ? quotes[s].price : base;
    const pip = pipSize(s);
    const drift = (Math.random() - 0.5) * pip * 8;
    const places = Math.pow(10, priceDecimals(s));
    return {
      price: Math.round((prev + drift) * places) / places,
      prevClose: quotes[s] && quotes[s].prevClose ? quotes[s].prevClose : base,
      source: "demo",
      updatedAt: Date.now()
    };
  }

  async function fetchGoldApi(symbols) {
    const codes = { XAUUSD: "XAU", XAGUSD: "XAG" };
    const failed = [];
    const results = await Promise.allSettled(symbols.map(async (symbol) => {
      const code = codes[symbol];
      if (!code) throw new Error("No metals mapping for " + symbol);
      const res = await fetch("https://api.gold-api.com/price/" + code, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(Math.min(netTimeout, 12000))
      });
      if (!res.ok) throw new Error("gold-api returned HTTP " + res.status);
      const data = await res.json();
      const price = num(data && data.price);
      if (price === null) throw new Error("gold-api returned no price");
      const prev = quotes[symbol] && Number.isFinite(Number(quotes[symbol].prevClose)) ? Number(quotes[symbol].prevClose) : price;
      quotes[symbol] = { price, prevClose: prev, source: "gold-api", updatedAt: Date.now() };
      return symbol;
    }));
    results.forEach((r, i) => { if (r.status === "rejected") failed.push(symbols[i]); });
    return failed;
  }

  async function fetchYahooSpark(symbols) {
    const map = {};
    symbols.forEach(s => { map[s] = toYahooSymbol(s); });
    const unique = Array.from(new Set(Object.values(map)));
    const url = "https://query1.finance.yahoo.com/v8/finance/spark?symbols=" +
      unique.map(encodeURIComponent).join(",") + "&range=1d&interval=5m";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(netTimeout)
    });
    if (!res.ok) throw new Error("Yahoo Finance returned HTTP " + res.status);
    const data = await res.json();
    const inverse = {};
    Object.keys(map).forEach(k => { inverse[map[k]] = k; });
    let updated = 0;
    const apply = (symbol, price, prevClose) => {
      if (!symbol || price === null || !Number.isFinite(price)) return;
      const prev = prevClose !== null && Number.isFinite(prevClose) ? prevClose : price;
      quotes[symbol] = { price, prevClose: prev, source: "yahoo", updatedAt: Date.now() };
      updated++;
    };

    if (data && data.spark && Array.isArray(data.spark.result)) {
      // Legacy Yahoo spark shape: { spark: { result: [ { symbol, response: [...] } ] } }
      for (const row of data.spark.result) {
        const symbol = inverse[row.symbol];
        if (!symbol) continue;
        const response = (row.response && row.response[0]) || null;
        const meta = (response && response.meta) || {};
        let price = num(meta.regularMarketPrice);
        if (price === null && response && response.indicators && response.indicators.quote) {
          const closes = response.indicators.quote[0].close || [];
          for (let i = closes.length - 1; i >= 0; i--) {
            if (closes[i] !== null && closes[i] !== undefined) { price = Number(closes[i]); break; }
          }
        }
        apply(symbol, price, num(meta.previousClose) ?? num(meta.chartPreviousClose) ?? price);
      }
    } else if (data && typeof data === "object") {
      // Current Yahoo spark shape: { "EURUSD=X": { fulldayPrice, previousClose, close: [] }, ... }
      for (const key of Object.keys(data)) {
        const row = data[key];
        if (!row || typeof row !== "object") continue;
        const symbol = inverse[row.symbol || key] || inverse[key];
        if (!symbol) continue;
        let price = num(row.fulldayPrice);
        if (price === null && Array.isArray(row.close)) {
          for (let i = row.close.length - 1; i >= 0; i--) {
            if (row.close[i] !== null && row.close[i] !== undefined) { price = Number(row.close[i]); break; }
          }
        }
        apply(symbol, price, num(row.previousClose) ?? num(row.chartPreviousClose) ?? price);
      }
    }
    if (!updated) throw new Error("Yahoo Finance returned no quotes");
  }

  async function fetchYahoo(symbols) {
    const metals = symbols.filter(s => s === "XAUUSD" || s === "XAGUSD");
    const rest = symbols.filter(s => s !== "XAUUSD" && s !== "XAGUSD");
    // Gold/silver spot from gold-api.com; fall back to COMEX futures on Yahoo if that fails.
    const failedMetals = metals.length ? await fetchGoldApi(metals) : [];
    const list = rest.concat(failedMetals);
    if (!list.length) return;
    await fetchYahooSpark(list);
  }

  let oandaAccount = null;
  const dailyOpen = {}; // symbol -> { day, open } for OANDA change %

  function oandaBase() {
    return db.settings.oandaEnv === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
  }

  async function oandaGet(path) {
    const token = String(db.settings.oandaToken || "").trim();
    if (!token) throw new Error("Add your OANDA API token in Settings");
    const res = await fetch(oandaBase() + path, {
      headers: { "Authorization": "Bearer " + token, "Accept-Datetime-Format": "UNIX" },
      signal: AbortSignal.timeout(netTimeout)
    });
    if (res.status === 401) throw new Error("OANDA rejected the API token. Check it, and that Practice/Live matches your account.");
    if (!res.ok) throw new Error("OANDA returned HTTP " + res.status);
    return res.json();
  }

  async function fetchOanda(symbols) {
    const map = {};
    symbols.forEach(s => { const inst = toOandaInstrument(s); if (inst) map[s] = inst; });
    const list = Object.keys(map);
    if (!list.length) return symbols;
    if (!oandaAccount) {
      const data = await oandaGet("/v3/accounts");
      oandaAccount = data && data.accounts && data.accounts[0] && data.accounts[0].id;
      if (!oandaAccount) throw new Error("No OANDA account found for this token");
    }
    const instruments = Array.from(new Set(Object.values(map)));
    const data = await oandaGet("/v3/accounts/" + oandaAccount + "/pricing?instruments=" + instruments.join(","));
    const byInst = {};
    (data.prices || []).forEach(row => { byInst[row.instrument] = row; });
    const today = new Date().toISOString().slice(0, 10);
    const missing = [];
    await Promise.all(list.map(async (symbol) => {
      const row = byInst[map[symbol]];
      const bid = row && row.bids && row.bids[0] ? num(row.bids[0].price) : null;
      const ask = row && row.asks && row.asks[0] ? num(row.asks[0].price) : null;
      if (bid === null || ask === null) { missing.push(symbol); return; }
      // Change % is measured from today's daily open, fetched once per day.
      if (!dailyOpen[symbol] || dailyOpen[symbol].day !== today) {
        try {
          const c = await oandaGet("/v3/instruments/" + map[symbol] + "/candles?granularity=D&count=1&price=B");
          const candle = c && c.candles && c.candles[0];
          const open = candle && candle.bid ? num(candle.bid.o) : null;
          if (open !== null) dailyOpen[symbol] = { day: today, open };
        } catch (_) { /* change % is optional */ }
      }
      quotes[symbol] = {
        price: bid,             // charts (MT4/MT5, TradingView OANDA) plot the bid
        bid, ask,
        spread: round((ask - bid) / pipSize(symbol), 1),
        prevClose: dailyOpen[symbol] ? dailyOpen[symbol].open : bid,
        tradeable: row.tradeable !== false,
        source: "oanda",
        updatedAt: Date.now()
      };
    }));
    return symbols.filter(s => !map[s]).concat(missing);
  }

  /**
   * Deriv's public WebSocket gives a live bid/ask tick per symbol. One short-lived
   * connection per poll: ask for one tick each (plus today's daily candle when we
   * don't have it yet), collect the answers, close.
   */
  async function fetchDeriv(symbols) {
    const map = {};
    symbols.forEach(s => { const d = toDerivSymbol(s); if (d) map[s] = d; });
    const list = Object.keys(map);
    if (!list.length) return symbols;
    if (typeof WebSocket !== "function") throw new Error("The Deriv feed needs Node.js 22 or newer");
    const today = new Date().toISOString().slice(0, 10);
    const needOpen = list.filter(s => !dailyOpen[s] || dailyOpen[s].day !== today);
    const ticks = {};
    const opens = {};

    await new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public");
      let waiting = list.length + needOpen.length;
      let opened = false;
      const finish = (err) => {
        clearTimeout(timer);
        try { ws.close(); } catch (_) { /* already closed */ }
        if (err && !Object.keys(ticks).length) reject(err); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Deriv did not answer in time")), netTimeout);
      const byCode = {};
      list.forEach(s => { byCode[map[s]] = s; });
      ws.onopen = () => {
        opened = true;
        // One request for every symbol (Deriv answers with one tick each), so a
        // large watchlist costs a single call against the rate limit.
        ws.send(JSON.stringify({ ticks: list.map(s => map[s]), req_id: 1 }));
        needOpen.forEach(s => ws.send(JSON.stringify({
          ticks_history: map[s], end: "latest", count: 1, style: "candles", granularity: 86400,
          req_id: 1000 + list.indexOf(s) + 1
        })));
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        const id = Number(msg.req_id) || 0;
        if (id === 1 && msg.error) {
          // A closed or unknown market can fail the batch; ask one by one instead.
          list.forEach((s, i) => ws.send(JSON.stringify({ ticks: map[s], req_id: 2000 + i + 1 })));
          return;
        }
        let symbol = null;
        if (id === 1 || id > 2000) {
          symbol = msg.tick ? byCode[msg.tick.symbol] : list[id - 2001];
          if (symbol && msg.tick && !ticks[symbol]) ticks[symbol] = msg.tick;
        } else if (id > 1000) {
          symbol = list[id - 1001];
          if (symbol && !msg.error && Array.isArray(msg.candles) && msg.candles[0]) opens[symbol] = num(msg.candles[0].open);
        }
        if (symbol && --waiting <= 0) finish();
      };
      ws.onerror = () => finish(new Error(opened ? "Deriv connection dropped" : "Could not connect to Deriv"));
      ws.onclose = () => finish(new Error("Deriv closed the connection"));
    });

    const missing = [];
    list.forEach(symbol => {
      const t = ticks[symbol];
      const bid = t ? num(t.bid) : null;
      const ask = t ? num(t.ask) : null;
      const mid = t ? num(t.quote) : null;
      if (mid === null && bid === null) { missing.push(symbol); return; }
      if (opens[symbol] !== null && opens[symbol] !== undefined) dailyOpen[symbol] = { day: today, open: opens[symbol] };
      const price = bid !== null ? bid : mid;
      quotes[symbol] = {
        price,
        bid, ask,
        spread: bid !== null && ask !== null ? round((ask - bid) / pipSize(symbol), 1) : null,
        prevClose: dailyOpen[symbol] ? dailyOpen[symbol].open : price,
        source: "deriv",
        updatedAt: Date.now()
      };
    });
    return symbols.filter(s => !map[s]).concat(missing);
  }

  async function fetchBinance(symbols) {
    const map = {};
    symbols.forEach(s => { const b = toBinanceSymbol(s); if (b) map[s] = b; });
    const list = Object.keys(map);
    if (!list.length) return symbols;
    const wanted = Array.from(new Set(Object.values(map)));
    // data-api.binance.vision is Binance's public market-data host and is not geo-blocked.
    const url = "https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(wanted));
    const res = await fetch(url, { signal: AbortSignal.timeout(netTimeout) });
    if (!res.ok) throw new Error("Binance returned HTTP " + res.status);
    const rows = await res.json();
    const bySym = {};
    (Array.isArray(rows) ? rows : []).forEach(r => { bySym[r.symbol] = r; });
    const missing = [];
    list.forEach(symbol => {
      const r = bySym[map[symbol]];
      const price = r ? num(r.lastPrice) : null;
      if (price === null) { missing.push(symbol); return; }
      quotes[symbol] = {
        price,
        bid: num(r.bidPrice), ask: num(r.askPrice),
        prevClose: num(r.openPrice) ?? num(r.prevClosePrice) ?? price,
        source: "binance",
        updatedAt: Date.now()
      };
    });
    return symbols.filter(s => !map[s]).concat(missing);
  }

  /**
   * Primary sources first; anything they cannot price (or a source that fails)
   * falls through to Yahoo so one outage never blanks the whole watchlist.
   */
  async function fetchLayered(symbols, primary) {
    let rest = symbols;
    const errors = [];
    if (db.settings.binanceCrypto !== false) {
      try { rest = await fetchBinance(rest); } catch (err) { errors.push(err.message); }
    }
    if (primary === "oanda") {
      try { rest = await fetchOanda(rest); } catch (err) { errors.push(err.message); oandaAccount = null; }
    } else if (primary === "deriv") {
      try { rest = await fetchDeriv(rest); } catch (err) { errors.push(err.message); }
    }
    // Synthetics only exist on Deriv, whichever feed is primary.
    const synths = rest.filter(s => synthetic(s));
    if (synths.length) {
      rest = rest.filter(s => !synthetic(s));
      if (primary !== "deriv") {
        try { await fetchDeriv(synths); } catch (err) { errors.push(err.message); }
      }
    }
    if (rest.length) {
      try { await fetchYahoo(rest); } catch (err) { errors.push(err.message); }
    }
    const priced = symbols.filter(s => quotes[s] && quotes[s].updatedAt >= Date.now() - netTimeout * 2);
    if (!priced.length) throw new Error(errors.join(" · ") || "No prices returned");
    return errors;
  }

  async function fetchTwelveData(symbols) {
    const key = db.settings.twelveDataKey;
    if (!key) throw new Error("Add your Twelve Data API key in Settings");
    const map = {};
    symbols.forEach(s => {
      map[s] = /^[A-Z]{6}$/.test(s) ? s.slice(0, 3) + "/" + s.slice(3) : s;
    });
    const url = "https://api.twelvedata.com/quote?symbol=" +
      Object.values(map).map(encodeURIComponent).join(",") + "&apikey=" + encodeURIComponent(key);
    const res = await fetch(url, { signal: AbortSignal.timeout(netTimeout) });
    if (!res.ok) throw new Error("Twelve Data returned HTTP " + res.status);
    const data = await res.json();
    if (data && data.status === "error") throw new Error(data.message || "Twelve Data error");
    const byTd = {};
    Object.keys(map).forEach(k => { byTd[map[k].toUpperCase()] = k; });
    const rows = Array.isArray(data) ? data : (data && data.symbol ? [data] : Object.values(data || {}));
    for (const row of rows) {
      if (!row || !row.symbol) continue;
      const symbol = byTd[String(row.symbol).toUpperCase()] || cleanSymbol(row.symbol);
      const price = num(row.close) ?? num(row.price);
      if (price === null) continue;
      quotes[symbol] = {
        price,
        prevClose: num(row.previous_close) ?? price,
        source: "twelvedata",
        updatedAt: Date.now()
      };
    }
  }

  async function runPoll() {
    const startedAt = Date.now();
    const symbols = symbolList();
    const reused = new Set();
    try {
      if (!symbols.length) {
        feedStatus = { ok: true, error: null, at: Date.now(), source: db.settings.feed, note: "No monitored pairs" };
        return;
      }
      const feed = db.settings.feed;
      let warnings = [];
      if (feed === "demo") {
        symbols.forEach(s => { quotes[s] = demoQuote(s); });
      } else if (feed === "twelvedata") {
        await fetchTwelveData(symbols);
      } else {
        let todo = symbols;
        if (opts.shareQuotes) {
          todo = symbols.filter(sym => {
            const hit = sharedQuote(feed, sym);
            if (!hit) return true;
            quotes[sym] = { ...hit };
            reused.add(sym);
            return false;
          });
        }
        if (todo.length) warnings = await fetchLayered(todo, feed);
        if (opts.shareQuotes) {
          todo.forEach(sym => { if (quotes[sym] && quotes[sym].updatedAt >= startedAt) shareQuote(feed, sym, quotes[sym]); });
        }
      }
      feedStatus = { ok: true, error: null, warning: warnings.length ? warnings.join(" · ") : null, at: Date.now(), source: feed };
    } catch (err) {
      feedStatus = { ok: false, error: err.message, at: Date.now(), source: db.settings.feed };
      if (typeof console !== "undefined") console.error("Price feed error:", err.message);
    } finally {
      symbols.forEach(s => {
        const q = quotes[s];
        if (!q) return;
        const fresh = reused.has(s) || (q.updatedAt && q.updatedAt >= startedAt);
        q.stale = !fresh;
        q.error = fresh ? null : feedStatus.error;
        if (fresh) {
          q.changePct = q.prevClose ? round(((q.price - q.prevClose) / q.prevClose) * 100, 2) : 0;
        }
      });
      markDirty();
      await evaluateAlerts();
      try { await reRing(); } catch (err) { if (typeof console !== "undefined") console.error("Re-ring failed:", err.message); }
      try { await checkReminders(); } catch (err) { if (typeof console !== "undefined") console.error("Reminder failed:", err.message); }
      onSnapshot(snapshotPayload());
    }
  }

  // --------------------------------------------------------- chart reminders

  function nextReminder(now) {
    const r = db.settings.reminders;
    if (!r.enabled || !r.days.length) return null;
    const slots = reminderSlots(r);
    const start = now || new Date();
    for (let day = 0; day < 8; day++) {
      const probe = new Date(start.getTime() + day * 86400000);
      const p = zonedParts(probe, r.tz);
      if (!r.days.includes(p.weekday)) continue;
      const nowMin = day === 0 ? zonedParts(start, r.tz).minutes : -1;
      const slot = slots.find(m => m > nowMin);
      if (slot !== undefined) return zonedInstant(p.y, p.mo, p.d, slot, r.tz);
    }
    return null;
  }

  function reminderMessage() {
    const watching = priorityList().filter(s => s.distancePips !== null && s.distancePips !== undefined)
      .sort((a, b) => a.distancePips - b.distancePips).slice(0, 3);
    const open = db.trades.filter(t => t.status !== "closed").length;
    const lines = ["Time for your chart check."];
    if (watching.length) {
      lines.push("Closest to entry: " + watching.map(s =>
        symbolLabel(s.symbol) + " " + String(s.direction).toUpperCase() + " " + Number(s.distancePips).toFixed(1) + " " + unitName(s.symbol) + " away").join(", ") + ".");
    } else if (db.setups.some(s => s.status === "watching")) {
      lines.push(db.setups.filter(s => s.status === "watching").length + " setups on watch.");
    } else {
      lines.push("No setups on watch: look for your next one.");
    }
    if (open) lines.push(open + (open === 1 ? " open trade" : " open trades") + " to manage.");
    return lines.join(" ");
  }

  async function sendReminder(kind) {
    return fireAlert({ symbol: null, kind: kind || "reminder", message: reminderMessage(), price: null, distancePips: null });
  }

  /** Fire the chart-check reminder once per scheduled slot. */
  async function checkReminders(nowOverride) {
    if (!featureOn("reminders")) return false;
    const r = db.settings.reminders;
    if (!r.enabled || !r.days.length) return false;
    const now = nowOverride || new Date();
    const p = zonedParts(now, r.tz);
    if (!r.days.includes(p.weekday)) return false;
    const due = reminderSlots(r).filter(m => m <= p.minutes).pop();
    if (due === undefined || p.minutes - due > 20) return false;
    const key = p.ymd + "@" + minutesText(due);
    if (db.meta.lastReminderKey === key) return false;
    db.meta.lastReminderKey = key;
    markDirty();
    await sendReminder("reminder");
    return true;
  }

  /**
   * Read-only feeds for the iPhone: a calendar subscription (alarms at every
   * check) and today's remaining checks as JSON for an Apple Shortcut that
   * fills the Reminders app. Both need the account's secret feed key.
   */
  function reminderFeed(format, key, origin) {
    const want = String(db.settings.feedKey || "");
    const given = String(key || "");
    if (!want || given.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      return { status: 404, body: { error: "This reminder link is not valid. Copy a fresh one from Tradera." } };
    }
    const r = db.settings.reminders;
    const slots = r.enabled && r.days.length ? reminderSlots(r) : [];
    const appLink = String(origin || db.settings.appUrl || "").replace(/\/+$/, "");

    if (format === "ics") {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
      const first = Math.min(...(r.days.length ? r.days : [1]));
      const anchor = new Date(Date.UTC(2026, 0, 4 + first)); // 4 Jan 2026 is a Sunday
      const anchorDay = anchor.toISOString().slice(0, 10).replace(/-/g, "");
      const byDay = r.days.map(d => DAY_CODES[d]).join(",");
      const lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tradera//Chart checks//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "X-WR-CALNAME:Tradera chart checks", "X-WR-TIMEZONE:" + r.tz,
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"
      ];
      slots.forEach(m => {
        lines.push(
          "BEGIN:VEVENT",
          "UID:tradera-check-" + minutesText(m).replace(":", "") + "-" + want.slice(0, 12) + "@tradera",
          "DTSTAMP:" + stamp,
          "DTSTART;TZID=" + r.tz + ":" + anchorDay + "T" + minutesText(m).replace(":", "") + "00",
          "DURATION:PT10M",
          "RRULE:FREQ=WEEKLY;BYDAY=" + byDay,
          "SUMMARY:" + icsText("Check your charts"),
          "DESCRIPTION:" + icsText("Tradera chart check. Review your setups, open trades and markets." + (appLink ? "\n" + appLink : "")),
          ...(appLink ? ["URL:" + appLink] : []),
          "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsText("Check your charts"), "TRIGGER:PT0M", "END:VALARM",
          "END:VEVENT"
        );
      });
      lines.push("END:VCALENDAR");
      return { status: 200, text: lines.join("\r\n") + "\r\n", contentType: "text/calendar; charset=utf-8" };
    }

    // Today's checks still ahead, for an Apple Shortcut ("Add New Reminder").
    const now = new Date();
    const p = zonedParts(now, r.tz);
    const items = !r.days.includes(p.weekday) ? [] : slots.filter(m => m > p.minutes).map(m => {
      const at = zonedInstant(p.y, p.mo, p.d, m, r.tz);
      return {
        title: "Check your charts (" + minutesText(m) + ")",
        notes: "Tradera chart check" + (appLink ? ": " + appLink : ""),
        due: p.ymd + " " + minutesText(m),
        dueISO: at.toISOString()
      };
    });
    return { status: 200, body: { list: "Tradera", timeZone: r.tz, date: p.ymd, count: items.length, items } };
  }

  function poll() {
    if (pollPromise) return pollPromise;
    pollPromise = runPoll().finally(() => { pollPromise = null; });
    return pollPromise;
  }

  function needsFresh() {
    if (!symbolList().length) return false;
    const interval = Math.max(30, Math.min(effectivePollSeconds(), 55));
    const last = Number(feedStatus.at) || 0;
    return Date.now() - last >= interval * 1000;
  }

  async function ensureFresh() {
    if (!needsFresh()) return false;
    await poll();
    return true;
  }

  const POLL_SETUP_FIELDS = ["alerted", "entryAlerted", "alertedAt", "alertedPrice", "distancePips", "lastPrice"];
  const OUTCOME_FIELDS = ["entryHitAt", "outcome", "logPrompt", "status", "doneAt"];

  /** What a price poll changed, so it can be laid over a newer saved copy. */
  function pollSnapshot() {
    return {
      quotes,
      feedStatus,
      reminderKey: db.meta.lastReminderKey || null,
      alerts: firedAlerts.slice().concat(db.alerts.filter(x => x.ringing && !firedAlerts.includes(x))),
      setups: db.setups.map(s => {
        const out = { id: s.id, entry: s.entry, direction: s.direction, status: s.status };
        POLL_SETUP_FIELDS.forEach(k => { out[k] = s[k]; });
        OUTCOME_FIELDS.forEach(k => { out["poll_" + k] = s[k]; });
        return out;
      })
    };
  }

  /**
   * Re-apply a poll on top of freshly loaded data. Used when someone saved
   * while the poll was fetching prices: their edits win, and the poll only
   * contributes quotes, new alerts and alert flags for unchanged setups.
   */
  function mergePoll(snap) {
    if (!snap) return;
    quotes = snap.quotes || quotes;
    feedStatus = snap.feedStatus || feedStatus;
    if (snap.reminderKey && String(snap.reminderKey) > String(db.meta.lastReminderKey || "")) db.meta.lastReminderKey = snap.reminderKey;
    const known = new Set(db.alerts.map(a => a.id));
    // Ring progress made by this poll (an alert the user stopped meanwhile stays stopped).
    (snap.alerts || []).forEach(p => {
      const a = db.alerts.find(x => x.id === p.id);
      if (a && a.ring && p.ring && a.ringing) { a.ring.sent = Math.max(a.ring.sent, p.ring.sent); a.ring.lastAt = Math.max(a.ring.lastAt, p.ring.lastAt); }
    });
    const fresh = (snap.alerts || []).filter(a => a && !known.has(a.id)).reverse();
    db.alerts = fresh.concat(db.alerts).slice(0, 200);
    (snap.setups || []).forEach(p => {
      const s = db.setups.find(x => x.id === p.id);
      if (!s) return;
      const same = Number(s.entry) === Number(p.entry) && s.direction === p.direction;
      // A stop / target hit found by the poll survives an edit made meanwhile,
      // unless the user changed the setup itself or finished it by hand.
      if (same && (s.status === "watching" || s.status === "triggered")) {
        if (p.poll_entryHitAt && !s.entryHitAt) s.entryHitAt = p.poll_entryHitAt;
        if (p.poll_outcome && !s.outcome) {
          s.outcome = p.poll_outcome;
          s.logPrompt = !!p.poll_logPrompt && !s.loggedTradeId;
          s.status = p.poll_status;
          s.doneAt = p.poll_doneAt;
        }
      }
      if (s.status !== "watching" || p.status !== "watching") return;
      if (Number(s.entry) !== Number(p.entry) || s.direction !== p.direction) return;
      POLL_SETUP_FIELDS.forEach(k => { s[k] = p[k]; });
    });
    firedAlerts = (snap.alerts || []).slice();
    markDirty();
  }

  // ------------------------------------------------------------------ alerts

  function alertTitle(kind, symbol) {
    if (kind === "entry") return "ENTRY REACHED " + symbolLabel(symbol);
    if (kind === "outcome") return "Setup finished " + symbolLabel(symbol);
    if (kind === "test") return "Tradera test alert";
    if (kind === "reminder") return "Time to check your charts";
    return "Approaching entry " + symbolLabel(symbol);
  }

  async function sendNtfy(alert) {
    const topic = String(db.settings.ntfyTopic || "").trim();
    if (!topic) throw new Error("No ntfy topic configured");
    const base = String(db.settings.ntfyServer || "https://ntfy.sh").replace(/\/+$/, "");
    const body = alert.message + (alert.kind === "test" || alert.kind === "reminder" || synthetic(alert.symbol) ? "" : "\n" +
      "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tvSymbol(alert.symbol)));
    const res = await deliver(base + "/" + encodeURIComponent(topic), {
      method: "POST",
      headers: {
        "Title": alertTitle(alert.kind, alert.symbol),
        // Urgent alerts ring through Do Not Disturb, and with ntfy's "Keep alerting
        // for highest priority" they repeat until dismissed, like a phone call.
        "Priority": ringsPhone(alert.kind) ? "urgent" : alert.kind === "reminder" ? "default" : "high",
        "Tags": alert.kind === "entry" ? "rotating_light,chart_with_upwards_trend" : alert.kind === "reminder" ? "alarm_clock" : "chart_with_upwards_trend",
        "Content-Type": "text/plain; charset=utf-8"
      },
      body
    });
    if (!res.ok) throw new Error("ntfy HTTP " + res.status);
    return { channel: "ntfy", ok: true };
  }

  /** Entries always ring; "getting close" rings when the user asked for it; tests ring so the setup can be checked. */
  function ringsPhone(kind) {
    return kind === "entry" || kind === "test" || (kind === "approaching" && !!db.settings.callOnApproach);
  }

  async function sendTelegram(alert) {
    const token = db.settings.telegramToken.trim();
    const chatId = db.settings.telegramChatId.trim();
    if (!token || !chatId) throw new Error("Telegram is not configured");
    const icon = alert.kind === "entry" ? "🚨 " : alert.kind === "test" ? "✅ " : alert.kind === "reminder" ? "⏰ " : "📈 ";
    const text = icon + alertTitle(alert.kind, alert.symbol) + "\n" + alert.message +
      (alert.kind === "test" || alert.kind === "reminder" || synthetic(alert.symbol) ? "" : "\nhttps://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tvSymbol(alert.symbol)));
    const res = await deliver("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (!res.ok) throw new Error("Telegram HTTP " + res.status);
    return { channel: "telegram", ok: true };
  }

  /**
   * fetch() with retries for alert delivery. Flaky home connections drop DNS
   * lookups now and then (EAI_AGAIN); one hiccup must not cost an alert.
   * Only network failures are retried, never an HTTP answer.
   */
  async function deliver(url, init, timeoutMs) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, attempt * 1500));
      try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs || netTimeout) });
      } catch (err) {
        lastErr = err;
        if (err && err.name === "TimeoutError") break; // the request may have landed; don't double-send
      }
    }
    const cause = lastErr && lastErr.cause;
    const why = cause && cause.code === "EAI_AGAIN" ? "could not look up the address (internet connection dropped)"
      : cause && (cause.code || cause.message) ? (cause.code || cause.message)
      : lastErr && lastErr.name === "TimeoutError" ? "timed out" : (lastErr && lastErr.message) || "network error";
    throw new Error("Network error: " + why);
  }

  function pushoverToken() {
    return String(db.settings.pushoverToken || "").trim() || String(process.env.PUSHOVER_APP_TOKEN || "").trim();
  }
  function pushoverReady() {
    return !!String(db.settings.pushoverUser || "").trim() && !!pushoverToken();
  }

  /**
   * Pushover. Entries (and "getting close" when calls are on for it) are sent
   * as emergency alarms: they sound through silent mode and Do Not Disturb
   * and repeat every 30 seconds for 10 minutes until the user taps them.
   */
  async function sendPushover(alert) {
    const user = String(db.settings.pushoverUser || "").trim();
    const token = pushoverToken();
    if (!user) throw new Error("No Pushover user key set");
    if (!token) throw new Error("Pushover is not switched on for this Tradera site (no app token)");
    const alarm = ringsPhone(alert.kind);
    const form = new URLSearchParams({
      token,
      user,
      title: alertTitle(alert.kind, alert.symbol).slice(0, 250),
      message: String(alert.message || "").slice(0, 1000),
      priority: alarm ? "2" : alert.kind === "approaching" ? "1" : "0",
      sound: alarm ? "persistent" : alert.kind === "reminder" ? "bike" : "pushover"
    });
    if (alarm) { form.set("retry", "30"); form.set("expire", "600"); }
    const appUrl = String(db.settings.appUrl || "").trim();
    if (appUrl) { form.set("url", appUrl); form.set("url_title", "Open Tradera"); }
    const res = await deliver("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || data.status !== 1) {
      const why = (data.errors && data.errors.join(", ")) || ("HTTP " + res.status);
      throw new Error("Pushover: " + why);
    }
    return { channel: "pushover", ok: true };
  }

  /** Short, non-secret id for a device (its push address is private). */
  function deviceId(endpoint) {
    return crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 12);
  }

  /** Tradera's own notifications to every phone/browser that turned them on. */
  const RING_EVERY_MS = 55 * 1000;   // re-ring about every minute
  const RING_TIMES = 10;             // for up to ~10 minutes

  async function sendWebPush(alert, repeat) {
    const urgent = ringsPhone(alert.kind);
    const ring = alert.ring && alert.ring.key ? alert.ring : null;
    const payload = {
      title: (repeat ? "⏰ " : "") + alertTitle(alert.kind, alert.symbol),
      body: String(alert.message || "").slice(0, 600) + (repeat ? " (alert " + (repeat + 1) + " of " + RING_TIMES + ")" : ""),
      ack: ring ? { a: alert.id, k: ring.key, u: opts.accountId || null } : null,
      kind: alert.kind,
      tag: alert.kind === "reminder" ? "reminder" : (alert.setupId || alert.id || "tradera"),
      urgent,
      url: alert.kind === "reminder" ? "/#dashboard" : alert.kind === "outcome" ? "/#setups" : "/#alerts",
      at: Date.now()
    };
    const subs = db.pushSubs.slice();
    const results = await Promise.all(subs.map(s => push.sendPush(s, payload, {
      urgency: urgent ? "high" : alert.kind === "reminder" ? "normal" : "high",
      ttl: alert.kind === "reminder" ? 1800 : 3600,
      topic: payload.tag
    })));
    const gone = new Set();
    results.forEach((r, i) => { if (r.gone) gone.add(subs[i].endpoint); });
    if (gone.size) {
      db.pushSubs = db.pushSubs.filter(s => !gone.has(s.endpoint));
      markDirty();
    }
    const sent = results.filter(r => r.ok).length;
    if (!sent) throw new Error(results.map(r => r.error).filter(Boolean)[0] || "No device took the notification");
    return { channel: "push", ok: true, devices: sent };
  }
  const pushOn = () => featureOn("webpush") && push.pushReady() && db.pushSubs.length > 0;
  const alarmOn = () => featureOn("alarm") && db.alarmDevices.length > 0;
  const hashKey = k => crypto.createHash("sha256").update("alarm|" + String(k)).digest("hex");

  /**
   * What the Android app asks every ~30 seconds: is anything ringing?
   * Answers only to a paired device's own key.
   */
  function alarmPoll(deviceId, key) {
    const dev = db.alarmDevices.find(x => x.id === String(deviceId || ""));
    if (!dev || !key) return { status: 404, body: { error: "This phone isn't paired. Pair it again from Alerts." } };
    const a = Buffer.from(dev.keyHash), b = Buffer.from(hashKey(key));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 404, body: { error: "This phone isn't paired. Pair it again from Alerts." } };
    const now = Date.now();
    if (!dev.lastSeenAt || now - Date.parse(dev.lastSeenAt) > 10 * 60 * 1000) { dev.lastSeenAt = new Date(now).toISOString(); markDirty(); }
    const ringing = alarmOn() ? db.alerts.filter(x => x.ringing && x.ring && now <= x.ring.until).slice(0, 5).map(x => ({
      id: x.id,
      kind: x.kind,
      symbol: x.symbol,
      title: alertTitle(x.kind, x.symbol),
      body: String(x.message || "").slice(0, 400),
      at: x.at,
      ack: { a: x.id, k: x.ring.key, u: opts.accountId || null }
    })) : [];
    return { status: 200, body: { ok: true, ringing, every: ringing.length ? 10 : 30, alarm: alarmOn() } };
  }

  /** Send the next ring for every urgent alert the user hasn't stopped yet. */
  async function reRing(nowOverride) {
    const now = nowOverride || Date.now();
    for (const a of db.alerts) {
      if (!a.ringing || !a.ring) continue;
      if (now > a.ring.until || a.ring.sent >= RING_TIMES || (!pushOn() && !alarmOn())) { a.ringing = false; markDirty(); continue; }
      if (now - a.ring.lastAt < RING_EVERY_MS) continue;
      if (!pushOn()) { a.ring.sent += 1; a.ring.lastAt = now; markDirty(); continue; } // phone alarm only
      a.ring.sent += 1;
      a.ring.lastAt = now;
      markDirty();
      try { await sendWebPush(a, a.ring.sent - 1); } catch (_) { /* next poll tries again */ }
    }
  }

  /** Stop one alert ringing (from the notification) or all of them (app opened). */
  function stopRinging(id, key) {
    let stopped = 0;
    db.alerts.forEach(a => {
      if (!a.ringing) return;
      if (id) {
        if (a.id !== id || !a.ring || !key) return;
        const k1 = Buffer.from(String(a.ring.key)), k2 = Buffer.from(String(key));
        if (k1.length !== k2.length || !crypto.timingSafeEqual(k1, k2)) return;
      }
      a.ringing = false;
      a.ring.stoppedAt = Date.now();
      stopped++;
    });
    if (stopped) markDirty();
    return stopped;
  }

  let lastCallAt = 0;

  /** Rings the user's Telegram through CallMeBot and reads the alert aloud. */
  async function sendCall(alert) {
    let user = String(db.settings.callmebotUser || "").trim();
    if (!user) throw new Error("No Telegram username set for calls");
    if (!user.startsWith("@") && !/^\+?\d+$/.test(user)) user = "@" + user;
    // CallMeBot refuses a second call to the same user within 65 seconds.
    if (alert.kind !== "test" && Date.now() - lastCallAt < 66000) {
      return { channel: "call", ok: false, error: "Skipped: CallMeBot allows one call per 65 seconds" };
    }
    const spoken = alert.kind === "entry"
      ? (synthetic(alert.symbol) ? symbolLabel(alert.symbol) : alert.symbol.split("").join(" ")) + " has reached your entry. " + alert.message
      : alert.message;
    const url = "https://api.callmebot.com/start.php?user=" + encodeURIComponent(user) +
      "&text=" + encodeURIComponent(spoken.slice(0, 250)) + "&lang=en-GB-Standard-B&rpt=2";
    const res = await deliver(url, {}, Math.max(netTimeout, 20000));
    const body = await res.text().catch(() => "");
    if (!res.ok) throw new Error("CallMeBot HTTP " + res.status);
    // The reply is an HTML page with tracking scripts; judge only its visible text.
    const plain = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    // CallMeBot answers 200 with a log; a failure shows up as "Error: …" anywhere in it.
    const failure = plain.match(/\berror\s*:\s*(.+?)(?:\s+end\.?-?)?$/i) || plain.match(/not\s+authori[sz]ed.*|denied.*/i);
    if (failure) {
      throw new Error("CallMeBot: " + (failure[1] || failure[0]).slice(0, 220));
    }
    lastCallAt = Date.now();
    return { channel: "call", ok: true };
  }

  function wantsCall(kind) {
    if (!String(db.settings.callmebotUser || "").trim()) return false;
    return kind === "entry" || (kind === "approaching" && db.settings.callOnApproach);
  }

  async function fireAlert(info) {
    const alert = {
      id: uid(),
      at: Date.now(),
      symbol: info.symbol,
      kind: info.kind,
      message: info.message,
      price: info.price === undefined ? null : info.price,
      distancePips: info.distancePips === undefined ? null : info.distancePips,
      setupId: info.setupId || null,
      setupLabel: info.setupLabel || null,
      channels: []
    };
    db.alerts.unshift(alert);
    let reminderCount = 0;
    db.alerts = db.alerts.filter(a => a.kind !== "reminder" || ++reminderCount <= 10).slice(0, 200);
    firedAlerts.push(alert);
    markDirty();
    onAlert(alert);

    const jobs = [];
    if (featureOn("ntfy") && db.settings.ntfyTopic) jobs.push(sendNtfy(alert));
    if (featureOn("telegram") && db.settings.telegramToken && db.settings.telegramChatId) jobs.push(sendTelegram(alert));
    if (featureOn("pushover") && pushoverReady()) jobs.push(sendPushover(alert));
    // Urgent alerts keep ringing until the user stops them: re-sent as
    // notifications about every minute, and picked up by the Android app's
    // loud alarm on paired phones.
    if ((pushOn() || alarmOn()) && ringsPhone(alert.kind) && alert.kind !== "test") {
      alert.ring = { key: crypto.randomBytes(12).toString("hex"), sent: 1, lastAt: Date.now(), until: Date.now() + RING_TIMES * 60 * 1000 };
      alert.ringing = true;
    }
    if (pushOn()) jobs.push(sendWebPush(alert));
    if (featureOn("telegramCalls") && wantsCall(alert.kind)) jobs.push(sendCall(alert));
    const results = await Promise.allSettled(jobs);
    results.forEach(r => {
      if (r.status === "fulfilled" && r.value) alert.channels.push(r.value);
      if (r.status === "rejected") alert.channels.push({ channel: "error", ok: false, error: r.reason && r.reason.message });
    });
    onAlerts(db.alerts.slice(0, 50));
    return alert;
  }

  /**
   * After price reaches a setup's entry, keep watching it: when the stop or
   * the target is hit the setup is finished and the user is asked whether
   * they took it, so it can go in the journal. A target reached before the
   * entry ever filled is recorded as missed.
   */
  async function trackOutcome(setup, quote, now) {
    if (setup.outcome) return;
    const dir = String(setup.direction) === "short" ? "short" : "long";
    const entry = num(setup.entry);
    const stop = num(setup.stop);
    const target = num(setup.target);
    if (entry === null || (stop === null && target === null)) return;
    const fill = triggerPrice(quote, dir);
    const exit = triggerPrice(quote, dir === "short" ? "long" : "short");
    if (fill === null || exit === null) return;
    const crossed = dir === "short" ? fill >= entry : fill <= entry;
    if (!setup.entryHitAt && (crossed || setup.status === "triggered")) {
      setup.entryHitAt = new Date(now).toISOString();
      markDirty();
    }
    let result = null;
    let level = null;
    if (setup.entryHitAt) {
      if (stop !== null && (dir === "long" ? exit <= stop : exit >= stop)) { result = "sl"; level = stop; }
      else if (target !== null && (dir === "long" ? exit >= target : exit <= target)) { result = "tp"; level = target; }
    } else if (target !== null && (dir === "long" ? exit >= target : exit <= target)) {
      result = "missed"; level = target;
    }
    if (!result) return;

    const risk = stop !== null ? Math.abs(entry - stop) : 0;
    const r = risk && result !== "missed" ? round(((level - entry) * (dir === "short" ? -1 : 1)) / risk, 2) : null;
    setup.outcome = { result, price: level, at: new Date(now).toISOString(), r };
    setup.logPrompt = result !== "missed" && !setup.loggedTradeId;
    setup.status = result === "missed" ? "invalidated" : "done";
    setup.doneAt = new Date(now).toISOString();
    markDirty();

    const name = symbolLabel(setup.symbol) + " " + (dir === "short" ? "SELL" : "BUY");
    const message = result === "missed"
      ? name + " reached its target " + fmtPrice(setup.symbol, level) + " without filling your entry " + fmtPrice(setup.symbol, entry) + ". Marked as missed."
      : name + " hit its " + (result === "tp" ? "TARGET " : "STOP ") + fmtPrice(setup.symbol, level) +
        (r !== null ? " (" + (r > 0 ? "+" : "") + r + "R)" : "") + ". Did you take it? Open Tradera to log it in your journal.";
    try {
      await fireAlert({
        symbol: setup.symbol,
        kind: "outcome",
        message,
        price: exit,
        setupId: setup.id,
        setupLabel: setup.label || (dir.toUpperCase() + " " + setup.symbol)
      });
    } catch (err) {
      if (typeof console !== "undefined") console.error("Alert failed:", err.message);
    }
  }

  async function evaluateAlerts() {
    const now = Date.now();
    const maxAge = Math.max(90000, (Number(db.settings.pollSeconds) || 20) * 3000);
    for (const setup of db.setups) {
      if (setup.status !== "watching" && setup.status !== "triggered") continue;
      const quote = quotes[setup.symbol];
      if (!quote || quote.stale || quote.price === null || quote.price === undefined) continue;
      if (quote.updatedAt && now - quote.updatedAt > maxAge) continue;
      const entry = num(setup.entry);
      if (entry === null) continue;
      if (setup.status === "triggered") {
        await trackOutcome(setup, quote, now);
        continue;
      }
      const pip = pipSize(setup.symbol);
      // Judge the setup on the side of the book that would actually fill it.
      const live = triggerPrice(quote, setup.direction);
      const distance = Math.abs(live - entry) / pip;
      const threshold = num(setup.thresholdPips, db.settings.defaultThresholdPips) || db.settings.defaultThresholdPips;
      const crossed = String(setup.direction) === "short" ? live >= entry : live <= entry;
      const near = distance <= threshold;

      setup.distancePips = round(distance, 1);
      setup.lastPrice = live;

      // An earlier "getting close" alert must not swallow the entry alert.
      if (crossed && setup.alerted && !setup.entryAlerted) {
        setup.entryAlerted = true;
        markDirty();
        try {
          await fireAlert({
            symbol: setup.symbol,
            kind: "entry",
            message: symbolLabel(setup.symbol) + " is AT your entry " + fmtPrice(setup.symbol, entry) + " (" + String(setup.direction).toUpperCase() + "). Price " + fmtPrice(setup.symbol, live) + ".",
            price: live,
            distancePips: round(distance, 1),
            setupId: setup.id,
            setupLabel: setup.label || setup.note || (String(setup.direction).toUpperCase() + " " + setup.symbol)
          });
        } catch (err) {
          if (typeof console !== "undefined") console.error("Alert failed:", err.message);
        }
        await trackOutcome(setup, quote, now);
        continue;
      }

      if (near && !setup.alerted) {
        setup.alerted = true;
        setup.entryAlerted = crossed;
        setup.alertedAt = now;
        setup.alertedPrice = live;
        const label = setup.label || setup.note || (String(setup.direction).toUpperCase() + " " + setup.symbol);
        const unit = unitName(setup.symbol);
        const message = crossed
          ? symbolLabel(setup.symbol) + " is AT your entry " + fmtPrice(setup.symbol, entry) + " (" + String(setup.direction).toUpperCase() + "). Price " + fmtPrice(setup.symbol, live) + "."
          : symbolLabel(setup.symbol) + " is approaching your entry " + fmtPrice(setup.symbol, entry) + " (" + String(setup.direction).toUpperCase() + ") — price " + fmtPrice(setup.symbol, live) + ", " + distance.toFixed(1) + " " + unit + " away.";
        markDirty();
        try {
          await fireAlert({
            symbol: setup.symbol,
            kind: crossed ? "entry" : "approaching",
            message,
            price: live,
            distancePips: round(distance, 1),
            setupId: setup.id,
            setupLabel: label
          });
        } catch (err) {
          if (typeof console !== "undefined") console.error("Alert failed:", err.message);
        }
      } else if (!near && setup.alerted && distance > threshold * 1.6) {
        setup.alerted = false;
        setup.entryAlerted = false;
        setup.alertedAt = null;
        markDirty();
      }
      await trackOutcome(setup, quote, now);
    }
  }

  /**
   * Reads the bot's recent updates and saves the chat of the last person who
   * messaged it, so nobody has to look up a numeric chat ID by hand.
   */
  async function findTelegramChat(tokenOverride) {
    const token = String(tokenOverride || db.settings.telegramToken || "").trim();
    if (!token) return { status: 400, body: { error: "Paste your bot token first, then try again." } };
    let data;
    try {
      const res = await fetch("https://api.telegram.org/bot" + token + "/getUpdates?allowed_updates=%5B%22message%22%5D", {
        signal: AbortSignal.timeout(netTimeout)
      });
      data = await res.json();
    } catch (err) {
      return { status: 502, body: { error: "Could not reach Telegram: " + err.message } };
    }
    if (!data || data.ok === false) {
      return { status: 400, body: { error: data && data.error_code === 401 ? "Telegram rejected that bot token." : (data && data.description) || "Telegram returned an error." } };
    }
    const chats = (data.result || [])
      .map(u => u.message && u.message.chat)
      .filter(c => c && c.type === "private");
    const chat = chats[chats.length - 1];
    if (!chat) {
      return { status: 404, body: { error: "No messages found. Open your bot in Telegram, press Start (or send hi), then try again." } };
    }
    if (tokenOverride) db.settings.telegramToken = token;
    db.settings.telegramChatId = String(chat.id);
    markDirty();
    const state = fullState();
    state.foundChat = { id: String(chat.id), name: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "" };
    return { status: 200, body: state };
  }

  // -------------------------------------------------------------------- auth

  const TOKEN_TTL = 30 * 24 * 3600 * 1000;
  let failedLogins = 0;
  let lockedUntil = 0;

  function passwordSet() { return !!(db.auth && db.auth.hash); }
  function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString("hex");
  }
  function passwordMatches(password) {
    if (!passwordSet()) return false;
    const given = Buffer.from(hashPassword(password, db.auth.salt), "hex");
    const saved = Buffer.from(db.auth.hash, "hex");
    return given.length === saved.length && crypto.timingSafeEqual(given, saved);
  }
  function sign(payload) {
    return crypto.createHmac("sha256", db.auth.secret).update(payload).digest("base64url");
  }
  /** A signed login token: valid for 30 days or until the password changes. */
  function issueToken() {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TOKEN_TTL, v: db.auth.version })).toString("base64url");
    return "t1." + payload + "." + sign(payload);
  }
  function tokenValid(token) {
    if (!passwordSet() || !token) return false;
    const parts = String(token).split(".");
    if (parts.length !== 3 || parts[0] !== "t1") return false;
    const given = Buffer.from(parts[2]);
    const expected = Buffer.from(sign(parts[1]));
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return claims.exp > Date.now() && claims.v === db.auth.version;
    } catch (_) {
      return false;
    }
  }
  function setPassword(password) {
    const pw = String(password || "");
    if (pw.length < 8) throw new Error("Use at least 8 characters for your password.");
    if (pw.length > 200) throw new Error("That password is too long.");
    const salt = crypto.randomBytes(16).toString("hex");
    db.auth = {
      hash: hashPassword(pw, salt),
      salt,
      // A fresh secret signs out every other device whenever the password changes.
      secret: crypto.randomBytes(32).toString("hex"),
      version: ((db.auth && db.auth.version) || 0) + 1,
      setAt: nowISO()
    };
    markDirty();
  }

  const OPEN_ROUTES = new Set(["/api/health", "/api/auth/status", "/api/auth/login"]);

  /** Once a password is set, every route except login needs a valid token. */
  function authorize(pathname, token) {
    if (!passwordSet()) return true;
    if (OPEN_ROUTES.has(String(pathname || ""))) return true;
    return tokenValid(token);
  }

  function authRoute(p, body) {
    const data = body || {};
    if (p === "/api/auth/status") {
      return { status: 200, body: { passwordSet: passwordSet() } };
    }
    if (p === "/api/auth/login") {
      if (!passwordSet()) return { status: 400, body: { error: "No password is set yet." } };
      if (Date.now() < lockedUntil) {
        return { status: 429, body: { error: "Too many wrong tries. Wait " + Math.ceil((lockedUntil - Date.now()) / 1000) + " seconds and try again." } };
      }
      if (!passwordMatches(data.password)) {
        failedLogins++;
        if (failedLogins >= 5) { lockedUntil = Date.now() + 60000; failedLogins = 0; }
        return { status: 401, body: { error: "That password is not correct.", auth: "password" } };
      }
      failedLogins = 0;
      return { status: 200, body: { token: issueToken() } };
    }
    if (p === "/api/auth/password") {
      if (passwordSet() && !passwordMatches(data.current)) {
        return { status: 400, body: { error: "Your current password is not correct." } };
      }
      try { setPassword(data.password); } catch (err) { return { status: 400, body: { error: err.message } }; }
      const state = fullState();
      state.token = issueToken();
      return { status: 200, body: state };
    }
    if (p === "/api/auth/disable") {
      if (!passwordMatches(data.current)) return { status: 400, body: { error: "Your current password is not correct." } };
      db.auth = null;
      markDirty();
      return { status: 200, body: fullState() };
    }
    if (p === "/api/auth/logout-all") {
      if (!passwordSet()) return { status: 400, body: { error: "No password is set." } };
      db.auth.secret = crypto.randomBytes(32).toString("hex");
      db.auth.version += 1;
      markDirty();
      const state = fullState();
      state.token = issueToken();
      return { status: 200, body: state };
    }
    return null;
  }

  async function testCall() {
    if (!featureOn("telegramCalls")) return { status: 403, body: { error: "Telegram calls are switched off for now." } };
    if (!String(db.settings.callmebotUser || "").trim()) {
      return { status: 400, body: { error: "Add your Telegram username for calls in Settings first." } };
    }
    try {
      const result = await sendCall({ kind: "test", symbol: "EURUSD", message: "This is a test call from Tradera. Your entry calls are working." });
      return { status: 200, body: { results: [result] } };
    } catch (err) {
      return { status: 200, body: { results: [{ channel: "call", ok: false, error: err.message }] } };
    }
  }

  async function testAlert() {
    const configured = [];
    if (featureOn("ntfy") && db.settings.ntfyTopic) configured.push("ntfy");
    if (featureOn("telegram") && db.settings.telegramToken && db.settings.telegramChatId) configured.push("telegram");
    if (featureOn("pushover") && pushoverReady()) configured.push("pushover");
    if (pushOn()) configured.push("push");
    if (!configured.length) {
      return { status: 400, body: { error: "Set up Pushover, ntfy or a Telegram bot in Settings first." } };
    }
    const results = [];
    for (const channel of configured) {
      try {
        const alert = { kind: "test", symbol: "EURUSD", message: "Test alert from Tradera. Your entry alerts are wired up." };
        if (channel === "ntfy") results.push(await sendNtfy(alert));
        else if (channel === "pushover") results.push(await sendPushover(alert));
        else if (channel === "push") results.push(await sendWebPush(alert));
        else results.push(await sendTelegram(alert));
      } catch (err) {
        results.push({ channel, ok: false, error: err.message });
      }
    }
    return { status: 200, body: { results } };
  }

  // ----------------------------------------------------------------- derived

  function setupView(setup) {
    const quote = quotes[setup.symbol] || null;
    const pip = pipSize(setup.symbol);
    const entry = num(setup.entry);
    const direction = String(setup.direction || "long");
    const price = quote ? triggerPrice(quote, direction) : null;
    const distancePips = price !== null && entry !== null ? round(Math.abs(price - entry) / pip, 1) : null;
    const threshold = num(setup.thresholdPips, db.settings.defaultThresholdPips) || db.settings.defaultThresholdPips;
    const crossed = price !== null && entry !== null
      ? (direction === "short" ? price >= entry : price <= entry)
      : false;
    const pair = db.pairs.find(p => p.symbol === setup.symbol);
    return {
      ...setup,
      direction,
      entry,
      price,
      changePct: quote && quote.changePct !== undefined ? quote.changePct : null,
      distancePips,
      threshold,
      crossed,
      near: distancePips !== null && distancePips <= threshold,
      pairPriority: !!(pair && pair.priority),
      monitored: !!(pair && pair.monitor),
      rr: rrOf(setup),
      pip,
      unit: unitName(setup.symbol)
    };
  }

  function priorityList() {
    return db.setups
      .filter(s => s.status === "watching")
      .map(setupView)
      .sort((a, b) => {
        const pa = (a.pairPriority ? 0 : 400) + (a.priority === "high" ? 0 : a.priority === "medium" ? 40 : 80);
        const pb = (b.pairPriority ? 0 : 400) + (b.priority === "high" ? 0 : b.priority === "medium" ? 40 : 80);
        if (pa !== pb) return pa - pb;
        if (a.near !== b.near) return a.near ? -1 : 1;
        if (a.distancePips === null) return 1;
        if (b.distancePips === null) return -1;
        return a.distancePips - b.distancePips;
      });
  }

  function tradeNet(trade) {
    const pnl = num(trade.pnl, 0) || 0;
    const fees = num(trade.fees, 0) || 0;
    return pnl - fees;
  }

  function tradeR(trade) {
    const risk = num(trade.riskAmount);
    if (!risk) return null;
    return round(tradeNet(trade) / risk, 2);
  }

  function tradePips(trade) {
    const entry = num(trade.entry), exit = num(trade.exit);
    if (entry === null || exit === null) return null;
    const dir = String(trade.direction) === "short" ? -1 : 1;
    return round(((exit - entry) * dir) / pipSize(trade.symbol), 1);
  }

  function computeStats() {
    const closed = db.trades
      .filter(t => t.status === "closed" && t.closedAt)
      .slice()
      .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    const openTrades = db.trades.filter(t => t.status !== "closed");
    const nets = closed.map(tradeNet);
    const wins = nets.filter(n => n > 0);
    const losses = nets.filter(n => n < 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const totalR = closed.map(tradeR).filter(r => r !== null);
    const startingBalance = Number(db.settings.startingBalance) || 0;

    let equity = startingBalance;
    let peak = startingBalance;
    let maxDD = 0;
    let maxDDPct = 0;
    const curve = [{ t: closed.length ? new Date(closed[0].closedAt).getTime() : Date.now(), value: startingBalance }];
    const monthly = {};
    closed.forEach(t => {
      const net = tradeNet(t);
      equity += net;
      peak = Math.max(peak, equity);
      const dd = peak - equity;
      if (dd > maxDD) { maxDD = dd; maxDDPct = peak ? (dd / peak) * 100 : 0; }
      curve.push({ t: new Date(t.closedAt).getTime(), value: round(equity, 2) });
      const key = String(t.closedAt).slice(0, 7);
      if (!monthly[key]) monthly[key] = { pnl: 0, trades: 0, wins: 0 };
      monthly[key].pnl = round(monthly[key].pnl + net, 2);
      monthly[key].trades++;
      if (net > 0) monthly[key].wins++;
    });

    const byPair = {};
    closed.forEach(t => {
      if (!byPair[t.symbol]) byPair[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
      const net = tradeNet(t);
      byPair[t.symbol].pnl = round(byPair[t.symbol].pnl + net, 2);
      byPair[t.symbol].trades++;
      if (net > 0) byPair[t.symbol].wins++;
    });
    const pairRows = Object.values(byPair).sort((a, b) => b.pnl - a.pnl);

    let streak = 0;
    for (let i = nets.length - 1; i >= 0; i--) {
      if (nets[i] === 0) break;
      const sign = nets[i] > 0 ? 1 : -1;
      if (streak === 0) streak = sign;
      else if (Math.sign(streak) === sign) streak += sign;
      else break;
    }

    const holdHours = closed
      .filter(t => t.openedAt && t.closedAt)
      .map(t => (new Date(t.closedAt) - new Date(t.openedAt)) / 3600000)
      .filter(h => Number.isFinite(h) && h >= 0);

    const netPnl = round(nets.reduce((a, b) => a + b, 0), 2);
    const openRisk = openTrades.reduce((a, t) => a + (num(t.riskAmount) || 0), 0);

    return {
      startingBalance: round(startingBalance, 2),
      netPnl,
      netPnlPct: startingBalance ? round((netPnl / startingBalance) * 100, 2) : null,
      equity: round(equity, 2),
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: nets.length - wins.length - losses.length,
      winRate: nets.length ? round((wins.length / nets.length) * 100, 1) : null,
      profitFactor: grossLoss ? round(grossWin / grossLoss, 2) : (grossWin ? null : 0),
      avgWin: wins.length ? round(grossWin / wins.length, 2) : null,
      avgLoss: losses.length ? round(grossLoss / losses.length, 2) : null,
      expectancy: nets.length ? round(netPnl / nets.length, 2) : null,
      avgR: totalR.length ? round(totalR.reduce((a, b) => a + b, 0) / totalR.length, 2) : null,
      totalR: totalR.length ? round(totalR.reduce((a, b) => a + b, 0), 2) : null,
      maxDrawdown: round(maxDD, 2),
      maxDrawdownPct: round(maxDDPct, 2),
      currentStreak: streak,
      avgHoldHours: holdHours.length ? round(holdHours.reduce((a, b) => a + b, 0) / holdHours.length, 1) : null,
      openTrades: openTrades.length,
      openRisk: round(openRisk, 2),
      curve,
      monthly: Object.keys(monthly).sort().map(k => ({ month: k, ...monthly[k] })),
      byPair: pairRows,
      bestPair: pairRows.length ? pairRows[0] : null,
      worstPair: pairRows.length ? pairRows[pairRows.length - 1] : null
    };
  }

  function traceTrade(trade) {
    const net = trade.status === "closed" ? tradeNet(trade) : null;
    return {
      ...trade,
      netPnl: net,
      pnl: num(trade.pnl),
      fees: num(trade.fees, 0),
      riskAmount: num(trade.riskAmount),
      r: trade.status === "closed" ? tradeR(trade) : null,
      pips: tradePips(trade),
      rr: rrOf(trade)
    };
  }

  function snapshotPayload() {
    return {
      serverNow: Date.now(),
      realtime,
      quotes,
      priority: priorityList(),
      stats: computeStats(),
      feedStatus,
      alerts: db.alerts.slice(0, 50)
    };
  }

  function fullState() {
    return {
      settings: db.settings,
      pairs: db.pairs.map(p => ({
        ...p,
        quote: quotes[p.symbol] || null,
        tvSymbol: tvSymbol(p.symbol),
        pip: pipSize(p.symbol)
      })),
      setups: db.setups.map(setupView),
      trades: db.trades.map(traceTrade).sort((a, b) => {
        const ad = a.closedAt || a.openedAt || "";
        const bd = b.closedAt || b.openedAt || "";
        return bd.localeCompare(ad);
      }),
      alerts: db.alerts.slice(0, 150),
      quotes,
      priority: priorityList(),
      stats: computeStats(),
      feedStatus,
      demoMode: db.settings.feed === "demo",
      realtime,
      effectivePollSeconds: effectivePollSeconds(),
      passwordSet: passwordSet(),
      readerAI: reader.aiAvailable(),
      alarm: {
        available: featureOn("alarm"),
        devices: db.alarmDevices.map(d => ({ id: d.id, label: d.label, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt || null }))
      },
      push: {
        available: featureOn("webpush") && push.pushReady(),
        publicKey: push.pushReady() ? push.pushKeys().publicKey : null,
        devices: db.pushSubs.map(s => ({ id: deviceId(s.endpoint), label: s.label || "Device", addedAt: s.addedAt || null }))
      },
      pushoverApp: !!String(process.env.PUSHOVER_APP_TOKEN || "").trim(),
      nextReminderAt: (() => { try { const n = nextReminder(); return n ? n.toISOString() : null; } catch (_) { return null; } })()
    };
  }

  // ---------------------------------------------------------------- mutations

  function normalizeTradeInput(body) {
    const direction = body.direction === "short" ? "short" : "long";
    const status = body.status === "closed" ? "closed" : "open";
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) throw new Error("Pair is required");
    const entry = num(body.entry);
    if (entry === null || entry <= 0) throw new Error("Entry price is required");
    const stop = num(body.stop);
    const target = num(body.target);
    const exit = num(body.exit);
    const riskAmount = num(body.riskAmount);
    const size = num(body.size);
    const fees = num(body.fees, 0) || 0;

    let pnl = num(body.pnl);
    let autoPnl = false;
    if (status === "closed" && pnl === null && exit !== null && riskAmount && stop) {
      const riskDistance = Math.abs(entry - stop);
      if (riskDistance > 0) {
        pnl = riskAmount * (((exit - entry) * (direction === "short" ? -1 : 1)) / riskDistance);
        autoPnl = true;
      }
    }
    if (status === "closed" && pnl === null) pnl = 0;

    const openedAt = body.openedAt ? new Date(body.openedAt).toISOString() : nowISO();
    const closedAt = status === "closed"
      ? (body.closedAt ? new Date(body.closedAt).toISOString() : nowISO())
      : null;

    const trade = {
      id: body.id || uid(),
      symbol,
      direction,
      status,
      entry,
      stop,
      target,
      exit: status === "closed" ? exit : null,
      size,
      riskAmount,
      pnl: pnl === null ? null : round(pnl, 2),
      autoPnl,
      fees: round(fees, 2),
      openedAt,
      closedAt,
      setupId: body.setupId || null,
      setupLabel: body.setupLabel || "",
      tags: String(body.tags || "").slice(0, 200),
      notes: String(body.notes || "").slice(0, 4000),
      imageUrl: String(body.imageUrl || "").slice(0, 1000)
    };
    // Screenshots and the review are only changed when the form sends them,
    // so older clients and quick edits never wipe them.
    if (body.images !== undefined) {
      let list = body.images;
      if (typeof list === "string") { try { list = JSON.parse(list || "[]"); } catch (_) { list = []; } }
      trade.images = cleanImages(list);
    }
    if (body.verdict !== undefined) trade.verdict = ["worked", "failed", "mixed"].includes(body.verdict) ? body.verdict : "";
    if (body.followedPlan !== undefined) trade.followedPlan = ["yes", "no"].includes(body.followedPlan) ? body.followedPlan : "";
    if (body.why !== undefined) trade.why = String(body.why || "").slice(0, 4000);
    if (body.lesson !== undefined) trade.lesson = String(body.lesson || "").slice(0, 2000);

    // Only logging a NEW trade from a setup moves that setup on. Editing an
    // existing trade later must never flip a setup the user is still watching.
    const isNewTrade = !body.id || !db.trades.some(t => t.id === body.id);
    if (trade.setupId && isNewTrade) {
      const setup = db.setups.find(s => s.id === trade.setupId);
      if (setup) {
        setup.logPrompt = false;
        setup.loggedTradeId = trade.id;
        setup.status = status === "closed" ? "done" : "triggered";
        setup.triggeredAt = setup.triggeredAt || nowISO();
        if (status === "closed") setup.doneAt = nowISO();
      }
    }
    return trade;
  }

  function normalizeSetupInput(body) {
    const symbol = cleanSymbol(body.symbol);
    if (!symbol) throw new Error("Pair is required");
    const entry = num(body.entry);
    if (entry === null || entry <= 0) throw new Error("Entry price is required");
    const direction = body.direction === "short" ? "short" : "long";
    const status = ["watching", "triggered", "invalidated", "done"].includes(body.status) ? body.status : "watching";
    const priority = ["high", "medium", "low"].includes(body.priority) ? body.priority : "medium";
    const target = num(body.target);
    const stop = num(body.stop);
    return {
      id: body.id || uid(),
      symbol,
      direction,
      entry,
      stop,
      target,
      priority,
      thresholdPips: num(body.thresholdPips) ?? db.settings.defaultThresholdPips,
      status,
      label: String(body.label || "").slice(0, 160),
      note: String(body.note || "").slice(0, 2000),
      createdAt: body.createdAt || nowISO(),
      updatedAt: nowISO(),
      alerted: false,
      alertedAt: null,
      alertedPrice: null
    };
  }

  /**
   * Apply one API action in memory.
   * Returns { status, body, poll?, settingsChanged? }.
   */
  /** Delete stored screenshots that a trade no longer uses. */
  async function dropImages(before, after) {
    const keep = new Set((after || []).map(x => x.id));
    for (const img of before || []) {
      if (img && img.id && !keep.has(img.id)) {
        try { await images.remove(img.id); } catch (_) { /* already gone */ }
      }
    }
  }

  async function handle(method, pathname, body) {
    const m = String(method || "GET").toUpperCase();
    const p = String(pathname || "");

    if (p === "/api/state" && m === "GET") {
      return { status: 200, body: fullState() };
    }

    const imaged = await imageRoute(images, m, p, body);
    if (imaged) return imaged;

    if (p.startsWith("/api/auth/")) {
      const result = authRoute(p, body);
      if (result) return result;
    }

    if (p === "/api/pairs" && m === "POST") {
      const data = body || {};
      const symbol = cleanSymbol(data.symbol);
      if (!symbol) return { status: 400, body: { error: "Pair symbol is required" } };
      if (db.pairs.some(pair => pair.symbol === symbol)) {
        return { status: 409, body: { error: symbol + " is already in your list" } };
      }
      db.pairs.push({ symbol, priority: !!data.priority, monitor: data.monitor !== false });
      markDirty();
      return { status: 200, body: fullState(), poll: true };
    }

    if (p === "/api/pairs/bulk" && m === "POST") {
      const list = Array.isArray(body && body.symbols) ? body.symbols : [];
      let added = 0;
      list.slice(0, 100).forEach(raw => {
        const symbol = cleanSymbol(raw);
        if (!symbol || db.pairs.some(pair => pair.symbol === symbol)) return;
        db.pairs.push({ symbol, priority: false, monitor: true });
        added++;
      });
      if (added) markDirty();
      const state = fullState();
      state.added = added;
      return { status: 200, body: state, poll: added > 0 };
    }

    if (p.startsWith("/api/pairs/") && m === "PATCH") {
      const symbol = cleanSymbol(decodeURIComponent(p.split("/").pop()));
      const pair = db.pairs.find(x => x.symbol === symbol);
      if (!pair) return { status: 404, body: { error: "Pair not found" } };
      const data = body || {};
      if (data.priority !== undefined) pair.priority = !!data.priority;
      if (data.monitor !== undefined) pair.monitor = !!data.monitor;
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p.startsWith("/api/pairs/") && m === "DELETE") {
      const symbol = cleanSymbol(decodeURIComponent(p.split("/").pop()));
      db.pairs = db.pairs.filter(x => x.symbol !== symbol);
      db.setups = db.setups.filter(s => s.symbol !== symbol);
      markDirty();
      return { status: 200, body: fullState() };
    }

    // Read setups out of pasted text or a screenshot. Nothing is saved: the
    // app shows what was read so the user can fix it before watching.
    if (p === "/api/push/subscribe" && m === "POST") {
      if (!featureOn("webpush") || !push.pushReady()) return { status: 400, body: { error: "Tradera notifications aren't available on this site yet." } };
      const sub = push.cleanSubscription(body && body.subscription);
      if (!sub) return { status: 400, body: { error: "This browser gave an invalid notification address. Try again." } };
      const label = String((body && body.label) || "Device").replace(/[^\w\s().,'-]/g, "").slice(0, 40) || "Device";
      db.pushSubs = db.pushSubs.filter(s => s.endpoint !== sub.endpoint);
      db.pushSubs.unshift({ ...sub, label, addedAt: nowISO() });
      db.pushSubs = db.pushSubs.slice(0, 10);
      markDirty();
      return { status: 200, body: fullState() };
    }

    // From the notification itself (no login: the alert's own key is the proof).
    if (p === "/api/push/ack" && m === "POST") {
      const stopped = stopRinging(String((body && body.a) || ""), String((body && body.k) || ""));
      return { status: 200, body: { stopped } };
    }
    if (p === "/api/push/ack-all" && m === "POST") {
      return { status: 200, body: { stopped: stopRinging(null) } };
    }

    // Pair the Android app's loud alarm. The key is shown once, inside the
    // link the app opens; only its hash is kept.
    if (p === "/api/alarm/pair" && m === "POST") {
      if (!featureOn("alarm")) return { status: 400, body: { error: "The phone alarm is switched off for now." } };
      const id = crypto.randomBytes(6).toString("hex");
      const key = crypto.randomBytes(24).toString("hex");
      const label = String((body && body.label) || "Android phone").replace(/[^\w\s().,'-]/g, "").slice(0, 40) || "Android phone";
      db.alarmDevices.unshift({ id, keyHash: hashKey(key), label, addedAt: nowISO() });
      db.alarmDevices = db.alarmDevices.slice(0, 10);
      markDirty();
      return { status: 200, body: { ...fullState(), pair: { d: id, k: key, u: opts.accountId || "" } } };
    }
    if (p === "/api/alarm/unpair" && m === "POST") {
      const id = String((body && body.id) || "");
      db.alarmDevices = db.alarmDevices.filter(x => x.id !== id);
      markDirty();
      return { status: 200, body: fullState() };
    }
    if (p === "/api/alarm/test" && m === "POST") {
      if (!alarmOn()) return { status: 400, body: { error: "Pair this phone's alarm first." } };
      const alert = {
        id: uid(), at: Date.now(), symbol: "EURUSD", kind: "entry", channels: [],
        message: "Test alarm from Tradera. Tap Stop to end it.",
        ring: { key: crypto.randomBytes(12).toString("hex"), sent: 1, lastAt: Date.now(), until: Date.now() + 3 * 60 * 1000 },
        ringing: true, test: true
      };
      db.alerts.unshift(alert);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/push/unsubscribe" && m === "POST") {
      const endpoint = String((body && body.endpoint) || "");
      const id = String((body && body.id) || "");
      db.pushSubs = db.pushSubs.filter(s => s.endpoint !== endpoint && deviceId(s.endpoint) !== id);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/push/test" && m === "POST") {
      if (!pushOn()) return { status: 400, body: { error: "Turn on notifications on this device first." } };
      try {
        const r = await sendWebPush({ kind: "test", symbol: "EURUSD", message: "Tradera notifications are working on this device." });
        return { status: 200, body: { ...fullState(), results: [r] } };
      } catch (err) {
        return { status: 502, body: { error: "Sending failed: " + err.message } };
      }
    }

    if (p === "/api/setups/read" && m === "POST") {
      const data = body || {};
      const known = db.pairs.map(x => x.symbol);
      if (data.image) {
        let img;
        try { img = decodeImage(data.image); } catch (err) { return { status: 400, body: { error: err.message } }; }
        if (!reader.aiAvailable()) {
          return { status: 400, body: { error: "Chart reading is not switched on.", needsText: true } };
        }
        try {
          const out = await reader.readImageWithAI(img.data.toString("base64"), img.contentType, { known });
          return { status: 200, body: { setups: out.setups, problem: out.problem, via: "ai" } };
        } catch (err) {
          return { status: 502, body: { error: err.message, needsText: true } };
        }
      }
      const text = String(data.text || "");
      if (!text.trim()) return { status: 400, body: { error: "Paste a setup or signal first." } };
      const setups = reader.parseSetupText(text, { known });
      return {
        status: 200,
        body: {
          setups,
          problem: setups.length ? null : "No prices found. Paste a signal with an entry price, like: EURUSD buy 1.0850 SL 1.0820 TP 1.0910",
          via: "text"
        }
      };
    }

    if (p === "/api/setups/batch" && m === "POST") {
      const list = Array.isArray(body && body.setups) ? body.setups.slice(0, 20) : [];
      if (!list.length) return { status: 400, body: { error: "No setups to add." } };
      const made = [];
      try {
        list.forEach(raw => made.push(normalizeSetupInput({ ...raw, id: undefined, status: "watching" })));
      } catch (err) {
        return { status: 400, body: { error: err.message } };
      }
      made.forEach(setup => {
        db.setups.push(setup);
        if (!db.pairs.some(pair => pair.symbol === setup.symbol)) {
          db.pairs.push({ symbol: setup.symbol, priority: setup.priority === "high", monitor: true });
        }
      });
      markDirty();
      const state = fullState();
      state.added = made.length;
      return { status: 200, body: state, poll: true };
    }

    if (p === "/api/setups" && m === "POST") {
      const setup = normalizeSetupInput(body || {});
      const i = db.setups.findIndex(s => s.id === setup.id);
      if (i >= 0) {
        const before = db.setups[i];
        const moved = Number(before.entry) !== setup.entry || num(before.stop) !== setup.stop ||
          num(before.target) !== setup.target || before.direction !== setup.direction;
        db.setups[i] = { ...before, ...setup, createdAt: before.createdAt };
        if (moved || setup.status === "watching") {
          ["entryHitAt", "outcome", "logPrompt", "notTaken"].forEach(k => { delete db.setups[i][k]; });
        }
      }
      else db.setups.push(setup);
      if (!db.pairs.some(pair => pair.symbol === setup.symbol)) {
        db.pairs.push({ symbol: setup.symbol, priority: setup.priority === "high", monitor: true });
      }
      markDirty();
      return { status: 200, body: fullState(), poll: true };
    }

    if (p.startsWith("/api/setups/") && m === "DELETE") {
      const id = decodeURIComponent(p.split("/").pop());
      db.setups = db.setups.filter(s => s.id !== id);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p.startsWith("/api/setups/") && p.endsWith("/skip-log") && m === "POST") {
      const id = decodeURIComponent(p.split("/")[3]);
      const setup = db.setups.find(x => x.id === id);
      if (!setup) return { status: 404, body: { error: "Setup not found" } };
      setup.logPrompt = false;
      setup.notTaken = true;
      setup.updatedAt = nowISO();
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p.startsWith("/api/setups/") && p.endsWith("/status") && m === "POST") {
      const parts = p.split("/");
      const id = decodeURIComponent(parts[3]);
      const setup = db.setups.find(s => s.id === id);
      if (!setup) return { status: 404, body: { error: "Setup not found" } };
      const data = body || {};
      if (["watching", "triggered", "invalidated", "done"].includes(data.status)) {
        setup.status = data.status;
        if (data.status === "watching") {
          setup.alerted = false;
          setup.entryAlerted = false;
          setup.alertedAt = null;
          ["entryHitAt", "outcome", "logPrompt", "notTaken"].forEach(k => { delete setup[k]; });
        }
        setup.updatedAt = nowISO();
      }
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/trades" && m === "POST") {
      const trade = normalizeTradeInput(body || {});
      const i = db.trades.findIndex(t => t.id === trade.id);
      if (i >= 0 && trade.images) await dropImages(db.trades[i].images, trade.images);
      if (i >= 0) db.trades[i] = { ...db.trades[i], ...trade };
      else db.trades.push(trade);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p.startsWith("/api/trades/") && p.endsWith("/close") && m === "POST") {
      const parts = p.split("/");
      const id = decodeURIComponent(parts[3]);
      const trade = db.trades.find(t => t.id === id);
      if (!trade) return { status: 404, body: { error: "Trade not found" } };
      const data = body || {};
      const updated = normalizeTradeInput({
        ...trade,
        ...data,
        id: trade.id,
        status: "closed",
        closedAt: data.closedAt || nowISO()
      });
      if (updated.images) await dropImages(trade.images, updated.images);
      Object.assign(trade, updated);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p.startsWith("/api/trades/") && m === "DELETE") {
      const id = decodeURIComponent(p.split("/").pop());
      const gone = db.trades.find(t => t.id === id);
      if (gone) await dropImages(gone.images, []);
      db.trades = db.trades.filter(t => t.id !== id);
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/settings" && m === "POST") {
      const data = body || {};
      const s = db.settings;
      if (typeof data.accountCurrency === "string") s.accountCurrency = data.accountCurrency.trim().toUpperCase().slice(0, 6) || "USD";
      if (data.startingBalance !== undefined) s.startingBalance = Number(data.startingBalance) || 0;
      if (["deriv", "yahoo", "oanda", "twelvedata", "demo"].includes(data.feed)) s.feed = data.feed;
      if (typeof data.oandaToken === "string" && data.oandaToken.trim() !== s.oandaToken) {
        s.oandaToken = data.oandaToken.trim();
        oandaAccount = null;
      }
      if (["practice", "live"].includes(data.oandaEnv) && data.oandaEnv !== s.oandaEnv) {
        s.oandaEnv = data.oandaEnv;
        oandaAccount = null;
      }
      if (data.binanceCrypto !== undefined) s.binanceCrypto = data.binanceCrypto === true || data.binanceCrypto === "on" || data.binanceCrypto === "true";
      if (typeof data.callmebotUser === "string") s.callmebotUser = data.callmebotUser.trim();
      if (data.callOnApproach !== undefined) s.callOnApproach = data.callOnApproach === true || data.callOnApproach === "on" || data.callOnApproach === "true";
      if (typeof data.twelveDataKey === "string") s.twelveDataKey = data.twelveDataKey.trim();
      if (data.pollSeconds !== undefined) s.pollSeconds = clamp(Number(data.pollSeconds) || 20, 5, 600);
      if (data.defaultThresholdPips !== undefined) s.defaultThresholdPips = Math.max(1, Number(data.defaultThresholdPips) || 15);
      if (typeof data.ntfyServer === "string") s.ntfyServer = data.ntfyServer.trim() || "https://ntfy.sh";
      if (typeof data.ntfyTopic === "string") s.ntfyTopic = data.ntfyTopic.trim();
      if (typeof data.pushoverUser === "string") {
        const key = data.pushoverUser.trim();
        if (key && !/^[A-Za-z0-9]{30}$/.test(key)) return { status: 400, body: { error: "A Pushover user key is 30 letters and numbers. Copy it from the top of the Pushover app or pushover.net." } };
        s.pushoverUser = key;
      }
      if (typeof data.pushoverToken === "string") {
        const tok = data.pushoverToken.trim();
        if (tok && !/^[A-Za-z0-9]{30}$/.test(tok)) return { status: 400, body: { error: "A Pushover app token is 30 letters and numbers." } };
        s.pushoverToken = tok;
      }
      if (typeof data.telegramToken === "string") s.telegramToken = data.telegramToken.trim();
      if (typeof data.telegramChatId === "string") s.telegramChatId = data.telegramChatId.trim();
      if (typeof data.appUrl === "string") s.appUrl = data.appUrl.trim() || s.appUrl;
      if (s.feed === "twelvedata") s.pollSeconds = clamp(s.pollSeconds, 60, 600);
      markDirty();
      return { status: 200, body: fullState(), poll: true, settingsChanged: true };
    }

    if (p === "/api/test-alert" && m === "POST") {
      return testAlert();
    }

    if (p === "/api/reminders" && m === "POST") {
      const r = cleanReminders({ ...db.settings.reminders, ...(body || {}) });
      if (r.enabled && !r.days.length) return { status: 400, body: { error: "Pick at least one day for your chart checks." } };
      if (toMinutes(r.to) < toMinutes(r.from)) return { status: 400, body: { error: "The last check must be later than the first one." } };
      db.settings.reminders = r;
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/reminders/test" && m === "POST") {
      const alert = await sendReminder("reminder");
      markDirty();
      return { status: 200, body: { ...fullState(), testResult: alert.channels } };
    }

    if (p === "/api/reminders/feed-key" && m === "POST") {
      if (!db.settings.feedKey || (body && body.rotate)) db.settings.feedKey = crypto.randomBytes(24).toString("hex");
      markDirty();
      return { status: 200, body: fullState() };
    }

    if (p === "/api/test-call" && m === "POST") {
      return testCall();
    }

    if (p === "/api/telegram/find-chat" && m === "POST") {
      return findTelegramChat(body && typeof body.token === "string" ? body.token : "");
    }

    if (p === "/api/export" && m === "GET") {
      const { auth, ...backup } = db;
      return { status: 200, body: backup, export: true };
    }

    if (p === "/api/import" && m === "POST") {
      const data = body || {};
      if (!data || typeof data !== "object" || !Array.isArray(data.trades)) {
        return { status: 400, body: { error: "That does not look like a Tradera backup." } };
      }
      const keepAuth = db.auth;
      db = normalizeDB(data);
      db.auth = keepAuth;
      quotes = {};
      feedStatus = { ok: true, error: null, at: 0, source: db.settings.feed };
      markDirty();
      return { status: 200, body: fullState(), poll: true };
    }

    return { status: 404, body: { error: "Unknown API route" } };
  }

  return {
    load,
    save,
    poll,
    ensureFresh,
    needsFresh,
    pollSnapshot,
    mergePoll,
    hasQuotes: () => Object.keys(quotes).length > 0,
    checkReminders,
    reminderFeed,
    remindersOn: () => !!(db.settings.reminders.enabled && db.settings.reminders.days.length),
    isRinging: () => db.alerts.some(a => a.ringing),
    alarmPoll,
    reRing,
    evaluateAlerts,
    // test hooks: put a live price in and run the alert checks
    _setQuote(symbol, price) { quotes[symbol] = { price, bid: price, ask: price, updatedAt: Date.now(), stale: false }; },
    _evaluate: evaluateAlerts,
    handle,
    authorize,
    passwordSet,
    testAlert,
    effectivePollSeconds,
    snapshot: snapshotPayload,
    state: fullState,
    symbolList,
    get dirty() { return dirty; },
    get settings() { return db.settings; }
  };
}

module.exports = {
  createDesk,
  setFeatures,
  createMemoryImages,
  imageRoute,
  cleanReminders,
  reminderSlots,
  zonedParts,
  zonedInstant,
  decodeImage,
  defaultDB,
  normalizeDB,
  // exported for tests and wrappers
  cleanSymbol,
  toOandaInstrument,
  toBinanceSymbol,
  toDerivSymbol,
  symbolLabel,
  SYNTHETICS,
  triggerPrice,
  pipSize,
  priceDecimals,
  unitName,
  fmtPrice,
  tvSymbol
};
