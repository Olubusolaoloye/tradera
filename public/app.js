"use strict";

/* ------------------------------------------------------------------ setup */

const viewEl = document.getElementById("view");
const modal = document.getElementById("modal");
const modalBody = document.getElementById("modalBody");
const toastsEl = document.getElementById("toasts");

/* Settings stored on this device. Keys moved from "td:" to "tradera:" with the
   rename; legacy values are still read so nobody gets logged out. */
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem("tradera:" + key) || localStorage.getItem("td:" + key) || "";
    if (value === null) {
      localStorage.removeItem("tradera:" + key);
      localStorage.removeItem("td:" + key);
    } else {
      localStorage.setItem("tradera:" + key, value);
    }
  } catch (_) { /* private mode */ }
  return "";
}

const ui = {
  view: "dashboard",
  journal: { q: "", status: "all", pair: "all" },
  browserAlerts: store("browserAlerts") === "1"
};

let state = null;
let eventSource = null;
let clockTimer = null;
let pollTimer = null;
let pollBusy = false;
let sseFailures = 0;
const seenAlerts = new Set();

const VIEW_META = {
  dashboard: { title: "Overview", sub: "Where your book stands and what is closest to entry" },
  journal: { title: "Journal", sub: "Every trade, its result and what you learned" },
  setups: { title: "Setups", sub: "Trades you are waiting for, closest to entry first" },
  pairs: { title: "Markets", sub: "The instruments Tradera watches for you" },
  alerts: { title: "Alerts", sub: "How and where you hear that price is near your entry" },
  settings: { title: "Settings", sub: "Account, price feed, notifications and backups" }
};

const ICONS = {
  chart: '<path d="M4 19V5m0 14h16M8 15l3-4 3 2 4-6"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16v4Zm9-13 4 4"/>',
  play: '<path d="M8 5v14l11-7-11-7Z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
  star: '<path d="m12 3 2.7 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17.3 6.5 20.2l1.1-6.2L3 9.6l6.3-.9L12 3Z"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7M10.5 20a2 2 0 0 0 3 0"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/>'
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
}

/* ---------------------------------------------------------------- helpers */

function esc(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function n(value) {
  if (value === "" || value === null || value === undefined) return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}
function fmtMoney(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const places = digits === undefined ? 2 : digits;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (state && state.settings.accountCurrency) || "USD",
      minimumFractionDigits: places,
      maximumFractionDigits: places
    }).format(Number(value));
  } catch (_) {
    return Number(value).toFixed(places);
  }
}
function fmtSignedMoney(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return (Number(value) > 0 ? "+" : "") + fmtMoney(value);
}
function fmtNum(value, digits) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits === undefined ? 2 : digits,
    maximumFractionDigits: digits === undefined ? 2 : digits
  });
}
/* Market catalog, grouped the way traders think about it. Synthetic entries
   mirror SYNTHETICS in lib/desk-core.js (label, decimals, step size). */
const SYNTHETICS = {
  R_10: { label: "V10", name: "Volatility 10 Index", dec: 3 },
  R_25: { label: "V25", name: "Volatility 25 Index", dec: 3 },
  R_50: { label: "V50", name: "Volatility 50 Index", dec: 4 },
  R_75: { label: "V75", name: "Volatility 75 Index", dec: 4 },
  R_100: { label: "V100", name: "Volatility 100 Index", dec: 2 },
  "1HZ10V": { label: "V10 (1s)", name: "Volatility 10 (1s) Index", dec: 2 },
  "1HZ15V": { label: "V15 (1s)", name: "Volatility 15 (1s) Index", dec: 3 },
  "1HZ25V": { label: "V25 (1s)", name: "Volatility 25 (1s) Index", dec: 2 },
  "1HZ30V": { label: "V30 (1s)", name: "Volatility 30 (1s) Index", dec: 3 },
  "1HZ50V": { label: "V50 (1s)", name: "Volatility 50 (1s) Index", dec: 2 },
  "1HZ75V": { label: "V75 (1s)", name: "Volatility 75 (1s) Index", dec: 2 },
  "1HZ90V": { label: "V90 (1s)", name: "Volatility 90 (1s) Index", dec: 3 },
  "1HZ100V": { label: "V100 (1s)", name: "Volatility 100 (1s) Index", dec: 2 },
  STPRNG: { label: "Step 100", name: "Step Index 100", dec: 1, step: true },
  STPRNG2: { label: "Step 200", name: "Step Index 200", dec: 1, step: true },
  STPRNG3: { label: "Step 300", name: "Step Index 300", dec: 1, step: true },
  STPRNG4: { label: "Step 400", name: "Step Index 400", dec: 1, step: true },
  STPRNG5: { label: "Step 500", name: "Step Index 500", dec: 1, step: true }
};

const MARKET_GROUPS = [
  { id: "majors", name: "Forex majors", symbols: ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD"] },
  { id: "minors", name: "Forex minors", symbols: ["EURGBP", "EURJPY", "EURCHF", "EURAUD", "EURCAD", "EURNZD", "GBPJPY", "GBPCHF", "GBPAUD", "GBPCAD", "GBPNZD", "AUDJPY", "AUDCHF", "AUDCAD", "AUDNZD", "CADJPY", "CADCHF", "CHFJPY", "NZDJPY", "NZDCHF", "NZDCAD"] },
  { id: "metals", name: "Metals", symbols: ["XAUUSD", "XAGUSD"] },
  { id: "indices", name: "Stock indices", symbols: ["US30", "NAS100", "SPX500", "GER40", "UK100", "JP225"] },
  { id: "crypto", name: "Crypto", symbols: ["BTCUSD", "ETHUSD"] },
  { id: "volatility", name: "Volatility indices", symbols: ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V", "1HZ75V", "1HZ90V", "1HZ100V"] },
  { id: "step", name: "Step indices", symbols: ["STPRNG", "STPRNG2", "STPRNG3", "STPRNG4", "STPRNG5"] }
];

function synthetic(symbol) {
  return SYNTHETICS[String(symbol || "").toUpperCase()] || null;
}
/** What traders call the market: V75 (1s), Step 200, EURUSD… */
function symLabel(symbol) {
  const syn = synthetic(symbol);
  return syn ? syn.label : String(symbol || "");
}
function marketGroup(symbol) {
  const s = String(symbol || "").toUpperCase();
  return MARKET_GROUPS.find(g => g.symbols.includes(s)) || null;
}

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
function pairKind(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (SYNTHETICS[s]) return SYNTHETICS[s].name;
  if (s.startsWith("Y:")) return s.slice(2);
  if (/XAU|GOLD/.test(s)) return "Gold spot";
  if (/XAG|SILVER/.test(s)) return "Silver spot";
  if (/^(BTC|ETH|SOL|DOGE|XRP|ADA|BNB)/.test(s)) return "Crypto";
  if (/US30|NAS100|SPX500|GER40|UK100|JP225|US2000/.test(s)) return "Index";
  if (/OIL|WTI|BRENT/.test(s)) return "Energy";
  if (/^[A-Z]{6}$/.test(s)) return /JPY$/.test(s) ? "FX · JPY pair" : "FX pair";
  return "Instrument";
}
function fmtPrice(symbol, price) {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return "—";
  return Number(price).toFixed(priceDecimals(symbol));
}
function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
}
function fmtDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - Number(ts);
  if (diff < 45000) return "just now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return mins + "m ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}
function monthLabel(key) {
  const [y, m] = String(key).split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short" });
}
function toLocalInput(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function dirTag(direction) {
  const short = String(direction) === "short";
  return '<span class="side-tag ' + (short ? "short" : "long") + '"><span class="arr">' +
    (short ? "▼" : "▲") + "</span>" + (short ? "SHORT" : "LONG") + "</span>";
}
function pnlClass(value) {
  if (value === null || value === undefined) return "";
  return Number(value) > 0 ? "pos" : Number(value) < 0 ? "neg" : "";
}
function statusPill(setup) {
  if (setup.status === "triggered") return '<span class="pill triggered">Triggered</span>';
  if (setup.status === "invalidated") return '<span class="pill invalidated">Invalidated</span>';
  if (setup.status === "done") return '<span class="pill done">Done</span>';
  if (setup.crossed) return '<span class="pill entry">At entry</span>';
  if (setup.near) return '<span class="pill near">Near</span>';
  return '<span class="pill watching">Watching</span>';
}
function rrText(rr) {
  return rr === null || rr === undefined ? "—" : "1 : " + fmtNum(rr, 2);
}
function quoteOf(symbol) {
  return (state && state.quotes && state.quotes[symbol]) || null;
}
function isStale(q) {
  if (!q) return true;
  if (q.stale) return true;
  return q.updatedAt && Date.now() - q.updatedAt > 120000;
}
function setupDistanceText(setup) {
  if (setup.distancePips === null || setup.distancePips === undefined) return "waiting for price";
  if (setup.crossed) return "at entry";
  return fmtNum(setup.distancePips, 1) + " " + unitName(setup.symbol) + " away";
}
function meterWidth(setup) {
  if (setup.distancePips === null || setup.distancePips === undefined) return 0;
  const threshold = setup.threshold || 1;
  return Math.max(4, Math.min(100, (1 - Math.min(setup.distancePips / threshold, 1)) * 100));
}

/* -------------------------------------------------------------------- data */

function deskKey() {
  return store("key");
}
function authHeaders() {
  const key = deskKey();
  return key ? { "x-desk-key": key } : {};
}
/**
 * mode "account": email + password accounts (Netlify). "password": the local
 * app password from Settings. "passcode": Netlify's single-user DESK_PASSCODE.
 */
async function showGate(mode) {
  const gate = document.getElementById("gate");
  if (!gate) return;
  if (mode === "account") {
    ui.authMode = "account";
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      ui.authInfo = await res.json();
    } catch (_) {
      ui.authInfo = ui.authInfo || { signups: true };
    }
    const info = ui.authInfo || {};
    if (info.maintenance) { showMaintenance(info.maintenance.message); return; }
    setGateStep(store("email") || info.signups === false ? "login" : info.legacy ? "signup" : "login");
    gate.hidden = false;
    return;
  }
  ["gateEmailField", "gateRepeatField", "gateLegacy", "gateSwitch"].forEach(id => { document.getElementById(id).hidden = true; });
  document.getElementById("gateTitle").textContent = "Welcome back to Tradera";
  document.getElementById("gateSubmit").textContent = "Log in";
  ui.authMode = mode === "passcode" ? "passcode" : "password";
  const passcode = ui.authMode === "passcode";
  document.getElementById("gateText").textContent = passcode
    ? "Your journal is private. Enter your site passcode to open it on this device."
    : "Your journal is private. Enter your password to open it on this device.";
  document.getElementById("gateLabel").textContent = passcode ? "Passcode" : "Password";
  document.getElementById("gateNote").innerHTML = passcode
    ? "The passcode is the <b>DESK_PASSCODE</b> setting on your Netlify site. Set your own password later in Settings."
    : "You'll stay logged in on this device for 30 days.";
  gate.hidden = false;
  const input = document.getElementById("gateKey");
  if (input) {
    input.value = "";
    input.placeholder = passcode ? "Your passcode" : "Your password";
    setTimeout(function () { input.focus(); }, 50);
  }
}

/** Switch the account gate between "login" and "signup". */
function setGateStep(step) {
  const info = ui.authInfo || {};
  const signup = step === "signup" && info.signups !== false;
  ui.gateStep = signup ? "signup" : "login";
  const $ = id => document.getElementById(id);
  $("gateTitle").textContent = signup ? "Create your Tradera account" : "Welcome back to Tradera";
  $("gateText").textContent = signup
    ? "Your journal, setups and alert settings are saved to your account. Log in with the same email on any device."
    : "Log in with your email and password.";
  $("gateEmailField").hidden = false;
  $("gateLabel").textContent = signup ? "Choose a password" : "Password";
  const key = $("gateKey");
  key.value = "";
  key.placeholder = signup ? "At least 10 characters" : "Your password";
  key.autocomplete = signup ? "new-password" : "current-password";
  $("gateRepeatField").hidden = !signup;
  $("gateRepeat").value = "";
  const legacy = signup && info.legacy;
  $("gateLegacy").hidden = !legacy;
  $("gateLegacyPw").hidden = !info.legacyNeedsPassword;
  $("gateLegacyCheckLine").hidden = !!info.legacyNeedsPassword;
  $("gateLegacyText").textContent = info.legacyNeedsPassword
    ? "Enter the password you use today and your journal, setups and alert settings move into this new account. Leave it empty to start fresh."
    : "Tick the box to move the journal that is already on this site into your new account.";
  $("gateSubmit").textContent = signup ? "Create account" : "Log in";
  $("gateSwitch").hidden = info.signups === false && !signup;
  $("gateSwitch").innerHTML = signup
    ? 'Already have an account? <button type="button" class="link-btn" data-gate="login">Log in</button>'
    : 'New to Tradera? <button type="button" class="link-btn" data-gate="signup">Create an account</button>';
  $("gateNote").textContent = signup
    ? "There is no password reset by email, so keep your password somewhere safe."
    : "You'll stay logged in on this device for 30 days.";
  $("gateError").hidden = true;
  const email = $("gateEmail");
  if (!email.value) email.value = store("email") || "";
}

function signOutLocally() {
  store("key", null);
  store("lastState", null);
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  state = null;
  if (viewEl) viewEl.innerHTML = "";
}
function hideGate() {
  const gate = document.getElementById("gate");
  if (gate) gate.hidden = true;
}

/** Platform switches set by the admin (online version). Missing = on. */
function feat(name) {
  return !(state && state.features && state.features[name] === false);
}

/** Maintenance mode: cover the app with the admin's message. */
function showMaintenance(message) {
  let box = document.getElementById("maintenance");
  if (!box) {
    box = document.createElement("div");
    box.id = "maintenance";
    box.className = "maintenance";
    box.setAttribute("role", "alert");
    document.body.appendChild(box);
  }
  box.innerHTML = '<div class="maintenance-card"><h2>Down for maintenance</h2><p></p><button class="btn primary" type="button">Try again</button></div>';
  box.querySelector("p").textContent = message || "Tradera is being updated. Please check back soon.";
  box.querySelector("button").addEventListener("click", function () { location.reload(); });
}

async function api(path, options) {
  const opts = options || {};
  const headers = { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, cache: "no-store" });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty */ }
  if (res.status === 401) {
    signOutLocally();
    showGate(data.auth);
    throw new Error(data.error || "Please log in");
  }
  if (res.status === 503 && data.maintenance) {
    showMaintenance(data.error);
    throw new Error(data.error || "Down for maintenance");
  }
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}
function post(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body || {}) });
}
function patch(path, body) {
  return api(path, { method: "PATCH", body: JSON.stringify(body || {}) });
}

/** Keep the last good state on this device so the app opens instantly next time. */
let lastCacheAt = 0;
function cacheState(force) {
  if (!state || (!force && Date.now() - lastCacheAt < 15000)) return;
  lastCacheAt = Date.now();
  try { localStorage.setItem("tradera:lastState", JSON.stringify(state)); } catch (_) { /* full or private mode */ }
}
function cachedState() {
  try {
    const raw = localStorage.getItem("tradera:lastState");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function seedAlerts(list) {
  (list || []).forEach(function (a) { if (a && a.id) seenAlerts.add(a.id); });
}

let pushChecked = false;
let lastAckAll = 0;
/** Seeing the app means the user has the alert: stop any ringing. */
function stopRingingIfSeen(next) {
  if (document.hidden || !next || !Array.isArray(next.alerts) || !next.alerts.some(a => a && a.ringing)) return;
  if (Date.now() - lastAckAll < 10000) return;
  lastAckAll = Date.now();
  post("/api/push/ack-all", {}).catch(function () { /* next refresh */ });
}
function applyState(next, options) {
  stopRingingIfSeen(next);
  if (!pushChecked && next && next.push) {
    pushChecked = true;
    setTimeout(function () { syncPushState().then(function () { if (ui.view === "alerts") renderView(); }); }, 0);
  }
  const previous = new Set(((state && state.alerts) || []).map(function (a) { return a.id; }));
  const fresh = ((next && next.alerts) || []).filter(function (a) {
    return a && a.id && !previous.has(a.id) && !seenAlerts.has(a.id);
  });
  state = next;
  seedAlerts(state.alerts);
  updateNotifyButton();
  renderChrome();
  renderView();
  if (!options || !options.silent) updateLiveNodes();
  fresh.slice().reverse().forEach(showAlert);
  cacheState(true);
}

/** Merge a polled state without disturbing an open form or focused input. */
function absorbState(next) {
  const fresh = (next.alerts || []).filter(function (a) { return a && a.id && !seenAlerts.has(a.id); });
  state = next;
  seedAlerts(next.alerts);
  updateNotifyButton();
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") &&
    document.activeElement.closest("#view");
  // A background refresh must never wipe what someone has typed but not saved:
  // on phones the keyboard closes (and focus leaves) long before Save is tapped.
  if (modal.open || typing || ui.viewDirty || ui.view === "settings") {
    updateLiveNodes();
    renderChrome();
  } else {
    renderChrome();
    renderView();
  }
  fresh.slice().reverse().forEach(showAlert);
  cacheState();
}

async function pollState() {
  if (!state || pollBusy) return;
  pollBusy = true;
  try {
    const next = await api("/api/state");
    absorbState(next);
  } catch (err) {
    if (!/passcode/i.test(err.message)) setFeedError("Offline — retrying");
  } finally {
    pollBusy = false;
  }
}

function startPolling() {
  if (pollTimer || !state || state.realtime !== false) return;
  const seconds = Math.max(15, Number(state.effectivePollSeconds) || 60);
  pollTimer = setInterval(pollState, seconds * 1000);
}

function setFeedError(message) {
  const pill = document.getElementById("feedPill");
  const text = document.getElementById("feedText");
  const mobile = document.getElementById("mobileFeed");
  const mobileText = document.getElementById("mobileFeedText");
  if (pill && text) {
    pill.className = "feed-pill err";
    text.textContent = message || "Feed error";
  }
  if (mobile && mobileText) {
    mobile.className = "mb-feed err";
    mobileText.textContent = message || "Feed error";
    mobile.title = message || "Price feed unavailable";
  }
}

function updateFeedPill() {
  const pill = document.getElementById("feedPill");
  const text = document.getElementById("feedText");
  if (!state) return;
  const f = state.feedStatus || {};
  const seconds = state.effectivePollSeconds || state.settings.pollSeconds;
  const demo = state.settings.feed === "demo";
  const mobile = document.getElementById("mobileFeed");
  const mobileText = document.getElementById("mobileFeedText");

  if (!f.ok) {
    if (pill && text) {
      pill.className = "feed-pill err";
      text.textContent = "Feed error";
      pill.title = f.error || "Price feed unavailable";
    }
    if (mobile && mobileText) {
      mobile.className = "mb-feed err";
      mobileText.textContent = "Feed error";
      mobile.title = f.error || "Price feed unavailable";
    }
    return;
  }

  const source = demo ? "Demo feed" : f.source === "twelvedata" ? "Twelve Data" : f.source === "oanda" ? "OANDA live" : f.source === "deriv" ? "Deriv live" : "Yahoo feed";
  if (pill && text) {
    pill.className = "feed-pill " + (demo ? "demo" : "ok");
    text.textContent = source + " · " + seconds + "s";
    pill.title = f.error || ("Last update " + (f.at ? new Date(f.at).toLocaleTimeString() : "—"));
  }
  if (mobile && mobileText) {
    mobile.className = "mb-feed " + (demo ? "demo" : "ok");
    mobileText.textContent = demo ? "Demo" : "Live";
    mobile.title = source + " · updated " + (f.at ? new Date(f.at).toLocaleTimeString() : "—");
  }
}

/* ------------------------------------------------------------------ render */

function renderChrome() {
  document.querySelectorAll("#nav [data-view], .tabbar [data-view]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === ui.view);
  });
  const meta = VIEW_META[ui.view] || VIEW_META.dashboard;
  document.getElementById("viewTitle").textContent = meta.title;
  document.getElementById("viewSub").textContent = meta.sub;
  const mbTitle = document.getElementById("mbTitle");
  if (mbTitle) mbTitle.textContent = meta.title;

  const actions = document.getElementById("topActions");
  if (ui.view === "dashboard") {
    actions.innerHTML =
      (feat("pasteImport") ? '<button class="btn ghost" data-action="import-setup">' + icon("plus") + "Paste setup</button>" : "") +
      '<button class="btn ghost" data-action="new-setup">' + icon("plus") + "New setup</button>" +
      '<button class="btn primary" data-action="new-trade">' + icon("plus") + "New trade</button>";
  } else if (ui.view === "journal") {
    actions.innerHTML = '<button class="btn primary" data-action="new-trade">' + icon("plus") + "New trade</button>";
  } else if (ui.view === "setups") {
    actions.innerHTML =
      (feat("pasteImport") ? '<button class="btn ghost" data-action="import-setup">' + icon("plus") + "Paste or upload</button>" : "") +
      '<button class="btn primary" data-action="new-setup">' + icon("plus") + "New setup</button>";
  } else if (ui.view === "alerts") {
    actions.innerHTML = '<button class="btn" data-action="test-alert">' + icon("bell") + "Send test alert</button>";
  } else {
    actions.innerHTML = "";
  }

  const navDot = document.getElementById("navAlertDot");
  if (navDot) navDot.hidden = !(state && state.priority && state.priority.some(s => s.near));
  const mobileDot = document.getElementById("mobileAlertDot");
  if (mobileDot) mobileDot.hidden = !(state && state.priority && state.priority.some(s => s.near));

  updateFeedPill();
  updateNotifyButton();
}

function renderView() {
  if (!state) return;
  ui.viewDirty = false;
  if (ui.view === "dashboard") viewEl.innerHTML = renderDashboard();
  else if (ui.view === "journal") viewEl.innerHTML = renderJournal();
  else if (ui.view === "setups") viewEl.innerHTML = renderSetups();
  else if (ui.view === "pairs") viewEl.innerHTML = renderPairs();
  else if (ui.view === "alerts") viewEl.innerHTML = renderAlerts();
  else viewEl.innerHTML = renderSettings();
  if (state.announcement) {
    const bar = document.createElement("div");
    bar.className = "announce";
    bar.setAttribute("role", "status");
    bar.textContent = state.announcement;
    viewEl.insertBefore(bar, viewEl.firstChild);
  }
  attachViewListeners();
  updateLiveNodes();
}

function emptyState(mark, title, text, cta) {
  return '<div class="empty"><div class="empty-mark">' + mark + "</div><strong>" + esc(title) +
    "</strong><p>" + esc(text) + "</p>" + (cta || "") + "</div>";
}

/* --------------------------------------------------------------- dashboard */

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Burning the midnight oil" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function plural(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

/** One plain sentence about the thing that matters most right now. */
function heroLine(priority) {
  const priced = priority.filter(s => s.distancePips !== null && s.distancePips !== undefined);
  const closest = priced.slice().sort((a, b) => a.distancePips - b.distancePips)[0];
  const sym = s => '<span class="sym">' + esc(s.symbol) + "</span>";
  const away = s => fmtNum(s.distancePips, 1) + " " + unitName(s.symbol);
  const atEntry = priority.filter(s => s.crossed);
  const near = priority.filter(s => s.near && !s.crossed);

  if (atEntry.length) {
    return {
      line: sym(atEntry[0]) + " is at your entry.",
      sub: "Check your plan, then trigger the setup to log the trade." +
        (atEntry.length > 1 ? " " + plural(atEntry.length - 1, "other setup") + " also reached entry." : "")
    };
  }
  if (near.length) {
    const first = near.slice().sort((a, b) => a.distancePips - b.distancePips)[0];
    return {
      line: sym(first) + " is " + away(first) + " from entry.",
      sub: plural(near.length, "setup") + " inside alert range. Get your chart up."
    };
  }
  if (closest) {
    return {
      line: "Watching " + plural(priority.length, "setup") + ". Nothing close yet.",
      sub: "Closest is " + esc(closest.symbol) + ", " + away(closest) + " away. We will tell you when that changes."
    };
  }
  if (priority.length) {
    return { line: "Watching " + plural(priority.length, "setup") + ".", sub: "Waiting for the first prices to arrive." };
  }
  if (!state.pairs.length) {
    return { line: "Let's set up your desk.", sub: "Add the markets you trade, plan a setup, and Tradera will watch price for you." };
  }
  return { line: "No setups on watch.", sub: "Plan your next trade and Tradera will tell you when price gets close." };
}

function onboardingSteps() {
  const s = state.settings;
  const pushOn = !!(s.ntfyTopic || (s.telegramToken && s.telegramChatId) ||
    (ui.browserAlerts && "Notification" in window && Notification.permission === "granted"));
  return [
    { done: state.pairs.length > 0, title: "Add your markets", text: "EURUSD, XAUUSD, BTCUSD…", view: "pairs" },
    { done: state.setups.length > 0, title: "Plan a setup", text: "Entry, stop, target and how close is close.", action: "new-setup" },
    { done: pushOn, title: "Get alerts on your phone", text: "Free with ntfy, or use Telegram.", view: "alerts" },
    { done: state.trades.length > 0, title: "Log a trade", text: "Your stats and equity curve start here.", action: "new-trade" }
  ];
}

function checklistPanel() {
  const steps = onboardingSteps();
  const left = steps.filter(x => !x.done).length;
  if (!left || store("hideChecklist") === "1") return "";
  return '<section class="panel section-gap">' +
    '<div class="panel-head"><h2>Get set up</h2><span class="hint">' + (4 - left) + " of 4 done " +
      '<button class="btn ghost small" data-action="hide-checklist" style="margin-left:8px">Hide</button></span></div>' +
    '<div class="checklist">' + steps.map(function (step, i) {
      const attr = step.done ? "disabled" : step.view ? 'data-view="' + step.view + '"' : 'data-action="' + step.action + '"';
      return '<button type="button" class="check-step ' + (step.done ? "done" : "") + '" ' + attr + ">" +
        '<span class="n">' + (step.done ? "✓" : i + 1) + "</span><b>" + esc(step.title) + "</b><span>" + esc(step.text) + "</span></button>";
    }).join("") + "</div></section>";
}

function ledgerItem(label, value, sub) {
  return '<div class="ledger-item"><div class="ledger-label">' + esc(label) + '</div><div class="ledger-value">' + value +
    '</div><div class="ledger-sub">' + sub + "</div></div>";
}

function renderDashboard() {
  const s = state.stats;
  const priority = state.priority;
  const openTrades = state.trades.filter(t => t.status !== "closed");
  const recentAlerts = state.alerts.slice(0, 4);
  const feedError = state.feedStatus && !state.feedStatus.ok
    ? '<div class="feed-error">' + esc(state.feedStatus.error || "Price feed unavailable") +
      ". Entry alerts are paused until prices come back.</div>"
    : "";
  const hero = heroLine(priority);
  const feedWarn = state.feedStatus && state.feedStatus.ok && state.feedStatus.warning
    ? '<div class="feed-error" style="background:var(--near-soft);color:var(--near)">Using backup prices for some markets: ' + esc(state.feedStatus.warning) + "</div>"
    : "";
  const balance = (Number(s.startingBalance) || 0) + (Number(s.netPnl) || 0);

  return feedError + feedWarn + logPromptsPanel() +
    '<section class="hero">' +
      "<div>" +
        '<p class="hero-greet">' + greeting() + ".</p>" +
        '<h2 class="hero-line">' + hero.line + "</h2>" +
        '<p class="hero-sub">' + hero.sub + "</p>" +
      "</div>" +
      '<div class="hero-balance"><span>Balance</span><b>' + fmtMoney(balance) + "</b>" +
        '<em class="' + pnlClass(s.netPnl) + '">' + fmtSignedMoney(s.netPnl) +
        (s.netPnlPct === null ? "" : " (" + (s.netPnlPct > 0 ? "+" : "") + s.netPnlPct + "%)") + "</em></div>" +
      '<div class="ledger">' +
        ledgerItem("Win rate", s.winRate === null ? "—" : s.winRate + "%",
          s.wins + " won, " + s.losses + " lost" + (s.breakeven ? ", " + s.breakeven + " flat" : "")) +
        ledgerItem("Profit factor", !s.trades ? "—" : s.profitFactor === null ? "∞" : fmtNum(s.profitFactor, 2),
          "Gross wins vs losses") +
        ledgerItem("Average R", s.avgR === null ? "—" : '<span class="' + pnlClass(s.avgR) + '">' + (s.avgR > 0 ? "+" : "") + fmtNum(s.avgR, 2) + "R</span>",
          "Per closed trade") +
        ledgerItem("Expectancy", s.expectancy === null || s.expectancy === undefined ? "—" : '<span class="' + pnlClass(s.expectancy) + '">' + fmtSignedMoney(s.expectancy) + "</span>",
          s.currentStreak > 1 ? s.currentStreak + " wins in a row" : s.currentStreak < -1 ? -s.currentStreak + " losses in a row" : "Average per trade") +
        ledgerItem("Max drawdown", fmtMoney(s.maxDrawdown), (s.maxDrawdownPct || 0) + "% from peak") +
        ledgerItem("Open risk", fmtMoney(s.openRisk), plural(openTrades.length, "open trade")) +
      "</div>" +
    "</section>" +

    checklistPanel() +

    '<div class="dash-grid">' +
      '<section class="panel">' +
        '<div class="panel-head"><h2>Closest to entry</h2><span class="hint">' +
          plural(priority.length, "setup") + " on watch</span></div>" +
        priorityTable(priority) +
      "</section>" +
      '<div class="stack">' +
        '<section class="panel">' +
          '<div class="panel-head"><h2>Open trades</h2><span class="hint">' + (openTrades.length ? fmtMoney(s.openRisk) + " at risk" : "") + "</span></div>" +
          openPositionsList(openTrades) +
        "</section>" +
        '<section class="panel">' +
          '<div class="panel-head"><h2>Recent alerts</h2><button class="btn ghost small" data-view="alerts">View all</button></div>' +
          recentAlertsList(recentAlerts) +
        "</section>" +
      "</div>" +
    "</div>" +

    '<section class="panel section-gap">' +
      '<div class="panel-head"><h2>Equity curve</h2><span class="hint">From ' + fmtMoney(s.startingBalance) +
        " across " + plural(s.trades, "closed trade") + "</span></div>" +
      '<div class="panel-body"><div class="curve-wrap">' + equitySvg(s.curve) + "</div></div>" +
      monthlyBars(s.monthly) +
    "</section>";
}

function priorityTable(list) {
  if (!list.length) {
    return emptyState("◎", "Nothing on watch yet",
      "Plan a trade with an entry level. It shows up here with a live bar that fills as price closes in.",
      '<button class="btn primary small" data-action="new-setup">Plan a setup</button>');
  }
  // Each row is a runway: the bar fills as price closes in on the brass entry tick.
  const rows = list.map(function (s) {
    const quote = quoteOf(s.symbol);
    const stale = !quote || isStale(quote);
    return '<div class="runway row-link ' + (s.crossed ? "hit" : s.near ? "near" : "") + '" data-action="edit-setup" data-id="' + esc(s.id) + '" data-runway="' + esc(s.id) + '">' +
      '<div class="runway-id"><div class="top"><b>' + esc(symLabel(s.symbol)) + "</b>" + dirTag(s.direction) +
        (s.pairPriority ? '<span class="chip brass">★</span>' : "") + "</div>" +
        '<div class="lbl">' + esc(s.label || (s.priority ? s.priority[0].toUpperCase() + s.priority.slice(1) + " priority" : "")) +
        (s.rr ? " · R:R " + rrText(s.rr) : "") + "</div></div>" +
      '<div class="runway-track"><div class="levels-line"><span>Now <b data-price="' + esc(s.symbol) + '">' +
        fmtPrice(s.symbol, quote ? quote.price : null) + "</b>" +
        (stale ? '<span class="stale-mark" title="Price is delayed or missing"></span>' : "") + "</span>" +
        "<span>Entry <b>" + fmtPrice(s.symbol, s.entry) + "</b></span></div>" +
        '<i class="dist-bar"><b data-meter="' + esc(s.id) + '" style="width:' + meterWidth(s) + '%"></b></i></div>' +
      '<div class="runway-dist"><b data-dist="' + esc(s.id) + '">' + setupDistanceText(s) + "</b><span>alert at " +
        fmtNum(s.threshold, 0) + " " + unitName(s.symbol) + "</span></div>" +
      '<div class="row-actions">' +
        '<button class="icon-btn" title="Open chart" data-action="chart" data-symbol="' + esc(s.symbol) + '">' + icon("chart") + "</button>" +
        '<button class="icon-btn go" title="Trigger: log this trade" data-action="trigger-setup" data-id="' + esc(s.id) + '">' + icon("play") + "</button>" +
      "</div></div>";
  }).join("");
  return '<div class="runway-list">' + rows + "</div>";
}

function openPositionsList(trades) {
  if (!trades.length) {
    return emptyState("○", "You're flat", "No open trades. When you take one, log it here to track risk and R:R.",
      '<button class="btn ghost small" data-action="new-trade">Log a trade</button>');
  }
  return '<div class="mini-list">' + trades.slice(0, 5).map(function (t) {
    return '<div class="mini-row row-link" data-action="edit-trade" data-id="' + esc(t.id) + '">' +
      '<div class="mini-main"><b>' + esc(symLabel(t.symbol)) + " " + dirTag(t.direction) + "</b>" +
      '<div class="mini-sub">Entry ' + fmtPrice(t.symbol, t.entry) + " · " + fmtDate(t.openedAt) +
      (t.riskAmount ? " · risk " + fmtMoney(t.riskAmount) : "") + "</div></div>" +
      '<div class="mini-right"><b>' + rrText(t.rr) + "</b><span>R:R</span></div></div>";
  }).join("") + "</div>";
}

function recentAlertsList(alerts) {
  if (!alerts.length) {
    return emptyState("◔", "All quiet",
      "When price gets close to one of your entries, you'll see it here and on your phone if alerts are on.",
      "");
  }
  return '<div class="mini-list">' + alerts.map(function (a) {
    return '<div class="mini-row"><div class="mini-main"><b>' + esc(a.symbol) + " · " +
      esc(a.kind === "entry" ? "At entry" : a.kind === "test" ? "Test alert" : "Getting close") + "</b>" +
      '<div class="mini-sub">' + esc(a.message) + "</div></div>" +
      '<div class="mini-right"><b>' + fmtPrice(a.symbol, a.price) + '</b><span>' + timeAgo(a.at) + "</span></div></div>";
  }).join("") + "</div>";
}

function equitySvg(curve) {
  const width = 1000, height = 210, padX = 16, padTop = 18, padBottom = 26;
  const start = Number(state.settings.startingBalance) || 0;
  let pts = Array.isArray(curve) && curve.length ? curve.slice() : [{ t: Date.now(), value: start }];
  if (pts.length === 1) pts.push({ t: pts[0].t + 1, value: pts[0].value });
  const values = pts.map(p => Number(p.value));
  let min = Math.min.apply(null, values.concat([start]));
  let max = Math.max.apply(null, values.concat([start]));
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const range = max - min;
  const x = i => padX + (i / (pts.length - 1)) * (width - padX * 2);
  const y = v => padTop + (1 - (v - min) / range) * (height - padTop - padBottom);
  const line = pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + "," + y(p.value).toFixed(1)).join(" ");
  const area = line + " L" + x(pts.length - 1).toFixed(1) + "," + (height - padBottom) +
    " L" + padX + "," + (height - padBottom) + " Z";
  const last = pts[pts.length - 1].value;
  const color = last >= start ? "var(--up)" : "var(--down)";
  const baseY = y(start);
  return '<svg viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" role="img" aria-label="Equity curve">' +
    '<defs><linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">' +
    '<stop offset="0" style="stop-color:' + color + ';stop-opacity:.22"></stop>' +
    '<stop offset="1" style="stop-color:' + color + ';stop-opacity:0"></stop></linearGradient></defs>' +
    '<line x1="' + padX + '" x2="' + (width - padX) + '" y1="' + baseY + '" y2="' + baseY +
      '" style="stroke:var(--line-strong)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"></line>' +
    '<path d="' + area + '" fill="url(#eqfill)"></path>' +
    '<path d="' + line + '" fill="none" style="stroke:' + color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>' +
    '<circle cx="' + x(pts.length - 1) + '" cy="' + y(last) + '" r="4.5" style="fill:' + color + '"></circle>' +
    "</svg>" +
    '<span class="curve-label top">' + esc(fmtMoney(max)) + '</span><span class="curve-label bottom">' + esc(fmtMoney(min)) + "</span>";
}

function monthlyBars(monthly) {
  if (!monthly || !monthly.length) {
    return '<div class="empty" style="padding:6px 20px 22px"><p>Close your first trade and your month-by-month results appear here.</p></div>';
  }
  const last = monthly.slice(-6);
  const max = Math.max.apply(null, last.map(m => Math.abs(m.pnl)).concat([1]));
  return '<div class="monthly">' + last.map(function (m) {
    const h = Math.max(6, Math.round((Math.abs(m.pnl) / max) * 100));
    return '<div class="month"><div class="bar-track"><div class="bar ' + (m.pnl < 0 ? "neg" : "") +
      '" style="height:' + h + '%" title="' + esc(m.month + " · " + fmtSignedMoney(m.pnl) + " · " + m.trades + " trades") + '"></div></div>' +
      '<span class="m-value ' + pnlClass(m.pnl) + '">' + (m.pnl >= 0 ? "+" : "") + fmtNum(m.pnl, 0) + "</span>" +
      '<span class="m-label">' + esc(monthLabel(m.month)) + "</span></div>";
  }).join("") + "</div>";
}

/* ----------------------------------------------------------------- journal */

function filteredTrades() {
  const f = ui.journal;
  const q = f.q.trim().toLowerCase();
  return state.trades.filter(function (t) {
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.pair !== "all" && t.symbol !== f.pair) return false;
    if (q) {
      const hay = [t.symbol, t.notes, t.tags, t.setupLabel, t.direction].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderJournal() {
  const pairs = Array.from(new Set(state.trades.map(t => t.symbol))).sort();
  const s = state.stats;
  return '<div class="toolbar">' +
    '<input type="search" id="jq" placeholder="Search pair, tag or note" value="' + esc(ui.journal.q) + '" aria-label="Search trades">' +
    '<select id="jstatus" aria-label="Filter by status">' +
      '<option value="all"' + (ui.journal.status === "all" ? " selected" : "") + ">All trades</option>" +
      '<option value="open"' + (ui.journal.status === "open" ? " selected" : "") + ">Open</option>" +
      '<option value="closed"' + (ui.journal.status === "closed" ? " selected" : "") + ">Closed</option>" +
    "</select>" +
    '<select id="jpair" aria-label="Filter by pair">' +
      '<option value="all"' + (ui.journal.pair === "all" ? " selected" : "") + ">All pairs</option>" +
      pairs.map(p => '<option value="' + esc(p) + '"' + (ui.journal.pair === p ? " selected" : "") + ">" + esc(p) + "</option>").join("") +
    "</select>" +
    '<span class="spacer"></span>' +
    '<span class="chip">Win rate <b>' + (s.winRate === null ? "—" : s.winRate + "%") + "</b></span>" +
    '<span class="chip">Profit factor <b>' + (!s.trades ? "—" : s.profitFactor === null ? "∞" : fmtNum(s.profitFactor, 2)) + "</b></span>" +
    '<span class="chip">Avg <b>' + (s.avgR === null ? "—" : (s.avgR > 0 ? "+" : "") + fmtNum(s.avgR, 2) + "R") + "</b></span>" +
    "</div>" +
    '<div class="panel"><div id="journalTable">' + journalTableHtml() + "</div></div>";
}

function journalTableHtml() {
  const rows = filteredTrades();
  if (!rows.length) {
    const noTrades = !state.trades.length;
    return emptyState("▤", noTrades ? "Your journal starts here" : "No trades match",
      noTrades ? "Log each trade with its entry, stop, risk and a note on why you took it. Closed trades build your stats and equity curve."
               : "Try a different search, or set the filters back to all.",
      noTrades ? '<button class="btn primary small" data-action="new-trade">Log your first trade</button>'
               : '<button class="btn ghost small" data-action="clear-filters">Clear filters</button>');
  }
  return '<div class="table-wrap"><table class="table journal-table"><thead><tr>' +
    "<th>Date</th><th>Pair</th><th>Side</th><th class=\"num\">Entry</th><th class=\"num\">Exit</th>" +
    "<th class=\"num\">Pips</th><th class=\"num\">R</th><th class=\"num\">Net P&L</th><th>Status</th><th></th>" +
    "</tr></thead><tbody>" + rows.map(function (t) {
      const open = t.status !== "closed";
      return '<tr class="row-link journal-row" data-action="edit-trade" data-id="' + esc(t.id) + '">' +
        '<td data-label="Date"><div class="mono">' + fmtDate(open ? t.openedAt : t.closedAt) + "</div>" +
          '<div class="mini-sub faint">' + esc(t.tags || "") + "</div></td>" +
        '<td data-label="Pair"><b>' + esc(symLabel(t.symbol)) + "</b></td>" +
        '<td data-label="Side">' + dirTag(t.direction) + "</td>" +
        '<td data-label="Entry" class="num mono">' + fmtPrice(t.symbol, t.entry) + "</td>" +
        '<td data-label="Exit" class="num mono">' + (open ? "—" : fmtPrice(t.symbol, t.exit)) + "</td>" +
        '<td data-label="Pips" class="num mono">' + (open || t.pips === null ? "—" : (t.pips > 0 ? "+" : "") + fmtNum(t.pips, 1)) + "</td>" +
        '<td data-label="R" class="num mono">' + (open || t.r === null ? "—" : (t.r > 0 ? "+" : "") + fmtNum(t.r, 2) + "R") + "</td>" +
        '<td data-label="Net P&L" class="num mono ' + pnlClass(t.netPnl) + '">' + (open ? "—" : fmtSignedMoney(t.netPnl)) + "</td>" +
        '<td data-label="Status"><div class="status-cell">' + (open ? '<span class="pill open">Open</span>'
          : t.netPnl > 0 ? '<span class="pill triggered">Win</span>' : t.netPnl < 0 ? '<span class="pill invalidated">Loss</span>'
          : '<span class="pill closed">Flat</span>') + verdictTag(t) +
          (t.images && t.images.length ? '<span class="shot-count" title="' + plural(t.images.length, "screenshot") + '">' + icon("camera") + t.images.length + "</span>" : "") +
          "</div></td>" +
        '<td data-label="">' + '<div class="row-actions">' +
          (open ? '<button class="btn small" data-action="close-trade" data-id="' + esc(t.id) + '">Close</button>' : "") +
          '<button class="icon-btn" title="Edit" data-action="edit-trade" data-id="' + esc(t.id) + '">' + icon("edit") + "</button>" +
          '<button class="icon-btn del" title="Delete trade" data-action="delete-trade" data-id="' + esc(t.id) + '">' + icon("trash") + "</button>" +
        "</div></td></tr>";
    }).join("") + "</tbody></table></div>" + journalFoot(rows);
}

function journalFoot(rows) {
  const closed = rows.filter(t => t.status === "closed");
  const net = closed.reduce((sum, t) => sum + (Number(t.netPnl) || 0), 0);
  const wins = closed.filter(t => Number(t.netPnl) > 0).length;
  const planned = rows.filter(t => t.followedPlan === "yes" || t.followedPlan === "no");
  const followed = planned.filter(t => t.followedPlan === "yes").length;
  const unreviewed = closed.filter(t => !t.verdict).length;
  return '<div class="journal-foot"><span>Showing <b>' + plural(rows.length, "trade") + "</b></span>" +
    (closed.length ? '<span>Net <b class="' + pnlClass(net) + '">' + fmtSignedMoney(net) + "</b></span>" +
      "<span>Won <b>" + wins + " of " + closed.length + "</b></span>" : "") +
    (planned.length ? "<span>Followed plan <b>" + followed + " of " + planned.length + "</b></span>" : "") +
    (unreviewed ? '<span class="faint">' + plural(unreviewed, "closed trade") + " not reviewed yet</span>" : "") + "</div>";
}

/* ------------------------------------------------------------------ setups */

/** Finished setups the user hasn't logged or dismissed yet. */
function unloggedSetup(s) {
  if (s.status === "watching" || s.notTaken) return false;
  if (s.outcome && s.outcome.result === "missed") return false;
  return !state.trades.some(t => t.setupId === s.id);
}
function outcomeTag(s) {
  const o = s.outcome;
  if (!o) return "";
  const r = o.r === null || o.r === undefined ? "" : " · " + (o.r > 0 ? "+" : "") + fmtNum(o.r, 1) + "R";
  const text = o.result === "tp" ? "Hit target" + r : o.result === "sl" ? "Hit stop" + r : "Missed — target hit before entry";
  return '<div class="outcome-line ' + esc(o.result) + '">' + esc(text) + " · " + fmtPrice(s.symbol, o.price) + ' <span class="faint">' + timeAgo(new Date(o.at).getTime()) + "</span></div>";
}
function logPromptCard(s) {
  return '<div class="log-prompt">' +
    '<div class="log-prompt-text"><b>' + esc(symLabel(s.symbol)) + " " + (s.direction === "short" ? "sell" : "buy") + "</b> " +
      (s.outcome ? (s.outcome.result === "tp" ? "hit its target" : "hit its stop") + (s.outcome.r !== null && s.outcome.r !== undefined ? " (" + (s.outcome.r > 0 ? "+" : "") + fmtNum(s.outcome.r, 1) + "R)" : "")
        : s.status === "invalidated" ? "was invalidated" : "is finished") +
      ". Did you take it?</div>" +
    '<div class="log-prompt-actions">' +
      '<button class="btn primary small" data-action="log-setup-trade" data-id="' + esc(s.id) + '">' + icon("plus") + "Yes, log it</button>" +
      '<button class="btn ghost small" data-action="skip-setup-log" data-id="' + esc(s.id) + '">No, I didn\'t</button>' +
    "</div></div>";
}
function logPromptsPanel() {
  const list = state.setups.filter(s => s.logPrompt && unloggedSetup(s));
  if (!list.length) return "";
  return '<section class="panel log-prompts section-gap"><div class="panel-head"><h2>Log your finished setups</h2><span class="hint">' +
    plural(list.length, "setup") + " waiting</span></div>" + list.map(logPromptCard).join("") + "</section>";
}

function setupCard(s) {
  const cls = s.status === "triggered" ? "triggered"
    : s.status === "invalidated" || s.status === "done" ? "archived"
    : s.crossed ? "at-entry" : s.near ? "approaching" : "";
  const liveTone = s.crossed ? "hit" : s.near ? "near" : "";
  return '<article class="setup-card ' + cls + '">' +
    '<div class="setup-head"><div class="setup-id"><div class="pair-line"><span class="pair">' + esc(symLabel(s.symbol)) + "</span>" +
      dirTag(s.direction) + "</div>" + (s.label ? '<span class="label">' + esc(s.label) + "</span>" : "") + "</div>" +
      (s.status === "watching" ? '<span class="pill ' + esc(s.priority) + '">' + esc(s.priority[0].toUpperCase() + s.priority.slice(1)) + "</span>" : statusPill(s)) + "</div>" +
    '<div class="levels">' +
      "<div><span>Entry</span><b>" + fmtPrice(s.symbol, s.entry) + "</b></div>" +
      '<div class="stop"><span>Stop</span><b>' + (s.stop ? fmtPrice(s.symbol, s.stop) : "—") + "</b></div>" +
      '<div class="target"><span>Target</span><b>' + (s.target ? fmtPrice(s.symbol, s.target) : "—") + "</b></div>" +
      "<div><span>R:R</span><b>" + rrText(s.rr) + "</b></div>" +
    "</div>" +
    '<div class="live-line"><span>Now</span><b data-price="' + esc(s.symbol) + '">' + fmtPrice(s.symbol, s.price) + "</b>" +
      '<span class="' + liveTone + '" data-dist="' + esc(s.id) + '">' + setupDistanceText(s) + "</span>" +
      (s.distancePips === null ? "" : '<span class="faint">alert at ' + fmtNum(s.threshold, 0) + " " + unitName(s.symbol) + "</span>") + "</div>" +
    '<i class="meter"><b data-meter="' + esc(s.id) + '" style="width:' + meterWidth(s) + '%"></b></i>' +
    outcomeTag(s) +
    (s.note ? '<p class="setup-note">' + esc(s.note) + "</p>" : "") +
    (s.status !== "watching" && unloggedSetup(s) && !s.logPrompt ? '<div class="log-ask">Did you take this trade?</div>' : "") +
    '<div class="setup-actions">' +
      (s.status === "watching"
        ? '<button class="btn small" data-action="edit-setup" data-id="' + esc(s.id) + '">' + icon("edit") + "Edit</button>" +
          '<button class="btn ghost small" data-action="trigger-setup" data-id="' + esc(s.id) + '" title="Tick this when price has hit your entry">' + icon("play") + "Mark triggered</button>" +
          '<button class="btn ghost small" data-action="set-setup-status" data-id="' + esc(s.id) + '" data-status="invalidated">Invalidate</button>'
        : (unloggedSetup(s)
            ? '<button class="btn primary small" data-action="log-setup-trade" data-id="' + esc(s.id) + '">' + icon("plus") + "Log trade</button>" +
              (s.status !== "triggered" ? '<button class="btn ghost small" data-action="skip-setup-log" data-id="' + esc(s.id) + '">Not taken</button>' : "")
            : "") +
          '<button class="btn ghost small" data-action="edit-setup" data-id="' + esc(s.id) + '">Edit</button>' +
          '<button class="btn ghost small" data-action="set-setup-status" data-id="' + esc(s.id) + '" data-status="watching">Back to watching</button>') +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" title="Chart" data-action="chart" data-symbol="' + esc(s.symbol) + '">' + icon("chart") + "</button>" +
      '<button class="icon-btn del" title="Delete setup" data-action="delete-setup" data-id="' + esc(s.id) + '">' + icon("trash") + "</button>" +
    "</div></article>";
}

function renderSetups() {
  const watching = state.priority;
  const triggered = state.setups.filter(s => s.status === "triggered");
  const archived = state.setups.filter(s => s.status === "invalidated" || s.status === "done");
  let html = logPromptsPanel() + '<div class="section-title"><h2>On watch</h2><span class="count">' + watching.length +
    '</span><span class="spacer"></span><span class="muted" style="font-size:12.5px">Priority markets first, then closest to entry</span></div>';
  html += watching.length
    ? '<div class="setups-grid">' + watching.map(setupCard).join("") + "</div>"
    : '<div class="panel">' + emptyState("◎", "No setups on watch", "Plan the trades you are waiting for: an entry, a stop, a target and how close price should get before we alert you.",
        '<button class="btn primary small" data-action="new-setup">Plan a setup</button>') + "</div>";

  if (triggered.length) {
    html += '<div class="section-title"><h2>Triggered</h2><span class="count">' + triggered.length + "</span></div>" +
      '<div class="setups-grid">' + triggered.map(setupCard).join("") + "</div>";
  }
  if (archived.length) {
    html += '<div class="section-title"><h2>Finished</h2><span class="count">' + archived.length + "</span></div>" +
      '<div class="setups-grid">' + archived.map(setupCard).join("") + "</div>";
  }
  return html;
}

/* ------------------------------------------------------------------- pairs */

function pairCard(p) {
  const q = quoteOf(p.symbol);
  const stale = !q || isStale(q);
  const change = q && q.changePct !== null && q.changePct !== undefined ? q.changePct : null;
  const syn = synthetic(p.symbol);
  return '<div class="pair-card ' + (p.priority ? "priority" : "") + (p.monitor ? "" : " paused") + '">' +
    '<div class="pair-top"><div class="pair-name"><b>' + esc(symLabel(p.symbol)) + "</b><span>" +
      esc(syn ? syn.name : pairKind(p.symbol)) + "</span></div>" +
      '<div class="pair-price"><b data-price="' + esc(p.symbol) + '">' + fmtPrice(p.symbol, q ? q.price : null) + "</b>" +
      (q && q.spread !== undefined && q.spread !== null ? '<span class="faint" style="font-weight:500">Spread ' + fmtNum(q.spread, 1) + " " + unitName(p.symbol) + "</span>" : "") +
      '<span class="' + (change === null ? "faint" : change > 0 ? "pos" : change < 0 ? "neg" : "faint") + '" data-change="' +
        esc(p.symbol) + '">' + (change === null ? (stale ? "no quote" : "—") : (change > 0 ? "+" : "") + fmtNum(change, 2) + "%") +
      "</span></div></div>" +
    '<div class="pair-foot">' +
      '<button class="toggle star ' + (p.priority ? "on" : "") + '" data-action="toggle-priority" data-symbol="' + esc(p.symbol) +
        '" title="Priority market">' + icon("star") + "Priority</button>" +
      '<button class="toggle ' + (p.monitor ? "on" : "") + '" data-action="toggle-monitor" data-symbol="' + esc(p.symbol) +
        '" title="Watch price">' + icon("eye") + (p.monitor ? "Live" : "Paused") + "</button>" +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" title="Chart" data-action="chart" data-symbol="' + esc(p.symbol) + '">' + icon("chart") + "</button>" +
      '<button class="icon-btn del" title="Remove market" data-action="remove-pair" data-symbol="' + esc(p.symbol) + '">' + icon("trash") + "</button>" +
    "</div></div>";
}

function renderPairs() {
  const sorted = state.pairs.slice().sort((a, b) => (b.priority - a.priority) || symLabel(a.symbol).localeCompare(symLabel(b.symbol), undefined, { numeric: true }));
  const sections = MARKET_GROUPS.map(g => ({ name: g.name, items: sorted.filter(p => marketGroup(p.symbol) === g) }))
    .concat([{ name: "Other", items: sorted.filter(p => !marketGroup(p.symbol)) }])
    .filter(sec => sec.items.length);
  return '<div class="panel"><div class="panel-body">' +
    '<form id="pairForm" class="add-pair">' +
      pickerField('<input name="symbol" data-picker="catalog" placeholder="Tap to pick a market, or type EURUSD, V75, Step 100…" autocomplete="off" required aria-label="Market symbol">') +
      '<label class="check-line"><input type="checkbox" name="priority"> Priority</label>' +
      '<button class="btn primary" type="submit">' + icon("plus") + "Add market</button>" +
    "</form>" +
    quickAdd() +
    '<div class="field-note" style="margin-top:10px">Prices refresh every ' + (state.effectivePollSeconds || state.settings.pollSeconds) +
      "s. Priority markets rank first on your watchlist. Volatility and Step indices are Deriv synthetics: they trade 24/7 and are priced by Deriv.</div>" +
    "</div></div>" +
    (sections.length
      ? sections.map(sec =>
          '<div class="section-title" style="margin-top:26px"><h2>' + esc(sec.name) + '</h2><span class="count">' + sec.items.length + "</span></div>" +
          '<div class="pairs-grid" style="margin-top:0">' + sec.items.map(pairCard).join("") + "</div>").join("")
      : '<div class="panel section-gap">' + emptyState("◈", "No markets yet", "Add what you trade, or add a whole group above, to start getting live prices.", "") + "</div>");
}

function quickAdd() {
  const have = new Set(state.pairs.map(p => p.symbol));
  const groups = MARKET_GROUPS.map(g => ({ g, missing: g.symbols.filter(sym => !have.has(sym)) })).filter(x => x.missing.length);
  if (!groups.length) return "";
  return '<div class="quick-add"><span class="field-note">Add a group:</span>' + groups.map(x =>
    '<button type="button" class="chip" data-action="add-group" data-group="' + x.g.id + '">+ ' + esc(x.g.name) + " (" + x.missing.length + ")</button>").join("") + "</div>";
}

/* ------------------------------------------------------------------ alerts */

function renderAlerts() {
  const ntfyOn = !!(state.settings.ntfyTopic);
  const tgOn = !!(state.settings.telegramToken && state.settings.telegramChatId);
  const callOn = !!state.settings.callmebotUser;
  const pushOn = !!(state.settings.pushoverUser && (state.pushoverApp || state.settings.pushoverToken));
  const browserSupported = "Notification" in window;
  const browserPermission = browserSupported ? Notification.permission : "unsupported";

  const browserOn = browserPermission === "granted" && ui.browserAlerts;
  const dot = (on, warn) => '<span class="state-dot ' + (on ? "on" : warn ? "warn" : "off") + '">' + (on ? "On" : warn ? "Blocked" : "Off") + "</span>";
  const card = (name, html) => feat(name) ? html : "";
  return (feat("reminders") ? remindersPanel() : "") + '<div class="channel-grid section-gap">' +
    (feat("webpush") ? pushCard() : "") +
    card("pushover", '<div class="channel ' + (pushOn ? "on" : "") + '"><div class="channel-top"><strong>Alarm (Pushover)</strong>' + dot(pushOn) + "</div>" +
      "<p>" + (pushOn ? "Entry alerts sound as an alarm, even on silent, and repeat every 30 seconds until you tap them."
        : "Best way not to miss an entry: a loud alarm that rings through silent mode and Do Not Disturb until you tap it. One-off $5 app.") + "</p>" +
      '<button class="btn ghost small" data-' + (pushOn ? 'action="test-alert"' : 'view="settings"') + ">" + (pushOn ? "Send test alarm" : "Set up alarm") + "</button></div>") +
    card("ntfy", '<div class="channel ' + (ntfyOn ? "on" : "") + '"><div class="channel-top"><strong>Phone push (ntfy)</strong>' + dot(ntfyOn) + "</div>" +
      "<p>" + (ntfyOn ? "Sending to topic <b>" + esc(state.settings.ntfyTopic) + "</b>." :
        "Free phone notifications with no account. Install the ntfy app, pick a private topic and you are set.") + "</p>" +
      '<button class="btn ghost small" data-view="settings">' + (ntfyOn ? "Manage topic" : "Set up ntfy") + "</button></div>") +
    card("telegram", '<div class="channel ' + (tgOn ? "on" : "") + '"><div class="channel-top"><strong>Telegram</strong>' + dot(tgOn) + "</div>" +
      "<p>" + (tgOn ? "Bot configured and ready." : "Create a bot with @BotFather, then add its token and your chat ID.") + "</p>" +
      '<button class="btn ghost small" data-view="settings">' + (tgOn ? "Manage bot" : "Set up Telegram") + "</button></div>") +
    card("telegramCalls", '<div class="channel ' + (callOn ? "on" : "") + '"><div class="channel-top"><strong>Telegram call (basic)</strong>' + dot(callOn) + "</div>" +
      "<p>" + (callOn ? "Tradera rings <b>" + esc(state.settings.callmebotUser) + "</b> on Telegram and reads the alert aloud when price reaches an entry."
        : "Get a real Telegram voice call when price hits your entry, so you never sleep through a setup.") + "</p>" +
      '<button class="btn ghost small" data-' + (callOn ? 'action="test-call"' : 'view="settings"') + ">" + (callOn ? "Test call" : "Set up calls") + "</button></div>") +
    '<div class="channel ' + (browserOn ? "on" : "") + '"><div class="channel-top"><strong>This browser</strong>' + dot(browserOn, browserPermission === "denied") + "</div>" +
      "<p>" + (browserPermission === "granted"
        ? (ui.browserAlerts ? "Browser alerts are on for this device." : "Permission granted — enable alerts to use them.")
        : browserPermission === "denied" ? "Blocked in browser settings. Allow notifications for this page to enable."
        : "Needs this tab open. Click to allow notifications.") + "</p>" +
      '<button class="btn ghost small" data-action="enable-alerts">' +
        (browserPermission === "granted" ? (ui.browserAlerts ? "Turned on" : "Turn on") : "Allow notifications") + "</button></div>" +
    "</div>" +

    '<div class="notice section-gap"><span class="n-ico">ⓘ</span><div><b>How alerts work.</b> Every ' +
      (state.effectivePollSeconds || state.settings.pollSeconds) + "s the app checks live prices against your watching setups. When price is within a setup's alert distance " +
      "(default " + state.settings.defaultThresholdPips + " pips for FX, points for crypto and indices), it fires once. It re-arms after price moves 1.6× that distance away. " +
      "Browser alerts need this tab open; ntfy or Telegram reach your phone even when the tab is closed, " +
      (state.realtime === false ? "through the scheduled Netlify check." : "as long as this app is running.") + "</div></div>" +

    '<section class="panel section-gap">' +
      '<div class="panel-head"><h2>Alert log</h2><span class="hint">' + state.alerts.length + " recent</span></div>" +
      (state.alerts.length
        ? state.alerts.map(function (a) {
            const channels = (a.channels || []).map(c =>
              '<span class="chip">' + esc(c.channel || c) + (c.ok === false ? " failed" : " sent") + "</span>").join("");
            const reminder = a.kind === "reminder";
            const outcome = a.kind === "outcome";
            return '<div class="alert-row' + (reminder ? "" : " row-link") + '"' + (reminder ? "" : ' data-action="chart" data-symbol="' + esc(a.symbol) + '"') + ">" +
              '<div class="alert-ico ' + (a.kind === "entry" ? "entry" : a.kind === "test" || reminder ? "test" : "") + '">' + (a.kind === "entry" ? "◎" : a.kind === "test" ? "✓" : reminder ? "⏰" : "↗") + "</div>" +
              '<div class="alert-main"><b>' + (reminder ? "Chart check" : esc(a.symbol) + " · " +
                esc(a.kind === "entry" ? "Entry reached" : a.kind === "test" ? "Test alert" : outcome ? "Setup finished" : "Getting close to entry")) + "</b>" +
                "<p>" + esc(a.message) + "</p>" +
                (channels ? '<div class="chips">' + channels + "</div>" : "") + "</div>" +
              '<div class="alert-time">' + timeAgo(a.at) + "</div></div>";
          }).join("")
        : emptyState("◔", "No alerts yet", "When price nears one of your setups, the alert is logged here. Send a test alert to check your phone is wired up.", "")) +
    "</section>";
}

/* --------------------------------------------------------- chart reminders */

const REMINDER_STEPS = [[30, "30 minutes"], [60, "1 hour"], [90, "1½ hours"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"], [360, "6 hours"], [480, "8 hours"], [720, "12 hours"]];
const WEEK = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];

function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (_) { return "UTC"; }
}

function reminderTimes(r) {
  const toMin = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const out = [];
  for (let m = toMin(r.from); m <= toMin(r.to) && out.length < 48; m += Number(r.everyMinutes)) {
    out.push(String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
  }
  return out;
}

function feedUrl(kind) {
  const key = state.settings.feedKey;
  if (!key) return "";
  const path = kind === "ics" ? "/api/reminders/calendar.ics" : "/api/reminders/today.json";
  const q = "?" + (state.account && state.account.id ? "u=" + encodeURIComponent(state.account.id) + "&" : "") + "k=" + encodeURIComponent(key);
  return location.origin + path + q;
}

function remindersPanel() {
  const r = state.settings.reminders || { enabled: false, everyMinutes: 240, from: "08:00", to: "20:00", days: [1, 2, 3, 4, 5], tz: deviceTimeZone() };
  const times = reminderTimes(r);
  const next = state.nextReminderAt ? new Date(state.nextReminderAt) : null;
  const nextText = next
    ? (next.toDateString() === new Date().toDateString() ? "today " : next.toLocaleDateString(undefined, { weekday: "long" }) + " ") +
      next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  const tzNote = r.tz && r.tz !== deviceTimeZone()
    ? ' <span class="faint">Saved for ' + esc(r.tz) + "; saving again switches to this device's time zone (" + esc(deviceTimeZone()) + ").</span>"
    : "";
  const ics = feedUrl("ics");
  const today = feedUrl("json");

  return '<section class="panel reminders">' +
    '<div class="panel-head"><h2>Chart check reminders</h2>' +
      '<span class="state-dot ' + (r.enabled ? "on" : "off") + '">' + (r.enabled ? "On" : "Off") + "</span></div>" +
    '<form id="remindersForm" class="panel-body">' +
      '<p class="muted reminder-lead">A nudge to open your charts on a schedule, even when nothing is near entry. It comes through your ntfy, Telegram and browser alerts, and lists the setups closest to entry.</p>' +
      '<label class="check-line big"><input type="checkbox" name="enabled"' + (r.enabled ? " checked" : "") + "> Remind me to check my charts</label>" +
      '<div class="form-grid reminder-grid">' +
        '<label class="field"><span>Every</span><select name="everyMinutes">' +
          REMINDER_STEPS.map(x => '<option value="' + x[0] + '"' + (Number(r.everyMinutes) === x[0] ? " selected" : "") + ">" + x[1] + "</option>").join("") +
        "</select></label>" +
        '<label class="field"><span>First check</span><input type="time" name="from" value="' + esc(r.from) + '" required></label>' +
        '<label class="field"><span>Last check <em>no later than</em></span><input type="time" name="to" value="' + esc(r.to) + '" required></label>' +
      "</div>" +
      '<div class="field" style="margin-top:12px"><span class="field-label">On these days</span><div class="day-chips">' +
        WEEK.map(d => '<label class="day-chip"><input type="checkbox" name="day" value="' + d[0] + '"' + (r.days.includes(d[0]) ? " checked" : "") + "><span>" + d[1] + "</span></label>").join("") +
      "</div></div>" +
      '<div class="reminder-summary" id="reminderSummary">' +
        (r.enabled && times.length ? "Checks at <b>" + times.join(", ") + "</b>." + (nextText ? " Next: <b>" + esc(nextText) + "</b>." : "") : "Reminders are off.") + tzNote +
      "</div>" +
      '<div class="toolbar" style="margin:12px 0 0">' +
        '<button class="btn primary small" type="submit">Save reminders</button>' +
        '<button class="btn ghost small" type="button" data-action="test-reminder">Send one now</button>' +
      "</div>" +
    "</form>" +

    '<div class="panel-body iphone-sync">' +
      "<h3>Put them on your iPhone</h3>" +
      '<p class="muted">Apple does not let websites write to the Reminders app directly, so pick one of these. Both update themselves when you change the schedule above.</p>' +
      (!state.settings.feedKey
        ? '<button class="btn small" type="button" data-action="feed-key">Create my iPhone links</button>'
        : '<div class="sync-option">' +
            '<div class="sync-head"><b>Option 1 · iPhone Calendar</b><span class="pill triggered">Easiest</span></div>' +
            "<p>One tap. Every check appears in your Calendar with an alert at the exact time.</p>" +
            '<div class="toolbar"><a class="btn primary small" href="' + esc(ics.replace(/^https?:/, "webcal:")) + '">Add to iPhone Calendar</a>' +
              '<button class="btn ghost small" type="button" data-action="copy-text" data-text="' + esc(ics) + '">Copy link</button></div>' +
            '<p class="field-note">Then on the iPhone: Settings → Apps → Calendar → Calendar Accounts → Subscribed Calendars → <b>Tradera chart checks</b>, and turn <b>off</b> “Remove Alerts”, so the alerts ring.</p>' +
          "</div>" +
          '<div class="sync-option">' +
            '<div class="sync-head"><b>Option 2 · Reminders app</b><span class="pill watching">Automatic each morning</span></div>' +
            "<p>An Apple Shortcut copies the day's checks into a <b>Tradera</b> list in Reminders, with an alert on each. You set it up once:</p>" +
            '<ol class="steps">' +
              "<li>In the <b>Reminders</b> app, create a list called <b>Tradera</b>.</li>" +
              '<li>Open <b>Shortcuts</b> → <b>+</b>. Add <b>Get Contents of URL</b> and paste this link: <button class="btn ghost small" type="button" data-action="copy-text" data-text="' + esc(today) + '">Copy Shortcut link</button></li>' +
              "<li>Add <b>Get Dictionary Value</b>: get <b>Value</b> for key <b>items</b> in <i>Contents of URL</i>.</li>" +
              "<li>Add <b>Repeat with Each</b> item in <i>Dictionary Value</i>. Inside it, add <b>Get Dictionary Value</b> for key <b>title</b> in <i>Repeat Item</i>, and another for key <b>due</b> in <i>Repeat Item</i>.</li>" +
              "<li>Still inside, add <b>Add New Reminder</b>: use the <i>title</i> value, list <b>Tradera</b>, tap the arrow, turn on <b>Remind Me</b> → <b>At a Time</b>, and pick the <i>due</i> value as the date.</li>" +
              "<li>Name it <b>Tradera chart checks</b>. In the <b>Automation</b> tab tap <b>+</b> → <b>Time of Day</b>, choose a time before your first check, <b>Daily</b>, <b>Run Immediately</b>, and pick the shortcut.</li>" +
            "</ol>" +
          "</div>" +
          '<p class="field-note">These links are private to you. If one gets shared by mistake, <button class="link-btn" type="button" data-action="feed-key-rotate">make new links</button> (the old ones stop working).</p>') +
    "</div>" +
  "</section>";
}

/* ---------------------------------------------------------------- settings */

function settingsSection(title, text, body) {
  return '<div class="form-section"><div class="form-section-head"><h3>' + esc(title) + "</h3><p>" + text + "</p></div><div>" + body + "</div></div>";
}

function securitySection() {
  if (state.accounts) {
    return settingsSection("Account", "Signed in as <b>" + esc((state.account && state.account.email) || "") + "</b>. Use this email and password to log in on any device. Logins last 30 days.",
      '<div class="form-grid">' +
        '<label class="field full"><span>Current password</span><input id="pwCurrent" type="password" autocomplete="current-password"></label>' +
        '<label class="field"><span>New password <em>10+ characters</em></span><input id="pwNew" type="password" autocomplete="new-password"></label>' +
        '<label class="field"><span>Repeat new password</span><input id="pwRepeat" type="password" autocomplete="new-password"></label>' +
      "</div>" +
      '<div class="toolbar" style="margin:12px 0 0">' +
        '<button class="btn ghost small" type="button" data-action="set-password">Change password</button>' +
        '<button class="btn ghost small" type="button" data-action="lock-desk">Log out</button>' +
        '<button class="btn ghost small" type="button" data-action="logout-all">Log out other devices</button>' +
        '<button class="btn danger small" type="button" data-action="delete-account">Delete account</button>' +
      "</div>" +
      '<div class="field-note" style="margin-top:8px">Changing your password, or logging out other devices, signs out every other phone and browser. Deleting your account needs your current password and removes your journal for good.</div>' +
      (state.account && state.account.admin ? '<div class="field-note" style="margin-top:8px"><b>Admin account.</b> Change this password in the <a href="/admin/" target="_blank" rel="noopener">admin dashboard</a>, which also asks for your 2-step code.</div>' : ""));
  }
  if (!state.passwordSet) {
    return settingsSection("Password", "Anyone who can open Tradera can see your journal. Set a password to require a login on every device.",
      '<div class="form-grid">' +
        '<label class="field"><span>New password <em>10+ characters</em></span><input id="pwNew" type="password" autocomplete="new-password"></label>' +
        '<label class="field"><span>Repeat password</span><input id="pwRepeat" type="password" autocomplete="new-password"></label>' +
      "</div>" +
      '<div class="toolbar" style="margin:12px 0 0"><button class="btn primary small" type="button" data-action="set-password">Set password</button></div>');
  }
  return settingsSection("Password", "Tradera asks for your password on each new device. Logins last 30 days.",
    '<div class="form-grid">' +
      '<label class="field full"><span>Current password</span><input id="pwCurrent" type="password" autocomplete="current-password"></label>' +
      '<label class="field"><span>New password <em>8+ characters</em></span><input id="pwNew" type="password" autocomplete="new-password"></label>' +
      '<label class="field"><span>Repeat new password</span><input id="pwRepeat" type="password" autocomplete="new-password"></label>' +
    "</div>" +
    '<div class="toolbar" style="margin:12px 0 0">' +
      '<button class="btn ghost small" type="button" data-action="set-password">Change password</button>' +
      '<button class="btn ghost small" type="button" data-action="lock-desk">Log out</button>' +
      '<button class="btn ghost small" type="button" data-action="logout-all">Log out other devices</button>' +
      '<button class="btn danger small" type="button" data-action="disable-password">Turn off password</button>' +
    "</div>" +
    '<div class="field-note" style="margin-top:8px">Changing your password, or logging out other devices, signs out every other phone and browser.</div>');
}

function renderSettings() {
  const s = state.settings;
  const theme = store("theme") || "system";
  return '<form id="settingsForm" class="panel"><div class="panel-body">' +
    settingsSection("Appearance", "Tradera follows your device by default.",
      '<div class="segmented" role="radiogroup" aria-label="Theme" style="max-width:340px">' +
        [["system", "System"], ["dark", "Dark"], ["light", "Light"]].map(function (row) {
          return '<label><input type="radio" name="theme" value="' + row[0] + '"' + (theme === row[0] ? " checked" : "") +
            ' data-action="set-theme"><span>' + row[1] + "</span></label>";
        }).join("") + "</div>") +

    securitySection() +

    settingsSection("Account", "Used to show your balance and work out returns.",
      '<div class="form-grid">' +
        '<label class="field"><span>Currency</span><input name="accountCurrency" value="' + esc(s.accountCurrency) + '" maxlength="6" autocomplete="off" placeholder="USD"></label>' +
        '<label class="field"><span>Starting balance</span><input name="startingBalance" type="number" step="any" value="' + esc(s.startingBalance) + '"></label>' +
      "</div>") +

    settingsSection("Price feed", "Where live prices come from. Deriv gives live bid and ask prices for forex, gold and indices with no account or key.",
      '<div class="form-grid">' +
        '<label class="field full"><span>Source</span><select name="feed">' +
          '<option value="deriv"' + (s.feed === "deriv" ? " selected" : "") + ">Deriv live bid/ask (recommended, no key)</option>" +
          '<option value="oanda"' + (s.feed === "oanda" ? " selected" : "") + ">OANDA live bid/ask (needs OANDA token)</option>" +
          '<option value="yahoo"' + (s.feed === "yahoo" ? " selected" : "") + ">Yahoo Finance (no key, can lag)</option>" +
          '<option value="twelvedata"' + (s.feed === "twelvedata" ? " selected" : "") + ">Twelve Data (free key, 60s minimum)</option>" +
          '<option value="demo"' + (s.feed === "demo" ? " selected" : "") + ">Demo prices (for testing)</option>" +
        "</select></label>" +
        '<label class="field"><span>OANDA API token <em>for OANDA</em></span><input name="oandaToken" type="password" value="' + esc(s.oandaToken) + '" autocomplete="off" placeholder="Paste from OANDA → Manage API Access"></label>' +
        '<label class="field"><span>OANDA account</span><select name="oandaEnv">' +
          '<option value="practice"' + (s.oandaEnv !== "live" ? " selected" : "") + ">Practice (demo)</option>" +
          '<option value="live"' + (s.oandaEnv === "live" ? " selected" : "") + ">Live</option>" +
        "</select></label>" +
        '<label class="check-line full"><input type="checkbox" name="binanceCrypto"' + (s.binanceCrypto !== false ? " checked" : "") +
          "> Use Binance for crypto (exact live BTC, ETH, SOL prices, no key)</label>" +
        '<label class="field"><span>Twelve Data key <em>optional</em></span><input name="twelveDataKey" type="password" value="' + esc(s.twelveDataKey) + '" autocomplete="off" placeholder="Only needed for Twelve Data"></label>' +
        '<label class="field"><span>Refresh every <em>seconds</em></span><input name="pollSeconds" type="number" min="5" max="600" step="1" value="' + esc(s.pollSeconds) + '"></label>' +
        '<label class="field"><span>Default alert distance <em>pips / pts</em></span><input name="defaultThresholdPips" type="number" min="1" step="1" value="' + esc(s.defaultThresholdPips) + '"></label>' +
      "</div>" +
      '<div class="field-note" style="margin-top:10px">TradingView has no public price API, so Tradera can\'t read its prices directly. ' +
        "Deriv covers forex, gold, silver and major indices for free. OANDA is an alternative if it is available in your country. " +
        "Anything a source can't price falls back to Yahoo automatically. Long setups are judged on the ask and shorts on the bid, the prices your orders actually fill at.</div>") +

    settingsSection("Notifications", "Get pinged on your phone when price nears an entry, even with Tradera closed.",
      '<div class="form-grid">' +
        '<label class="field full"><span>Pushover user key <em>alarm that rings until you tap it</em></span>' +
          '<div style="display:flex;gap:6px"><input name="pushoverUser" value="' + esc(s.pushoverUser || "") + '" autocomplete="off" placeholder="30 letters and numbers, e.g. uQiRzpo4DXghDmr9QzzfQu27cmVRsG">' +
          '<button class="btn ghost small" type="button" data-action="test-alert">Test</button></div></label>' +
        (state.pushoverApp ? "" :
          '<label class="field full"><span>Pushover app token <em>only until the site owner switches Pushover on</em></span><input name="pushoverToken" type="password" value="' + esc(s.pushoverToken || "") + '" autocomplete="off" placeholder="From pushover.net → Create an Application"></label>') +
        '<label class="field full"><span>ntfy topic <em>phone push</em></span>' +
          '<div style="display:flex;gap:6px"><input id="ntfyTopic" name="ntfyTopic" value="' + esc(s.ntfyTopic) + '" autocomplete="off" placeholder="e.g. tradera-yourname-8f3k">' +
          '<button class="btn ghost small" type="button" data-action="gen-topic">Generate</button></div></label>' +
        '<label class="field"><span>ntfy server</span><input name="ntfyServer" value="' + esc(s.ntfyServer) + '" autocomplete="off"></label>' +
        '<label class="field"><span>Telegram bot token <em>optional</em></span><input name="telegramToken" type="password" value="' + esc(s.telegramToken) + '" autocomplete="off"></label>' +
        '<label class="field"><span>Telegram chat ID</span>' +
          '<div style="display:flex;gap:6px"><input id="telegramChatId" name="telegramChatId" value="' + esc(s.telegramChatId) + '" autocomplete="off" placeholder="Press Find after messaging your bot">' +
          '<button class="btn ghost small" type="button" data-action="find-chat">Find</button></div></label>' +
        '<label class="field"><span>Call me on Telegram <em>your @username</em></span>' +
          '<div style="display:flex;gap:6px"><input name="callmebotUser" value="' + esc(s.callmebotUser) + '" autocomplete="off" placeholder="@yourusername">' +
          '<button class="btn ghost small" type="button" data-action="test-call">Test call</button></div></label>' +
        '<label class="check-line" style="align-self:end;padding-bottom:10px"><input type="checkbox" name="callOnApproach"' + (s.callOnApproach ? " checked" : "") +
          "> Also ring me when price is getting close (call and urgent ntfy)</label>" +
      "</div>" +
      '<div class="field-note" style="margin-top:10px"><b>Pushover alarm (recommended):</b> install Pushover (iPhone or Android; 30-day free trial, then a one-off $5), sign up, and copy the <b>Your User Key</b> code from the top of the app or pushover.net into the box above. Save, then press Test. ' +
        "Entry alerts then ring as an alarm through silent mode and Do Not Disturb and repeat every 30 seconds for 10 minutes until you tap them. On iPhone, allow Critical Alerts when Pushover asks.</div>" +
      '<div class="field-note" style="margin-top:10px">ntfy: install the free ntfy app, subscribe to the topic above, save, then send a test alert. Entry alerts are sent as urgent; in the ntfy Android app turn on Settings → Keep alerting for highest priority so they keep ringing until you dismiss them. ' +
        "Telegram: paste your bot token, press Start in your bot's chat, then press Find to fill in your chat ID. " +
        "Calls: open Telegram, send /start to @CallMeBot_txtbot once to allow it, then save your @username here. Calls ring when price reaches an entry.</div>") +

    settingsSection("Backup", state.realtime === false
        ? "Your data lives in Netlify Blobs. Export a copy before you change deployments."
        : "Your data lives on this computer in data/db.json. Export a copy now and then.",
      '<div class="toolbar" style="margin:0">' +
        '<button class="btn ghost small" type="button" data-action="export-json">Download backup</button>' +
        '<label class="btn ghost small" style="cursor:pointer">Restore from backup<input type="file" id="importFile" accept="application/json" hidden></label>' +

      "</div>") +

    '<div class="form-actions"><span class="spacer"></span>' +
      '<button class="btn" type="button" data-action="test-alert">Send test alert</button>' +
      '<button class="btn primary" type="submit">Save settings</button>' +
    "</div>" +
    '<div class="form-error" id="settingsError" hidden></div>' +
    "</div></form>";
}

/* ------------------------------------------------------------- view events */

function attachViewListeners() {
  if (ui.view === "journal") {
    const q = document.getElementById("jq");
    const st = document.getElementById("jstatus");
    const pr = document.getElementById("jpair");
    if (q) q.addEventListener("input", function () {
      ui.journal.q = q.value;
      const box = document.getElementById("journalTable");
      if (box) box.innerHTML = journalTableHtml();
    });
    if (st) st.addEventListener("change", function () {
      ui.journal.status = st.value;
      const box = document.getElementById("journalTable");
      if (box) box.innerHTML = journalTableHtml();
    });
    if (pr) pr.addEventListener("change", function () {
      ui.journal.pair = pr.value;
      const box = document.getElementById("journalTable");
      if (box) box.innerHTML = journalTableHtml();
    });
  }

  if (ui.view === "alerts") {
    const form = document.getElementById("remindersForm");
    if (form) form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const fd = new FormData(form);
      const days = fd.getAll("day").map(Number);
      const payload = {
        enabled: fd.get("enabled") === "on",
        everyMinutes: Number(fd.get("everyMinutes")),
        from: fd.get("from"),
        to: fd.get("to"),
        days,
        tz: deviceTimeZone()
      };
      if (payload.enabled && !days.length) return toast("Pick a day", "Choose at least one day for your chart checks.", "error");
      try {
        applyState(await post("/api/reminders", payload));
        toast(payload.enabled ? "Reminders saved" : "Reminders off",
          payload.enabled ? "Tradera will remind you at " + reminderTimes(payload).join(", ") + "." : "No more chart-check reminders.");
      } catch (err) { toast("Could not save reminders", err.message, "error"); }
    });
  }

  if (ui.view === "pairs") {
    const form = document.getElementById("pairForm");
    if (form) form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const next = await post("/api/pairs", {
          symbol: fd.get("symbol"),
          priority: fd.get("priority") === "on",
          monitor: true
        });
        form.reset();
        applyState(next);
        toast("Market added", String(fd.get("symbol")).toUpperCase() + " is now on your watchlist.");
      } catch (err) { toast("Could not add market", err.message, "error"); }
    });
  }

  if (ui.view === "settings") {
    const form = document.getElementById("settingsForm");
    if (form) form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const err = document.getElementById("settingsError");
      err.hidden = true;
      const fd = new FormData(form);
      const payload = {};
      ["accountCurrency", "startingBalance", "feed", "twelveDataKey", "oandaToken", "oandaEnv", "pollSeconds",
        "defaultThresholdPips", "ntfyServer", "ntfyTopic", "telegramToken", "telegramChatId", "callmebotUser",
        "pushoverUser", "pushoverToken"].forEach(function (key) {
        if (fd.has(key)) payload[key] = fd.get(key);
      });
      payload.binanceCrypto = fd.get("binanceCrypto") === "on";
      payload.callOnApproach = fd.get("callOnApproach") === "on";
      try {
        const next = await post("/api/settings", payload);
        applyState(next);
        toast("Settings saved", "Your feed, alerts and account are up to date.");
      } catch (error) {
        err.textContent = error.message;
        err.hidden = false;
      }
    });
    const importInput = document.getElementById("importFile");
    if (importInput) importInput.addEventListener("change", async function () {
      const file = importInput.files && importInput.files[0];
      if (!file) return;
      if (!(await confirmDialog("Restore this backup?", "Your current trades, setups, markets and settings will be replaced with the contents of " + file.name + ".", "Restore"))) {
        importInput.value = "";
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const next = await post("/api/import", parsed);
        applyState(next);
        toast("Backup imported", "Your book has been restored.");
      } catch (error) {
        toast("Import failed", error.message, "error");
      }
      importInput.value = "";
    });
  }
}

/* ------------------------------------------------------------------ live */

function updateLiveNodes() {
  if (!state) return;
  document.querySelectorAll("[data-price]").forEach(function (el) {
    const symbol = el.dataset.price;
    const q = quoteOf(symbol);
    const price = q ? Number(q.price) : null;
    const last = el.dataset.last === undefined ? null : Number(el.dataset.last);
    el.textContent = fmtPrice(symbol, price);
    el.classList.toggle("faint", !!(q && isStale(q)));
    if (price !== null && Number.isFinite(price)) {
      // Flash green/red when the price moves so ticks are visible at a glance.
      if (last !== null && price !== last) {
        el.classList.remove("tick-up", "tick-down");
        void el.offsetWidth;
        el.classList.add(price > last ? "tick-up" : "tick-down");
      }
      el.dataset.last = String(price);
    }
  });
  document.querySelectorAll("[data-change]").forEach(function (el) {
    const symbol = el.dataset.change;
    const q = quoteOf(symbol);
    const change = q && q.changePct !== null && q.changePct !== undefined ? q.changePct : null;
    el.textContent = change === null ? "—" : (change > 0 ? "+" : "") + fmtNum(change, 2) + "%";
    el.className = change === null ? "faint" : change > 0 ? "pos" : change < 0 ? "neg" : "faint";
  });
  document.querySelectorAll("[data-dist]").forEach(function (el) {
    const setup = findSetupView(el.dataset.dist);
    if (!setup) return;
    el.textContent = setupDistanceText(setup);
    const runway = el.closest(".runway");
    if (runway) runway.className = "runway row-link " + (setup.crossed ? "hit" : setup.near ? "near" : "");
    const parent = el.closest(".dist");
    if (parent) {
      parent.className = "dist " + (setup.crossed ? "hit" : setup.near ? "near" : "");
    } else {
      el.className = setup.crossed ? "hit" : setup.near ? "near" : "";
    }
  });
  document.querySelectorAll("[data-meter]").forEach(function (el) {
    const setup = findSetupView(el.dataset.meter);
    if (!setup) return;
    el.style.width = meterWidth(setup) + "%";

  });
  updateFeedPill();
  updateNavDot();
}

function findSetupView(id) {
  const a = state.priority.find(s => s.id === id);
  if (a) return a;
  return state.setups.find(s => s.id === id) || null;
}

function updateNavDot() {
  const dot = document.getElementById("navAlertDot");
  if (dot) dot.hidden = !(state && state.priority.some(s => s.near));
  const mobileDot = document.getElementById("mobileAlertDot");
  if (mobileDot) mobileDot.hidden = !(state && state.priority.some(s => s.near));
}

function updateNotifyButton() {
  const btn = document.getElementById("notifyBtn");
  const mobile = document.querySelector(".mb-bell");
  const supported = "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  if (btn) {
    if (!supported) {
      btn.textContent = "Browser alerts not supported";
      btn.disabled = true;
    } else {
      btn.classList.toggle("on", granted && ui.browserAlerts);
      btn.textContent = granted ? (ui.browserAlerts ? "✓ Browser alerts on" : "Turn on browser alerts") : "Turn on browser alerts";
    }
  }
  if (mobile) {
    mobile.classList.toggle("on", granted && ui.browserAlerts);
    mobile.title = supported
      ? (granted && ui.browserAlerts ? "Browser alerts on" : "Enable browser alerts")
      : "Browser alerts unavailable";
  }
}

function liveUpdate(structural) {
  if (!state) return;
  updateLiveNodes();
  const modalOpen = modal.open;
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") &&
    document.activeElement.closest("#view");
  const liveView = ["dashboard", "pairs", "setups", "alerts"].includes(ui.view);
  if (structural && liveView && !modalOpen && !typing) {
    renderView();
    renderChrome();
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource("/api/events" + (deskKey() ? "?key=" + encodeURIComponent(deskKey()) : ""));
  eventSource.onopen = function () {
    sseFailures = 0;
  };
  eventSource.addEventListener("snapshot", function (event) {
    try {
      const payload = JSON.parse(event.data);
      if (!state) return;
      state.quotes = payload.quotes || {};
      state.priority = payload.priority || [];
      state.stats = payload.stats || state.stats;
      state.feedStatus = payload.feedStatus || state.feedStatus;
      if (payload.alerts) {
        state.alerts = payload.alerts;
        seedAlerts(payload.alerts);
      }
      liveUpdate(true);
    } catch (_) { /* ignore malformed */ }
  });
  eventSource.addEventListener("alert", function (event) {
    try {
      const alert = JSON.parse(event.data);
      if (alert && alert.id && seenAlerts.has(alert.id)) return;
      if (alert && alert.id) seenAlerts.add(alert.id);
      state.alerts.unshift(alert);
      showAlert(alert);
      liveUpdate(true);
    } catch (_) { /* ignore */ }
  });
  eventSource.addEventListener("alerts", function (event) {
    try {
      state.alerts = JSON.parse(event.data);
      seedAlerts(state.alerts);
      liveUpdate(true);
    } catch (_) { /* ignore */ }
  });
  eventSource.onerror = function () {
    sseFailures++;
    if (sseFailures >= 3) {
      try { eventSource.close(); } catch (_) { /* ignore */ }
      setFeedError("Live paused — polling");
      if (!pollTimer && state) {
        pollTimer = setInterval(pollState, Math.max(15000, Number(state.effectivePollSeconds) || 20) * 1000);
      }
    } else {
      setFeedError("Reconnecting…");
    }
  };
}

function showAlert(alert) {
  if (alert.kind === "outcome") {
    toast(symLabel(alert.symbol) + " setup finished", alert.message, "alert", 15000);
    if (ui.browserAlerts && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(symLabel(alert.symbol) + " setup finished", { body: alert.message, tag: alert.id }); } catch (_) { /* ignore */ }
    }
    return;
  }
  if (alert.kind === "reminder") {
    toast("Time to check your charts", alert.message, "alert", 12000);
    if (ui.browserAlerts && "Notification" in window && Notification.permission === "granted") {
      try { new Notification("Time to check your charts", { body: alert.message, tag: alert.id }); } catch (_) { /* ignore */ }
    }
    beep();
    return;
  }
  const entry = alert.kind === "entry";
  toast(entry ? alert.symbol + " reached your entry" : alert.symbol + " is getting close",
    alert.message, "alert", 12000);
  if (ui.browserAlerts && "Notification" in window && Notification.permission === "granted") {
    try {
      const note = new Notification(entry ? alert.symbol + " at entry" : alert.symbol + " approaching entry", {
        body: alert.message,
        tag: alert.id,
        silent: false
      });
      note.onclick = function () {
        window.focus();
        openChart(alert.symbol);
        note.close();
      };
    } catch (_) { /* ignore */ }
  }
  beep();
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    osc.onended = function () { ctx.close(); };
  } catch (_) { /* audio blocked until interaction */ }
}

/* ------------------------------------------------------------------- toasts */

function toast(title, message, kind, timeout) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.innerHTML = '<div class="t-ico">' + (kind === "error" ? "!" : kind === "alert" ? "!" : "✓") + "</div>" +
    '<div class="t-main"><strong>' + esc(title) + "</strong><span>" + esc(message) + "</span></div>" +
    '<button class="icon-btn t-close" aria-label="Dismiss">' + icon("close") + "</button>";
  el.style.setProperty("--life", (timeout || 6500) + "ms");
  el.querySelector(".t-close").addEventListener("click", function () { el.remove(); });
  toastsEl.appendChild(el);
  while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
  setTimeout(function () { el.remove(); }, timeout || 6500);
}

/** In-app replacement for window.confirm() that resolves to true or false. */
function confirmDialog(title, text, okLabel) {
  const dlg = document.getElementById("confirmDialog");
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmText").textContent = text;
  document.getElementById("confirmOk").textContent = okLabel || "Delete";
  dlg.returnValue = "";
  return new Promise(function (resolve) {
    dlg.addEventListener("close", function () { resolve(dlg.returnValue === "ok"); }, { once: true });
    dlg.showModal();
    document.getElementById("confirmOk").focus();
  });
}

/* ------------------------------------------------------------------- modal */

function openModal(html) {
  modalBody.innerHTML = '<div class="modal-inner">' + html + "</div>";
  if (!modal.open) modal.showModal();
  modalBody.scrollTop = 0;
}
function closeModal() {
  if (modal.open) modal.close();
  modalBody.innerHTML = "";
}
function modalHeader(title, subtitle) {
  return '<div class="modal-head"><div><h2>' + esc(title) + "</h2>" +
    (subtitle ? "<p>" + esc(subtitle) + "</p>" : "") + "</div>" +
    '<button class="icon-btn modal-close" data-close aria-label="Close">' + icon("close") + "</button></div>";
}
function formError() {
  return '<div class="form-error" id="formError" hidden></div>';
}

function directionField(value) {
  const v = value === "short" ? "short" : "long";
  return '<div class="field"><span style="font-size:12.5px;font-weight:600;color:var(--muted)">Direction</span>' +
    '<div class="segmented" role="radiogroup" aria-label="Direction" style="margin-top:6px">' +
      '<label class="long"><input type="radio" name="direction" value="long"' + (v === "long" ? " checked" : "") + "><span>▲ Long</span></label>" +
      '<label class="short"><input type="radio" name="direction" value="short"' + (v === "short" ? " checked" : "") + "><span>▼ Short</span></label>" +
    "</div></div>";
}

/* --------------------------------------------------------------- trade form */

function openTradeForm(trade, presetSetup) {
  const t = trade || {};
  const isEdit = !!trade;
  const isClosed = t.status === "closed";
  const title = isEdit ? "Edit trade" : presetSetup ? (presetSetup.status === "watching" || presetSetup.status === "triggered" ? "Trigger setup" : "Log finished setup") : "New trade";
  const subtitle = presetSetup
    ? presetSetup.symbol + " " + String(presetSetup.direction).toUpperCase() + " · entry " +
      fmtPrice(presetSetup.symbol, presetSetup.entry)
    : isEdit ? t.symbol + " · " + String(t.direction || "long").toUpperCase() : "Add your risk and Tradera works out R for you";

  const symbol = t.symbol || (presetSetup && presetSetup.symbol) || "";
  const direction = t.direction || (presetSetup && presetSetup.direction) || "long";
  const entry = t.entry !== undefined ? t.entry : presetSetup ? presetSetup.entry : "";
  const stop = t.stop !== undefined && t.stop !== null ? t.stop : presetSetup ? presetSetup.stop : "";
  const target = t.target !== undefined && t.target !== null ? t.target : presetSetup ? presetSetup.target : "";
  const setupId = t.setupId || (presetSetup && presetSetup.id) || "";

  openModal(
    modalHeader(title, subtitle) +
    '<form id="tradeForm">' +
      '<input type="hidden" name="id" value="' + esc(t.id || "") + '">' +
      '<input type="hidden" name="setupId" value="' + esc(setupId) + '">' +
      '<input type="hidden" name="setupLabel" value="' + esc(t.setupLabel || (presetSetup && presetSetup.label) || "") + '">' +
      '<div class="form-grid">' +
        '<div class="field"><span class="field-label">Pair</span>' + pickerField('<input name="symbol" data-picker="all" value="' + esc(symbol) + '" placeholder="Tap to pick" required autocomplete="off" aria-label="Pair">') + "</div>" +
        directionField(direction) +
        '<label class="field"><span>Status</span><select name="status" id="tradeStatus">' +
          '<option value="open"' + (!isClosed ? " selected" : "") + ">Open</option>" +
          '<option value="closed"' + (isClosed ? " selected" : "") + ">Closed</option></select></label>" +
        '<label class="field"><span>Entry</span><input name="entry" type="number" step="any" value="' + esc(entry) + '" required></label>' +
        '<label class="field"><span>Stop</span><input name="stop" type="number" step="any" value="' + esc(stop) + '"></label>' +
        '<label class="field"><span>Target</span><input name="target" type="number" step="any" value="' + esc(target) + '"></label>' +
        '<label class="field"><span>Exit <em>if closed</em></span><input name="exit" type="number" step="any" value="' + esc(t.exit !== null && t.exit !== undefined ? t.exit : "") + '"></label>' +
        '<label class="field"><span>Size / lots <em>optional</em></span><input name="size" type="number" step="any" value="' + esc(t.size !== null && t.size !== undefined ? t.size : "") + '"></label>' +
        '<label class="field"><span>Risk <em>account currency</em></span><input name="riskAmount" type="number" step="any" value="' + esc(t.riskAmount !== null && t.riskAmount !== undefined ? t.riskAmount : "") + '"></label>' +
        '<label class="field"><span>P&L <em>blank = derive from risk</em></span><input name="pnl" type="number" step="any" value="' + esc(t.pnl !== null && t.pnl !== undefined ? t.pnl : "") + '"></label>' +
        '<label class="field"><span>Fees</span><input name="fees" type="number" step="any" value="' + esc(t.fees !== null && t.fees !== undefined ? t.fees : "") + '"></label>' +
        '<label class="field wide-sm"><span>Opened</span><input name="openedAt" type="datetime-local" value="' + esc(toLocalInput(t.openedAt)) + '"></label>' +
        '<label class="field wide-sm"><span>Closed <em>if closed</em></span><input name="closedAt" type="datetime-local" value="' + esc(t.closedAt ? toLocalInput(t.closedAt) : "") + '"></label>' +
        '<label class="field wide-sm"><span>Tags <em>comma separated</em></span><input name="tags" value="' + esc(t.tags || "") + '" placeholder="breakout, london"></label>' +
      "</div>" +
      '<label class="field" style="margin-top:12px"><span>Notes</span><textarea name="notes" placeholder="Why you took it and how you managed it">' + esc(t.notes || "") + "</textarea></label>" +
      shotsField() +
      reviewFields(t) +
      '<div class="preview-box" id="tradePreview"></div>' +
      formError() +
      '<div class="form-actions"><button class="btn" type="button" data-close>Cancel</button>' +
        '<button class="btn primary" type="submit">' + (isEdit ? "Save changes" : "Save trade") + "</button></div>" +
    "</form>"
  );

  const form = document.getElementById("tradeForm");
  const shots = attachShots(form, t.images);
  const statusSelect = document.getElementById("tradeStatus");
  const update = function () {
    const v = k => {
      const val = form.elements[k] ? form.elements[k].value : "";
      return val === "" ? null : Number(val);
    };
    const entryV = v("entry"), stopV = v("stop"), targetV = v("target"), exitV = v("exit"), riskV = v("riskAmount");
    const dir = form.elements.direction.value;
    const pips = (a, b) => a === null || b === null ? null : Math.abs(a - b) / pipSize(form.elements.symbol.value || "EURUSD");
    const reward = pips(entryV, targetV);
    const riskPips = pips(entryV, stopV);
    let rr = null;
    if (entryV !== null && stopV !== null && targetV !== null) {
      const denom = Math.abs(entryV - stopV);
      if (denom) rr = (dir === "short" ? entryV - targetV : targetV - entryV) / denom;
    }
    let autoPnl = null;
    if (form.elements.status.value === "closed" && v("pnl") === null && exitV !== null && riskV && entryV !== null && stopV !== null) {
      const dist = Math.abs(entryV - stopV);
      if (dist) autoPnl = riskV * (((exitV - entryV) * (dir === "short" ? -1 : 1)) / dist);
    }
    const typedPnl = v("pnl");
    const feesV = v("fees") || 0;
    const estNet = typedPnl !== null ? typedPnl - feesV : autoPnl !== null ? autoPnl - feesV : null;
    document.getElementById("tradePreview").innerHTML =
      "<span>Risk <b>" + (riskPips === null ? "—" : fmtNum(riskPips, 1) + " " + unitName(form.elements.symbol.value || "EURUSD")) + "</b></span>" +
      "<span>Reward <b>" + (reward === null ? "—" : fmtNum(reward, 1) + " " + unitName(form.elements.symbol.value || "EURUSD")) + "</b></span>" +
      "<span>R:R <b>" + (rr === null ? "—" : rrText(rr)) + "</b></span>" +
      "<span>Est. net P&L <b class=\"" + pnlClass(estNet) + "\">" + (estNet === null ? "—" : fmtSignedMoney(estNet)) + "</b></span>";
  };
  form.addEventListener("input", update);
  form.addEventListener("change", function (e) {
    if (e.target === statusSelect) update();
  });
  update();

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = document.getElementById("formError");
    err.hidden = true;
    if (shots.busy()) {
      err.textContent = "Wait for your screenshots to finish uploading.";
      err.hidden = false;
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.images = shots.get();
    if (data.symbol) data.symbol = String(data.symbol).toUpperCase().replace(/\s+/g, "");
    if (data.status === "closed" && !data.closedAt) data.closedAt = new Date().toISOString();
    try {
      const next = await post("/api/trades", data);
      closeModal();
      applyState(next);
      toast(isEdit ? "Trade updated" : "Trade saved", (data.symbol || "") + " · " + (data.status === "closed" ? "closed" : "open"));
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });
}

function openCloseForm(trade) {
  openModal(
    modalHeader("Close trade", trade.symbol + " · " + String(trade.direction).toUpperCase() + " · entry " + fmtPrice(trade.symbol, trade.entry)) +
    '<form id="closeForm">' +
      '<input type="hidden" name="id" value="' + esc(trade.id) + '">' +
      '<div class="form-grid">' +
        '<label class="field"><span>Exit price</span><input name="exit" type="number" step="any" required autofocus></label>' +
        '<label class="field wide-sm"><span>Closed at</span><input name="closedAt" type="datetime-local" value="' + esc(toLocalInput()) + '"></label>' +
        '<label class="field"><span>P&L <em>blank = derive from risk</em></span><input name="pnl" type="number" step="any" value=""></label>' +
        '<label class="field"><span>Fees</span><input name="fees" type="number" step="any" value="' + esc(trade.fees || "") + '"></label>' +
      "</div>" +
      '<label class="field" style="margin-top:12px"><span>Closing notes</span><textarea name="notes">' + esc(trade.notes || "") + "</textarea></label>" +
      shotsField() +
      reviewFields(trade) +
      '<div class="preview-box" id="closePreview"></div>' +
      formError() +
      '<div class="form-actions"><button class="btn" type="button" data-close>Cancel</button>' +
        '<button class="btn primary" type="submit">Close trade</button></div>' +
    "</form>"
  );
  const form = document.getElementById("closeForm");
  const shots = attachShots(form, trade.images);
  const update = function () {
    const exitRaw = form.elements.exit.value;
    const exit = exitRaw === "" ? NaN : Number(exitRaw);
    const pnl = form.elements.pnl.value === "" ? null : Number(form.elements.pnl.value);
    const risk = n(trade.riskAmount);
    const dir = String(trade.direction) === "short" ? -1 : 1;
    const pips = Number.isFinite(exit) ? ((exit - Number(trade.entry)) * dir) / pipSize(trade.symbol) : null;
    let estimate = pnl;
    if (estimate === null && Number.isFinite(exit) && risk && trade.stop) {
      const riskDist = Math.abs(Number(trade.entry) - Number(trade.stop));
      if (riskDist) estimate = risk * (((exit - Number(trade.entry)) * dir) / riskDist);
    }
    const fees = n(form.elements.fees.value) || 0;
    const net = estimate === null ? null : estimate - fees;
    document.getElementById("closePreview").innerHTML =
      "<span>Result <b>" + (pips === null ? "—" : (pips > 0 ? "+" : "") + fmtNum(pips, 1) + " " + unitName(trade.symbol)) + "</b></span>" +
      "<span>Net P&L <b class=\"" + pnlClass(net) + "\">" + (net === null ? "—" : fmtSignedMoney(net)) + "</b></span>" +
      "<span>R <b>" + (net !== null && risk ? (net / risk > 0 ? "+" : "") + fmtNum(net / risk, 2) + "R" : "—") + "</b></span>";
  };
  form.addEventListener("input", update);
  update();
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = document.getElementById("formError");
    err.hidden = true;
    if (shots.busy()) {
      err.textContent = "Wait for your screenshots to finish uploading.";
      err.hidden = false;
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.images = shots.get();
    try {
      const next = await post("/api/trades/" + encodeURIComponent(trade.id) + "/close", data);
      closeModal();
      applyState(next);
      toast("Trade closed", trade.symbol + " · " + (data.pnl ? fmtSignedMoney(Number(data.pnl)) : "result recorded"));
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });
}

/* ----------------------------------------------------- screenshots + review */

const VERDICTS = { worked: "Worked", failed: "Didn't work", mixed: "Mixed" };

function verdictTag(t) {
  return t.verdict && VERDICTS[t.verdict] ? '<span class="verdict-tag v-' + t.verdict + '">' + VERDICTS[t.verdict] + "</span>" : "";
}

/** Address of a stored screenshot; the login token rides along because <img> cannot send headers. */
function imageUrl(id) {
  const key = deskKey();
  return "/api/images/" + encodeURIComponent(id) + (key ? "?key=" + encodeURIComponent(key) : "");
}

function shotsField() {
  return '<div class="form-block shots">' +
    '<div class="form-block-head"><h3>Screenshots</h3><p>Your chart at entry and at the exit. Add up to 8' +
      (matchMedia("(pointer: fine)").matches ? ", or paste one with Ctrl+V." : ".") + "</p></div>" +
    '<div class="shot-list"></div>' +
    (feat("screenshots") ? "" : '<p class="field-note">Adding screenshots is switched off for now.</p>') +
    '<label class="shot-add">' + icon("camera") + "<span>Add screenshot</span>" +
      '<input type="file" accept="image/*" multiple aria-label="Add screenshots"></label>' +
  "</div>";
}

function reviewFields(t) {
  const radio = function (name, value, label, current) {
    return '<label class="' + name + "-" + value + '"><input type="radio" name="' + name + '" value="' + value + '"' +
      (current === value ? " checked" : "") + "><span>" + label + "</span></label>";
  };
  return '<div class="form-block">' +
    '<div class="form-block-head"><h3>Review</h3><p>Write it while it is fresh. This is what turns the journal into better trades.</p></div>' +
    '<div class="form-grid">' +
      '<div class="field"><span class="field-label">How did it go?</span><div class="segmented review-seg" role="radiogroup" aria-label="How did it go">' +
        radio("verdict", "worked", "Worked", t.verdict) + radio("verdict", "failed", "Didn't work", t.verdict) + radio("verdict", "mixed", "Mixed", t.verdict) +
      "</div></div>" +
      '<div class="field"><span class="field-label">Did you follow your plan?</span><div class="segmented review-seg" role="radiogroup" aria-label="Did you follow your plan">' +
        radio("followedPlan", "yes", "Yes", t.followedPlan) + radio("followedPlan", "no", "No", t.followedPlan) +
      "</div></div>" +
    "</div>" +
    '<label class="field" style="margin-top:12px"><span>Why it worked, or why it didn\'t</span><textarea name="why" placeholder="e.g. Waited for the London sweep and the retest held. Or: entered before confirmation and got stopped by the spike.">' + esc(t.why || "") + "</textarea></label>" +
    '<label class="field" style="margin-top:12px"><span>Lesson for next time</span><textarea name="lesson" rows="2" placeholder="One thing to repeat or avoid">' + esc(t.lesson || "") + "</textarea></label>" +
  "</div>";
}

/** Shrink a photo or screenshot in the browser before upload (max 1800px, JPEG). */
function compressImage(file) {
  return new Promise(function (resolve, reject) {
    if (!file || !/^image\//.test(file.type || "image/")) return reject(new Error("That file is not an image."));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      let quality = 0.86;
      let out = canvas.toDataURL("image/jpeg", quality);
      while (out.length > 3.5e6 && quality > 0.4) {
        quality -= 0.15;
        out = canvas.toDataURL("image/jpeg", quality);
      }
      resolve(out);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image. Try a JPG or PNG screenshot."));
    };
    img.src = url;
  });
}

/** Wire the screenshot picker inside a form; returns the current list. */
function attachShots(form, initial) {
  const box = form.querySelector(".shots");
  const list = box.querySelector(".shot-list");
  const add = box.querySelector(".shot-add");
  const shots = (initial || []).map(s => ({ id: s.id, caption: s.caption || "" }));
  let pending = 0;

  const render = function () {
    list.innerHTML = shots.map(function (s, i) {
      return '<figure class="shot">' +
        '<button type="button" class="shot-img" data-shot-view="' + i + '" aria-label="View screenshot"><img src="' + imageUrl(s.id) + '" alt="" loading="lazy"></button>' +
        '<input class="shot-cap" data-shot-cap="' + i + '" value="' + esc(s.caption) + '" placeholder="Caption, e.g. Entry 15m" maxlength="120" aria-label="Screenshot caption">' +
        '<button type="button" class="shot-del" data-shot-del="' + i + '" aria-label="Remove screenshot">' + icon("close") + "</button>" +
      "</figure>";
    }).join("") + Array.from({ length: pending }, () => '<div class="shot shot-loading"><span>Uploading…</span></div>').join("");
    add.hidden = !feat("screenshots") || shots.length + pending >= 8;
  };

  const addFiles = async function (files) {
    const room = Math.max(0, 8 - shots.length - pending);
    const picked = Array.from(files || []).filter(f => /^image\//.test(f.type || "")).slice(0, room);
    if (!picked.length && files && files.length) toast("Not an image", "Choose a JPG, PNG or screenshot.", "error");
    await Promise.all(picked.map(async function (file) {
      pending++;
      render();
      try {
        const data = await compressImage(file);
        const res = await post("/api/images", { data });
        shots.push({ id: res.id, caption: "" });
      } catch (err) {
        toast("Could not add screenshot", err.message, "error");
      } finally {
        pending--;
        render();
      }
    }));
  };

  box.addEventListener("change", function (e) {
    if (e.target.type === "file") {
      addFiles(e.target.files);
      e.target.value = "";
    }
  });
  box.addEventListener("input", function (e) {
    const i = e.target.dataset && e.target.dataset.shotCap;
    if (i !== undefined && shots[i]) shots[i].caption = e.target.value;
  });
  box.addEventListener("click", function (e) {
    const del = e.target.closest("[data-shot-del]");
    if (del) { shots.splice(Number(del.dataset.shotDel), 1); render(); return; }
    const view = e.target.closest("[data-shot-view]");
    if (view) { const s = shots[Number(view.dataset.shotView)]; if (s) openLightbox(s.id, s.caption); }
  });
  form.addEventListener("paste", function (e) {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  render();
  return { get: () => shots.slice(), busy: () => pending > 0 };
}

function openLightbox(id, caption) {
  const box = document.getElementById("lightbox");
  document.getElementById("lightboxImg").src = imageUrl(id);
  const cap = document.getElementById("lightboxCap");
  cap.textContent = caption || "";
  cap.hidden = !caption;
  if (!box.open) box.showModal();
}
document.getElementById("lightbox").addEventListener("click", function () {
  const box = document.getElementById("lightbox");
  box.close();
  document.getElementById("lightboxImg").removeAttribute("src");
});

/* ------------------------------------------------- paste / upload a setup */

/** Free text reader for screenshots of written signals (loaded on first use). */
let ocrLoader = null;
function loadOCR() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!ocrLoader) {
    ocrLoader = new Promise(function (resolve, reject) {
      const tag = document.createElement("script");
      tag.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
      tag.async = true;
      tag.onload = function () { window.Tesseract ? resolve(window.Tesseract) : reject(new Error("The text reader did not load.")); };
      tag.onerror = function () { ocrLoader = null; reject(new Error("Could not load the text reader. Check your connection.")); };
      document.head.appendChild(tag);
    });
  }
  return ocrLoader;
}
async function readTextFromImage(dataUrl, onProgress) {
  const T = await loadOCR();
  const result = await T.recognize(dataUrl, "eng", {
    logger: function (m) {
      if (m && m.status === "recognizing text" && onProgress) onProgress(Math.round((m.progress || 0) * 100));
    }
  });
  return (result && result.data && result.data.text) || "";
}

function importCard(s, i) {
  const dir = s.direction === "short" ? "short" : "long";
  const val = function (v) { return v === null || v === undefined ? "" : esc(v); };
  const issues = []
    .concat((s.missing || []).map(function (m) { return "Missing " + m + " — fill it in."; }))
    .concat(s.directionGuessed && (s.missing || []).indexOf("direction") < 0 ? ["Direction guessed — check it."] : [])
    .concat(s.warnings || []);
  return '<div class="import-card" data-i="' + i + '">' +
    '<label class="import-keep"><input type="checkbox" name="keep-' + i + '" checked> <span>Watch this setup</span></label>' +
    '<div class="form-grid">' +
      '<div class="field"><span class="field-label">Pair</span>' + pickerField('<input name="symbol-' + i + '" data-picker="all" value="' + val(s.symbol) + '" placeholder="Tap to pick" autocomplete="off" aria-label="Pair">') + "</div>" +
      '<div class="field"><span style="font-size:12.5px;font-weight:600;color:var(--muted)">Direction</span>' +
        '<div class="segmented" role="radiogroup" aria-label="Direction" style="margin-top:6px">' +
          '<label class="long"><input type="radio" name="direction-' + i + '" value="long"' + (dir === "long" ? " checked" : "") + "><span>▲ Long</span></label>" +
          '<label class="short"><input type="radio" name="direction-' + i + '" value="short"' + (dir === "short" ? " checked" : "") + "><span>▼ Short</span></label>" +
        "</div></div>" +
      '<label class="field"><span>Entry</span><input name="entry-' + i + '" type="number" step="any" inputmode="decimal" value="' + val(s.entry) + '"></label>' +
      '<label class="field"><span>Stop</span><input name="stop-' + i + '" type="number" step="any" inputmode="decimal" value="' + val(s.stop) + '"></label>' +
      '<label class="field"><span>Target</span><input name="target-' + i + '" type="number" step="any" inputmode="decimal" value="' + val(s.target) + '"></label>' +
      '<label class="field"><span>Alert distance <em>pips / pts</em></span><input name="threshold-' + i + '" type="number" min="1" step="1" value="' + esc(state.settings.defaultThresholdPips) + '"></label>' +
      '<label class="field full"><span>Label</span><input name="label-' + i + '" value="' + val(s.label) + '" placeholder="e.g. London sweep of Asian low"></label>' +
    "</div>" +
    (issues.length ? '<div class="import-issues">' + issues.map(function (x) { return "<div>" + esc(x) + "</div>"; }).join("") + "</div>" : "") +
    (s.note ? '<div class="import-note">' + esc(s.note) + "</div>" : "") +
  "</div>";
}

function openImportForm() {
  let shot = null;     // compressed screenshot (data URL)
  let found = [];      // setups read so far
  openModal(
    modalHeader("Paste or upload a setup",
      "Paste a signal or add a screenshot. Tradera reads the pair, entry, stop and target, you check them, and it starts watching.") +
    '<form id="importForm" novalidate>' +
      '<label class="field"><span>Signal text</span><textarea name="text" rows="5" placeholder="e.g. XAUUSD BUY LIMIT 2345  SL 2338  TP1 2352  TP2 2360&#10;&#10;You can paste several setups at once, or paste a screenshot here."></textarea></label>' +
      '<div class="import-shot">' +
        '<label class="btn ghost import-upload">' + icon("plus") + '<span>Add screenshot</span><input type="file" name="shot" accept="image/*" hidden></label>' +
        '<div class="import-thumb" id="importThumb" hidden></div>' +
        '<p class="import-hint">' + (state.readerAI && state.plan === "free"
          ? "Screenshots of written signals are read for free. Reading chart pictures with AI is part of Tradera Pro."
          : state.readerAI
          ? "Chart screenshots are read by AI. Screenshots of written signals work too."
          : "Screenshots of written signals (Telegram, WhatsApp…) are read on this device. Charts with only drawn lines need the AI chart reader switched on.") + "</p>" +
      "</div>" +
      '<div class="import-status" id="importStatus" hidden></div>' +
      formError() +
      '<div class="form-actions"><button class="btn" type="button" data-close>Cancel</button>' +
        '<button class="btn primary" type="submit" id="importRead">Read setup</button></div>' +
      '<div id="importResults"></div>' +
    "</form>"
  );
  const form = document.getElementById("importForm");
  const statusEl = document.getElementById("importStatus");
  const errEl = document.getElementById("formError");
  const readBtn = document.getElementById("importRead");
  const results = document.getElementById("importResults");
  const say = function (text) { statusEl.hidden = !text; statusEl.textContent = text || ""; };
  const fail = function (text) { errEl.textContent = text || ""; errEl.hidden = !text; };

  const showResults = function (list, problem, via) {
    found = list || [];
    if (!found.length) {
      results.innerHTML = "";
      fail(problem || "No setup found. Check the text, or type the setup in with New setup.");
      return;
    }
    fail("");
    results.innerHTML =
      '<div class="import-head"><b>' + found.length + (found.length === 1 ? " setup" : " setups") + " found</b>" +
        "<span>" + (via === "ai" ? "Read by AI from the chart" : via === "ocr" ? "Read from the screenshot text" : "Read from your text") + " · check the numbers</span></div>" +
      found.map(importCard).join("") +
      '<div class="form-actions"><button class="btn primary" type="button" id="importWatch">' + icon("bell") + "Start watching</button></div>";
    document.getElementById("importWatch").addEventListener("click", watch);
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const readText = async function (text, via, emptyNote) {
    const out = await post("/api/setups/read", { text: text });
    const list = out.setups || [];
    showResults(list, list.length ? null : (emptyNote || out.problem), via || "text");
    return list.length;
  };

  const readShot = async function () {
    // Why the AI didn't read this picture, so the user isn't left guessing.
    let why = "";
    if (!state.readerAI) why = "Reading prices from chart pictures needs the AI chart reader, which isn't switched on for this site.";
    else if (!feat("aiChartReader")) why = "AI chart reading is switched off for now.";
    else if (state.plan === "free") why = "Reading prices from chart pictures is part of Tradera Pro. On the free plan only written signals in screenshots are read.";

    if (!why) {
      say("Reading the chart with AI… this can take up to 30 seconds.");
      try {
        const out = await post("/api/setups/read", { image: shot });
        if (out.setups && out.setups.length) { showResults(out.setups, null, "ai"); return; }
        why = "The AI couldn't find a setup on this chart" + (out.problem ? ": " + out.problem : ".");
      } catch (error) {
        why = "The AI chart reader failed: " + error.message;
      }
      say(why + " Reading any written text instead…");
    } else {
      say("Reading the screenshot text…");
    }
    const text = await readTextFromImage(shot, function (pct) { say("Reading the screenshot text… " + pct + "%"); });
    const tail = " You can also paste or type the setup.";
    if (!text.trim()) throw new Error(why ? why + tail : "No text found in that screenshot." + tail);
    form.elements.text.value = text.trim();
    await readText(text, "ocr", (why ? why + " " : "") + "No prices were found in the screenshot's text." + tail);
  };

  const run = async function () {
    fail("");
    readBtn.disabled = true;
    try {
      const text = form.elements.text.value.trim();
      if (shot && !text) await readShot();
      else if (text) await readText(text, "text");
      else fail("Paste a signal or add a screenshot first.");
    } catch (error) {
      fail(error.message);
    } finally {
      say("");
      readBtn.disabled = false;
    }
  };

  const useImage = async function (file) {
    fail("");
    try {
      shot = await compressImage(file);
      const thumb = document.getElementById("importThumb");
      thumb.hidden = false;
      thumb.innerHTML = '<img alt="Setup screenshot" src="' + shot + '"><button type="button" class="icon-btn" aria-label="Remove screenshot">' + icon("close") + "</button>";
      thumb.querySelector("button").addEventListener("click", function () { shot = null; thumb.hidden = true; thumb.innerHTML = ""; });
      form.elements.text.value = "";
      await run();
    } catch (error) {
      fail(error.message);
    }
  };

  form.elements.shot.addEventListener("change", function () {
    if (this.files && this.files[0]) useImage(this.files[0]);
    this.value = "";
  });
  form.elements.text.addEventListener("paste", function (e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (let k = 0; k < items.length; k++) {
      if (items[k].kind === "file" && /^image\//.test(items[k].type)) {
        e.preventDefault();
        useImage(items[k].getAsFile());
        return;
      }
    }
  });
  form.addEventListener("submit", function (e) { e.preventDefault(); run(); });
  setTimeout(function () { form.elements.text.focus(); }, 50);

  async function watch() {
    fail("");
    const list = [];
    const f = form.elements;
    for (let i = 0; i < found.length; i++) {
      if (!f["keep-" + i].checked) continue;
      const symbol = String(f["symbol-" + i].value || "").toUpperCase().replace(/\s+/g, "");
      const entry = n(f["entry-" + i].value);
      if (!symbol) return fail("Setup " + (i + 1) + ": pick the pair.");
      if (entry === null || entry <= 0) return fail("Setup " + (i + 1) + ": enter the entry price.");
      const dirEl = form.querySelector('input[name="direction-' + i + '"]:checked');
      list.push({
        symbol: symbol,
        direction: dirEl ? dirEl.value : "long",
        entry: entry,
        stop: f["stop-" + i].value,
        target: f["target-" + i].value,
        thresholdPips: f["threshold-" + i].value,
        label: f["label-" + i].value,
        note: [found[i].note, found[i].source ? "Pasted: " + found[i].source : ""].filter(Boolean).join("\n"),
        priority: "medium"
      });
    }
    if (!list.length) return fail("Tick at least one setup to watch.");
    const btn = document.getElementById("importWatch");
    btn.disabled = true;
    try {
      const next = await post("/api/setups/batch", { setups: list });
      closeModal();
      applyState(next);
      toast(list.length === 1 ? "Setup added" : list.length + " setups added",
        list.map(function (x) { return symLabel(x.symbol) + " " + (x.direction === "short" ? "sell" : "buy") + " " + fmtPrice(x.symbol, x.entry); }).join(" · ") + ". You'll get an alert when price comes close.");
    } catch (error) {
      fail(error.message);
      btn.disabled = false;
    }
  }
}

/* --------------------------------------------------------------- setup form */

function openSetupForm(setup) {
  const s = setup || {};
  const isEdit = !!setup;
  openModal(
    modalHeader(isEdit ? "Edit setup" : "New setup",
      "Tradera alerts you when price gets within your alert distance of the entry.") +
    '<form id="setupForm">' +
      '<input type="hidden" name="id" value="' + esc(s.id || "") + '">' +
      '<div class="form-grid">' +
        '<div class="field"><span class="field-label">Pair</span>' + pickerField('<input name="symbol" data-picker="all" value="' + esc(s.symbol || "") + '" placeholder="Tap to pick" required autocomplete="off" aria-label="Pair">') + "</div>" +
        directionField(s.direction) +
        '<label class="field"><span>Entry</span><input name="entry" type="number" step="any" value="' + esc(s.entry !== undefined ? s.entry : "") + '" required></label>' +
        '<label class="field"><span>Stop</span><input name="stop" type="number" step="any" value="' + esc(s.stop !== undefined && s.stop !== null ? s.stop : "") + '"></label>' +
        '<label class="field"><span>Target</span><input name="target" type="number" step="any" value="' + esc(s.target !== undefined && s.target !== null ? s.target : "") + '"></label>' +
        '<label class="field"><span>Priority</span><select name="priority">' +
          ["high", "medium", "low"].map(v => '<option value="' + v + '"' + ((s.priority || "medium") === v ? " selected" : "") + ">" + v[0].toUpperCase() + v.slice(1) + "</option>").join("") +
        "</select></label>" +
        '<label class="field"><span>Alert distance <em>pips / pts</em></span><input name="thresholdPips" type="number" min="1" step="1" value="' + esc(s.thresholdPips !== undefined ? s.thresholdPips : state.settings.defaultThresholdPips) + '"></label>' +
        '<label class="field"><span>Status</span><select name="status">' +
          [["watching", "Watching"], ["triggered", "Triggered"], ["invalidated", "Invalidated"], ["done", "Done"]].map(function (row) {
            return '<option value="' + row[0] + '"' + ((s.status || "watching") === row[0] ? " selected" : "") + ">" + row[1] + "</option>";
          }).join("") +
        "</select></label>" +
        '<label class="field full"><span>Label <em>optional</em></span><input name="label" value="' + esc(s.label || "") + '" placeholder="e.g. London sweep of Asian low"></label>' +
      "</div>" +
      '<label class="field" style="margin-top:12px"><span>Notes</span><textarea name="note" placeholder="Why this level, what confirms it, what cancels it">' + esc(s.note || "") + "</textarea></label>" +
      '<div class="preview-box" id="setupPreview"></div>' +
      formError() +
      '<div class="form-actions"><button class="btn" type="button" data-close>Cancel</button>' +
        '<button class="btn primary" type="submit">' + (isEdit ? "Save setup" : "Start watching") + "</button></div>" +
    "</form>"
  );
  const form = document.getElementById("setupForm");
  const update = function () {
    const entry = n(form.elements.entry.value);
    const stop = n(form.elements.stop.value);
    const target = n(form.elements.target.value);
    const symbol = (form.elements.symbol.value || "").toUpperCase();
    const dir = form.elements.direction.value;
    const quote = quoteOf(symbol);
    let rr = null;
    if (entry !== null && stop !== null && target !== null && Math.abs(entry - stop)) {
      rr = (dir === "short" ? entry - target : target - entry) / Math.abs(entry - stop);
    }
    const dist = quote && entry !== null ? Math.abs(quote.price - entry) / pipSize(symbol || "EURUSD") : null;
    document.getElementById("setupPreview").innerHTML =
      "<span>R:R <b>" + (rr === null ? "—" : rrText(rr)) + "</b></span>" +
      "<span>Risk <b>" + (entry !== null && stop !== null ? fmtNum(Math.abs(entry - stop) / pipSize(symbol || "EURUSD"), 1) + " " + unitName(symbol || "EURUSD") : "—") + "</b></span>" +
      "<span>Live <b>" + (quote ? fmtPrice(symbol, quote.price) : "—") + "</b></span>" +
      "<span>Distance <b>" + (dist === null ? "—" : fmtNum(dist, 1) + " " + unitName(symbol || "EURUSD")) + "</b></span>";
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);
  update();
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    const err = document.getElementById("formError");
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.symbol) data.symbol = String(data.symbol).toUpperCase().replace(/\s+/g, "");
    try {
      const next = await post("/api/setups", data);
      closeModal();
      applyState(next);
      toast(isEdit ? "Setup updated" : "Setup added", data.symbol + " · alerts at " + data.thresholdPips + " " + unitName(data.symbol));
    } catch (error) {
      err.textContent = error.message;
      err.hidden = false;
    }
  });
}

/* ------------------------------------------------------------------- chart */

function tvSymbol(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s === "XAUUSD") return "OANDA:XAUUSD";
  if (s === "XAGUSD") return "OANDA:XAGUSD";
  if (s === "GOLD") return "OANDA:XAUUSD";
  if (s === "SILVER") return "OANDA:XAGUSD";
  if (s === "BTCUSD") return "COINBASE:BTCUSD";
  if (s === "ETHUSD") return "COINBASE:ETHUSD";
  if (s === "US30") return "DJ:DJI";
  if (s === "NAS100") return "NASDAQ:NDX";
  if (s === "SPX500") return "SP:SPX";
  if (/^[A-Z]{6}$/.test(s)) return "FX:" + s;
  return s;
}

function openChart(symbol) {
  const q = quoteOf(symbol);
  if (synthetic(symbol)) {
    openModal(
      modalHeader(symLabel(symbol), q ? fmtPrice(symbol, q.price) + " now" : synthetic(symbol).name) +
      '<div class="notice"><span class="n-ico">ⓘ</span><div><b>' + esc(synthetic(symbol).name) + " is a Deriv synthetic.</b> " +
        "TradingView does not chart it. Open it in Deriv Trader or your Deriv MT5 terminal to see the chart; Tradera keeps watching the price for your alerts.</div></div>"
    );
    return;
  }
  openModal(
    modalHeader(symbol, q ? fmtPrice(symbol, q.price) + (q.changePct !== null && q.changePct !== undefined
      ? ", " + (q.changePct > 0 ? "+" : "") + fmtNum(q.changePct, 2) + "% today" : "") : "Live chart") +
    '<div class="tv-chart" id="tvChart"></div>' +
    '<div class="preview-box" style="margin-top:12px"><span>Chart by TradingView</span>' +
      '<a href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(symbol) + '" target="_blank" rel="noopener">Open on TradingView</a></div>'
  );
  const container = document.getElementById("tvChart");
  if (!container) return;
  const wrapper = document.createElement("div");
  wrapper.className = "tradingview-widget-container";
  wrapper.style.height = "100%";
  const widget = document.createElement("div");
  widget.className = "tradingview-widget-container__widget";
  widget.style.height = "100%";
  wrapper.appendChild(widget);
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.async = true;
  script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
  script.text = JSON.stringify({
    symbol: tvSymbol(symbol),
    interval: "60",
    timezone: "Etc/UTC",
    theme: currentTheme(),
    style: "1",
    locale: "en",
    autosize: true,
    hide_side_toolbar: true,
    allow_symbol_change: true,
    details: false,
    backgroundColor: currentTheme() === "dark" ? "#10141B" : "#FFFFFF",
    gridColor: currentTheme() === "dark" ? "rgba(255,255,255,0.05)" : "rgba(16,24,40,0.06)"
  });
  wrapper.appendChild(script);
  container.appendChild(wrapper);
}

/* ------------------------------------------------------------ market picker */

function pickerField(inputHtml) {
  return '<div class="picker">' + inputHtml + '<div class="picker-list" role="listbox" hidden></div></div>';
}

/** Markets offered by a picker: your own first, then the full catalog by group. */
function pickerGroups(mode) {
  const mine = state.pairs.map(p => p.symbol);
  const groups = [];
  if (mine.length) groups.push({ name: "Your markets", symbols: mine });
  MARKET_GROUPS.forEach(g => {
    const rest = g.symbols.filter(sym => !mine.includes(sym));
    if (rest.length) groups.push({ name: g.name, symbols: rest });
  });
  return groups;
}

function pickerSubtitle(sym) {
  const syn = synthetic(sym);
  if (syn) return syn.name + " · " + sym;
  const group = marketGroup(sym);
  return group ? group.name.replace(/s$/, "") : pairKind(sym);
}

const picker = { input: null, active: -1 };

function renderPicker(input) {
  const list = input.parentElement.querySelector(".picker-list");
  if (!list) return;
  const q = String(input.value || "").trim().toUpperCase().replace(/\s+/g, "");
  const match = sym => !q || sym.includes(q) || symLabel(sym).toUpperCase().replace(/\s+/g, "").includes(q) ||
    pickerSubtitle(sym).toUpperCase().replace(/\s+/g, "").includes(q);
  const groups = pickerGroups(input.dataset.picker)
    .map(g => ({ name: g.name, symbols: g.symbols.filter(match) }))
    .filter(g => g.symbols.length);
  let i = 0;
  let html = groups.map(g =>
    '<div class="picker-group">' + esc(g.name) + "</div>" +
    g.symbols.map(sym => {
      const q2 = quoteOf(sym);
      return '<button type="button" class="picker-opt' + (i === picker.active ? " active" : "") + '" role="option" data-pick="' + esc(sym) + '" data-index="' + (i++) + '">' +
        '<span class="po-main"><b>' + esc(symLabel(sym)) + "</b><small>" + esc(pickerSubtitle(sym)) + "</small></span>" +
        (q2 && q2.price !== null && q2.price !== undefined ? '<span class="po-price">' + fmtPrice(sym, q2.price) + "</span>" : "") +
      "</button>";
    }).join("")).join("");
  if (!i) html = '<div class="picker-empty">' + (q ? "No market called " + esc(q) + ". You can still use it if your feed carries it." : "No markets yet.") + "</div>";
  list.innerHTML = html;
  list.hidden = false;
  picker.count = i;
}

function openPicker(input) {
  if (picker.input && picker.input !== input) closePicker();
  picker.input = input;
  picker.active = -1;
  input.setAttribute("aria-expanded", "true");
  renderPicker(input);
}

function closePicker() {
  if (!picker.input) return;
  const list = picker.input.parentElement.querySelector(".picker-list");
  if (list) { list.hidden = true; list.innerHTML = ""; }
  picker.input.setAttribute("aria-expanded", "false");
  picker.input = null;
}

function choosePick(sym) {
  const input = picker.input;
  if (!input) return;
  input.value = sym;
  closePicker();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

document.addEventListener("focusin", function (e) {
  const input = e.target.closest && e.target.closest("input[data-picker]");
  if (input) openPicker(input);
  else if (picker.input && !e.target.closest(".picker")) closePicker();
});
document.addEventListener("input", function (e) {
  if (e.target.matches && e.target.matches("input[data-picker]") && picker.input === e.target) {
    picker.active = -1;
    renderPicker(e.target);
  }
});
document.addEventListener("keydown", function (e) {
  if (!picker.input || e.target !== picker.input) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePicker(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!picker.count) return;
    picker.active = (picker.active + (e.key === "ArrowDown" ? 1 : -1) + picker.count) % picker.count;
    renderPicker(picker.input);
    const el = picker.input.parentElement.querySelector(".picker-opt.active");
    if (el) el.scrollIntoView({ block: "nearest" });
    return;
  }
  if (e.key === "Enter" && picker.active >= 0) {
    const el = picker.input.parentElement.querySelector('.picker-opt[data-index="' + picker.active + '"]');
    if (el) { e.preventDefault(); choosePick(el.dataset.pick); }
  }
  if (e.key === "Tab") closePicker();
}, true);
/* Keep focus in the input while tapping the list, so it does not close first. */
document.addEventListener("pointerdown", function (e) {
  if (e.target.closest(".picker-list")) e.preventDefault();
  else if (picker.input && !e.target.closest(".picker")) closePicker();
});
document.addEventListener("click", function (e) {
  const opt = e.target.closest(".picker-opt");
  if (opt) { e.stopPropagation(); choosePick(opt.dataset.pick); return; }
  const input = e.target.closest("input[data-picker]");
  if (input && picker.input !== input) openPicker(input);
}, true);

/* ----------------------------------------------------------------- actions */

document.addEventListener("click", async function (e) {
  const close = e.target.closest("[data-close]");
  if (close) { closeModal(); return; }

  const navBtn = e.target.closest("[data-view]");
  if (navBtn && !e.target.closest("[data-action]")) {
    setView(navBtn.dataset.view);
    return;
  }

  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const symbol = el.dataset.symbol;

  try {
    if (action === "new-trade") return openTradeForm();
    if (action === "new-setup") return openSetupForm();
    if (action === "import-setup") return openImportForm();
    if (action === "edit-trade") {
      const trade = state.trades.find(t => t.id === id);
      if (trade) openTradeForm(trade);
      return;
    }
    if (action === "close-trade") {
      const trade = state.trades.find(t => t.id === id);
      if (trade) openCloseForm(trade);
      return;
    }
    if (action === "edit-setup") {
      const setup = state.setups.find(s => s.id === id);
      if (setup) openSetupForm(setup);
      return;
    }
    if (action === "trigger-setup") {
      const setup = state.setups.find(s => s.id === id);
      if (!setup) return;
      if (!(await confirmDialog("Mark this setup as triggered?",
        symLabel(setup.symbol) + " " + String(setup.direction).toUpperCase() + " at " + fmtPrice(setup.symbol, setup.entry) +
        " will stop being watched and move to Triggered. You can log the trade from there, or put it back on watch.", "Mark triggered"))) return;
      applyState(await post("/api/setups/" + encodeURIComponent(id) + "/status", { status: "triggered" }));
      toast("Setup triggered", "Tap Log trade on the card when you are in the position.");
      return;
    }
    if (action === "log-setup-trade") {
      const setup = state.setups.find(s => s.id === id);
      if (!setup) return;
      openTradeForm(null, setup);
      const form = document.getElementById("tradeForm");
      if (form && setup.entryHitAt && form.elements.openedAt) form.elements.openedAt.value = toLocalInput(setup.entryHitAt);
      if (form && setup.outcome && setup.outcome.result !== "missed") {
        const st = form.elements.status;
        st.value = "closed";
        st.dispatchEvent(new Event("change", { bubbles: true }));
        if (form.elements.exit) form.elements.exit.value = setup.outcome.price;
        if (form.elements.closedAt) form.elements.closedAt.value = toLocalInput(setup.outcome.at);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    if (action === "skip-setup-log") {
      applyState(await post("/api/setups/" + encodeURIComponent(id) + "/skip-log", {}));
      toast("Noted", "Marked as not taken. It stays under Finished.");
      return;
    }
    if (action === "delete-trade") {
      const trade = state.trades.find(t => t.id === id);
      if (!(await confirmDialog("Delete this trade?", (trade ? trade.symbol + " will be removed from your journal and stats. " : "") + "This cannot be undone."))) return;
      applyState(await api("/api/trades/" + encodeURIComponent(id), { method: "DELETE" }));
      toast("Trade deleted", "Your journal and stats are updated.");
      return;
    }
    if (action === "delete-setup") {
      if (!(await confirmDialog("Delete this setup?", "Tradera will stop watching it. This cannot be undone."))) return;
      applyState(await api("/api/setups/" + encodeURIComponent(id), { method: "DELETE" }));
      toast("Setup deleted", "Tradera stopped watching it.");
      return;
    }
    if (action === "set-setup-status") {
      applyState(await post("/api/setups/" + encodeURIComponent(id) + "/status", { status: el.dataset.status }));
      if (el.dataset.status === "invalidated") {
        const done = state.setups.find(s => s.id === id);
        if (done && unloggedSetup(done) && await confirmDialog("Did you take this trade?",
          "If you were in it, log it now so your journal and stats stay complete.", "Yes, log it")) {
          openTradeForm(null, done);
          return;
        }
      }
      toast(el.dataset.status === "watching" ? "Back on watch" : "Setup invalidated",
        el.dataset.status === "watching" ? "Tradera is watching this setup again." : "It moved to Finished. Reactivate it any time.");
      return;
    }
    if (action === "chart") return openChart(symbol);
    if (action === "export-json") return exportJSON();
    if (action === "lock-desk") {
      const accounts = !!(state && state.accounts);
      signOutLocally();
      showGate(accounts ? "account" : "password");
      return;
    }
    if (action === "delete-account") {
      const current = (document.getElementById("pwCurrent") || {}).value || "";
      if (!current) return toast("Enter your current password", "Type it in Current password, then press Delete account.", "error");
      if (!(await confirmDialog("Delete your account?", "Your journal, setups, alerts and settings will be deleted for good. Download a backup first if you might want them.", "Delete account"))) return;
      await post("/api/auth/delete", { current });
      signOutLocally();
      store("email", null);
      showGate("account");
      toast("Account deleted", "Your journal has been removed.");
      return;
    }
    if (action === "set-password") {
      const val = id => (document.getElementById(id) || {}).value || "";
      if (val("pwNew").length < 10) return toast("Password too short", "Use at least 10 characters.", "error");
      if (val("pwNew") !== val("pwRepeat")) return toast("Passwords don't match", "Type the same new password in both boxes.", "error");
      const had = state.passwordSet;
      const next = await post("/api/auth/password", { current: val("pwCurrent"), password: val("pwNew") });
      store("key", next.token);
      if (eventSource) connectSSE();
      applyState(next);
      toast(had ? "Password changed" : "Password set", had ? "Other devices have been logged out." : "Tradera will ask for it on every new device.");
      return;
    }
    if (action === "logout-all") {
      const next = await post("/api/auth/logout-all");
      store("key", next.token);
      if (eventSource) connectSSE();
      applyState(next);
      toast("Other devices logged out", "This device stays logged in.");
      return;
    }
    if (action === "disable-password") {
      const current = (document.getElementById("pwCurrent") || {}).value || "";
      if (!current) return toast("Enter your current password", "Type it in Current password, then press Turn off password.", "error");
      if (!(await confirmDialog("Turn off your password?", "Anyone who can open Tradera will be able to see and change your journal.", "Turn off"))) return;
      applyState(await post("/api/auth/disable", { current }));
      toast("Password turned off", "Tradera no longer asks for a login.");
      return;
    }
    if (action === "toggle-priority") {
      const pair = state.pairs.find(p => p.symbol === symbol);
      if (!pair) return;
      applyState(await patch("/api/pairs/" + encodeURIComponent(symbol), { priority: !pair.priority }));
      return;
    }
    if (action === "toggle-monitor") {
      const pair = state.pairs.find(p => p.symbol === symbol);
      if (!pair) return;
      applyState(await patch("/api/pairs/" + encodeURIComponent(symbol), { monitor: !pair.monitor }));
      return;
    }
    if (action === "remove-pair") {
      if (!(await confirmDialog("Remove " + symbol + "?", "Any setups for " + symbol + " are removed too. Your journal keeps its trades.", "Remove"))) return;
      applyState(await api("/api/pairs/" + encodeURIComponent(symbol), { method: "DELETE" }));
      toast("Market removed", symbol + " is off your watchlist.");
      return;
    }
    if (action === "test-reminder") {
      const next = await post("/api/reminders/test");
      applyState(next);
      const ok = (next.testResult || []).filter(c => c.ok).map(c => c.channel);
      toast("Reminder sent", ok.length ? "Delivered by " + ok.join(" and ") + "." : "Shown here. Set up ntfy or Telegram in Settings to get it on your phone.");
      return;
    }
    if (action === "feed-key" || action === "feed-key-rotate") {
      if (action === "feed-key-rotate" && !(await confirmDialog("Make new iPhone links?", "The calendar subscription and Shortcut link you set up stop working, and you will need to add the new ones.", "Make new links"))) return;
      applyState(await post("/api/reminders/feed-key", { rotate: action === "feed-key-rotate" }));
      toast(action === "feed-key" ? "iPhone links ready" : "New links made", "Follow the steps below on your iPhone.");
      return;
    }
    if (action === "copy-text") {
      const text = el.dataset.text || "";
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied", "Paste it on your iPhone.");
      } catch (_) {
        window.prompt("Copy this link:", text);
      }
      return;
    }
    if (action === "test-alert") {
      el.disabled = true;
      try {
        const result = await post("/api/test-alert");
        const ok = (result.results || []).filter(r => r.ok).map(r => r.channel);
        const failed = (result.results || []).filter(r => !r.ok);
        if (ok.length) toast("Test alert sent", "Delivered via " + ok.join(" and ") + ".");
        if (failed.length) toast("Some channels failed", failed.map(f => f.channel + ": " + f.error).join(" · "), "error");
        if (!result.results.length) toast("Nothing configured", "Add an ntfy topic or Telegram bot in Settings.", "error");
      } catch (err) {
        toast("Test failed", err.message, "error");
      } finally {
        el.disabled = false;
      }
      return;
    }
    if (action === "find-chat") {
      const tokenInput = document.querySelector('input[name="telegramToken"]');
      el.disabled = true;
      try {
        const next = await post("/api/telegram/find-chat", { token: tokenInput ? tokenInput.value : "" });
        const found = next.foundChat || {};
        applyState(next);
        toast("Chat ID found", "Alerts will go to " + (found.name || "your chat") + " (" + found.id + ").");
      } catch (err) {
        toast("Could not find your chat", err.message, "error");
      } finally {
        el.disabled = false;
      }
      return;
    }
    if (action === "test-call") {
      el.disabled = true;
      try {
        const result = await post("/api/test-call");
        const r = (result.results || [])[0] || {};
        if (r.ok) toast("Calling you now", "Pick up on Telegram. If nothing rings, check that you sent /start to @CallMeBot_txtbot.");
        else toast("Call failed", r.error || "CallMeBot did not accept the call.", "error");
      } catch (err) {
        toast("Call failed", err.message, "error");
      } finally {
        el.disabled = false;
      }
      return;
    }
    if (action === "enable-alerts") return askNotificationPermission();
    if (action === "push-on") return turnOnPush();
    if (action === "push-off") return turnOffPush();
    if (action === "push-test") {
      applyState(await post("/api/push/test", {}));
      toast("Test sent", "Check this device's notifications.");
      return;
    }
    if (action === "toggle-theme") {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : !matchMedia("(prefers-color-scheme: light)").matches;
      return setTheme(dark ? "light" : "dark");
    }
    if (action === "set-theme") return setTheme(el.value);
    if (action === "hide-checklist") {
      store("hideChecklist", "1");
      return renderView();
    }
    if (action === "clear-filters") {
      ui.journal = { q: "", status: "all", pair: "all" };
      return renderView();
    }
    if (action === "add-group") {
      const group = MARKET_GROUPS.find(g => g.id === el.dataset.group);
      if (!group) return;
      const next = await post("/api/pairs/bulk", { symbols: group.symbols });
      applyState(next);
      toast(group.name + " added", (next.added || 0) + " markets are now on your watchlist.");
      return;
    }
    if (action === "quick-pair") {
      applyState(await post("/api/pairs", { symbol: symbol, priority: false, monitor: true }));
      toast("Market added", symbol + " is now on your watchlist.");
      return;
    }
    if (action === "gen-topic") {
      const chars = "abcdefghijkmnpqrstuvwxyz23456789";
      let topic = "tradera-";
      for (let i = 0; i < 12; i++) topic += chars[Math.floor(Math.random() * chars.length)];
      const input = document.getElementById("ntfyTopic");
      if (input) input.value = topic;
      toast("Topic generated", "Save settings, then subscribe to this topic in the ntfy app.");
      return;
    }
  } catch (err) {
    toast("Something went wrong", err.message, "error");
  }
});

/* -------------------------------------------------------------------- misc */

async function exportJSON() {
  try {
    const res = await fetch("/api/export", { headers: authHeaders(), cache: "no-store" });
    if (res.status === 401) { showGate(); return; }
    if (!res.ok) throw new Error("Export failed (" + res.status + ")");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tradera-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast("Backup downloaded", "Your journal and settings were exported as JSON.");
  } catch (err) {
    toast("Export failed", err.message, "error");
  }
}

function setView(view) {
  if (!VIEW_META[view]) view = "dashboard";
  ui.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
  renderChrome();
  renderView();
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ------------------------------------------------ Tradera notifications */

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isInstalled = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
ui.pushHere = false;

function base64ToBytes(b64) {
  const s = (b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function deviceIdOf(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = isIOS ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 && !/iPhone/.test(ua) ? "iPad" : "iPhone")
    : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Computer";
  const app = isInstalled() ? "app" : /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return os + " (" + app + ")";
}

/** Is this device signed up, and does the server know it? Re-sends a rotated address. */
async function syncPushState() {
  ui.pushHere = false;
  if (!pushSupported() || !state || !state.push || !state.push.available) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || Notification.permission !== "granted") return;
    const id = await deviceIdOf(sub.endpoint);
    const known = (state.push.devices || []).some(d => d.id === id);
    if (!known) applyState(await post("/api/push/subscribe", { subscription: sub.toJSON(), label: deviceLabel() }));
    ui.pushHere = true;
  } catch (_) { /* leave it off */ }
}

async function turnOnPush() {
  if (!state.push || !state.push.available) return toast("Not available yet", "Tradera notifications aren't switched on for this site.", "error");
  if (isIOS && !isInstalled()) {
    return toast("Add Tradera to your Home Screen first", "In Safari tap Share → Add to Home Screen, open Tradera from the new icon, then turn notifications on from Alerts.", "error", 12000);
  }
  if (!pushSupported()) return toast("Not supported here", "This browser can't receive notifications. Try Chrome, Edge, Firefox or the iPhone home-screen app.", "error");
  if (Notification.permission === "denied") {
    return toast("Notifications are blocked", isIOS ? "Open iPhone Settings → Notifications → Tradera and allow notifications." : "Allow notifications for this site in your browser's site settings, then try again.", "error", 10000);
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return toast("Notifications not turned on", "You can turn them on later from Alerts.", "error");
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(state.push.publicKey) });
    applyState(await post("/api/push/subscribe", { subscription: sub.toJSON(), label: deviceLabel() }));
    ui.pushHere = true;
    if (ui.view === "alerts") renderView();
    const r = await post("/api/push/test", {});
    applyState(r);
    toast("Notifications on", "Tradera sent a test notification to this device.");
  } catch (err) {
    toast("Couldn't turn on notifications", err.message, "error");
  }
}

async function turnOffPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).then(applyState);
      await sub.unsubscribe();
    }
  } catch (_) { /* already off */ }
  ui.pushHere = false;
  if (ui.view === "alerts") renderView();
  toast("Notifications off", "This device won't get Tradera notifications.");
}

function pushCard() {
  const p = state.push || {};
  if (!p.available) return "";
  const devices = p.devices || [];
  const here = ui.pushHere;
  let text, button;
  if (here) {
    text = "On for this device" + (devices.length > 1 ? " and " + plural(devices.length - 1, "other device") : "") + ". Alerts arrive as phone notifications, even with Tradera closed.";
    button = '<button class="btn ghost small" data-action="push-test">Send test</button><button class="btn ghost small" data-action="push-off">Turn off here</button>';
  } else if (isIOS && !isInstalled()) {
    text = "On iPhone, add Tradera to your Home Screen first: tap Share → Add to Home Screen, open Tradera from the new icon, then come back here.";
    button = "";
  } else if (!pushSupported()) {
    text = "This browser can't receive notifications. Use Chrome, Edge, Firefox or the iPhone home-screen app.";
    button = "";
  } else {
    text = "Get entry alerts, setup results and chart reminders as notifications from Tradera itself. No extra app needed." +
      (devices.length ? " Already on for " + plural(devices.length, "device") + "." : "");
    button = '<button class="btn primary small" data-action="push-on">Turn on notifications</button>';
  }
  const on = here || devices.length > 0;
  return '<div class="channel ' + (on ? "on" : "") + '"><div class="channel-top"><strong>Tradera notifications</strong>' +
    '<span class="state-dot ' + (here ? "on" : "off") + '">' + (here ? "On" : "Off") + "</span></div>" +
    "<p>" + esc(text) + "</p><div class=\"toolbar\" style=\"margin:0\">" + button + "</div></div>";
}

function askNotificationPermission() {
  if (!("Notification" in window)) {
    toast("Not supported", "This browser can't show notifications. Use ntfy or Telegram instead.", "error");
    return;
  }
  if (Notification.permission === "denied") {
    toast("Notifications blocked", "Allow notifications for this page in your browser's site settings, then reload.", "error");
    return;
  }
  Notification.requestPermission().then(function (permission) {
    if (permission === "granted") {
      ui.browserAlerts = true;
      store("browserAlerts", "1");
      updateNotifyButton();
      renderChrome();
      if (ui.view === "alerts") renderView();
      toast("Browser alerts on", "You'll get a notification here when price nears an entry.");
      try {
        new Notification("Tradera alerts are on", { body: "You will hear from us here when price nears an entry." });
      } catch (_) { /* ignore */ }
    } else {
      if (ui.view === "alerts") renderView();
      toast("Alerts not enabled", "You can enable browser notifications later from Alerts.", "error");
    }
  });
}

document.getElementById("notifyBtn").addEventListener("click", askNotificationPermission);

modal.addEventListener("click", function (e) {
  if (e.target === modal) closeModal();
});
modal.addEventListener("close", function () {
  modalBody.innerHTML = "";
});

window.addEventListener("hashchange", function () {
  const view = location.hash.slice(1);
  if (VIEW_META[view] && view !== ui.view) setView(view);
});

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function setTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
    store("theme", theme);
  } else {
    delete document.documentElement.dataset.theme;
    store("theme", null);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = currentTheme() === "light" ? "#EAF0F8" : "#070B14";
  if (ui.view === "dashboard") renderView();
}

/* Forex sessions in each centre's local time, so daylight saving is handled. */
const SESSIONS = [
  { name: "Sydney", tz: "Australia/Sydney", open: 7, close: 16 },
  { name: "Tokyo", tz: "Asia/Tokyo", open: 9, close: 18 },
  { name: "London", tz: "Europe/London", open: 8, close: 17 },
  { name: "New York", tz: "America/New_York", open: 8, close: 17 }
];

function sessionOpen(session, now) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: session.tz, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
    const day = parts.find(p => p.type === "weekday").value;
    const hour = Number(parts.find(p => p.type === "hour").value);
    return day !== "Sat" && day !== "Sun" && hour >= session.open && hour < session.close;
  } catch (_) {
    return false;
  }
}

function renderSessions() {
  const el = document.getElementById("sessions");
  if (!el) return;
  const now = new Date();
  const open = SESSIONS.map(s => sessionOpen(s, now));
  const note = open[2] && open[3] ? "London and New York overlap"
    : open.every(x => !x) ? (now.getUTCDay() === 6 || now.getUTCDay() === 0 ? "Markets closed for the weekend" : "Between sessions") : "";
  el.innerHTML = SESSIONS.map((s, i) =>
    '<span class="session ' + (open[i] ? "open" : "") + '" title="' + s.name + (open[i] ? " session is open" : " session is closed") + '"><i></i>' + s.name + "</span>").join("") +
    (note ? '<span class="session-note">' + note + "</span>" : "");
}

document.addEventListener("keydown", function (e) {
  if (e.metaKey || e.ctrlKey || e.altKey || !state) return;
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target && e.target.isContentEditable)) return;
  if (modal.open || document.getElementById("confirmDialog").open) return;
  const views = ["dashboard", "journal", "setups", "pairs", "alerts", "settings"];
  const key = e.key.toLowerCase();
  if (key === "n") { e.preventDefault(); openTradeForm(); }
  else if (key === "s") { e.preventDefault(); openSetupForm(); }
  else if (/^[1-6]$/.test(key)) { e.preventDefault(); setView(views[Number(key) - 1]); }
});

function startClock() {
  const el = document.getElementById("clock");
  const tick = function () {
    if (el) el.textContent = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + " local";
    renderSessions();
  };
  tick();
  clockTimer = setInterval(tick, 15000);
}

async function boot() {
  startClock();
  const hash = location.hash.slice(1);
  if (VIEW_META[hash]) ui.view = hash;
  // Show the last known journal straight away while the server answers.
  const cached = cachedState();
  if (cached && cached.settings) {
    state = cached;
    renderChrome();
    renderView();
  }
  try {
    state = await api("/api/state");
  } catch (err) {
    if (!document.getElementById("gate").hidden) return;
    if (cached && cached.settings) {
      startApp(cached);
      setFeedError("Offline — retrying");
      return;
    }
    viewEl.innerHTML = '<div class="panel"><div class="panel-body">' +
      '<div class="form-error">Tradera could not reach its server. Running locally? Start it with <b>node server.js</b> (or double-click <b>start.cmd</b>). On Netlify, check that functions deployed and <b>DESK_PASSCODE</b> is set, then reload.</div>' +
      "</div></div>";
    setFeedError("Server offline");
    return;
  }
  startApp(state);
}

function startApp(next) {
  hideGate();
  state = next;
  cacheState(true);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  seedAlerts(state.alerts);
  updateNotifyButton();
  renderChrome();
  renderView();
  if (state.realtime === false) startPolling();
  else connectSSE();
}

const gateForm = document.getElementById("gateForm");
if (gateForm) {
  gateForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    const input = document.getElementById("gateKey");
    const error = document.getElementById("gateError");
    const key = String(input.value || "").trim();
    if (!key) return;
    error.hidden = true;
    const fail = function (message) {
      error.textContent = message;
      error.hidden = false;
    };
    if (ui.authMode === "account") {
      const signup = ui.gateStep === "signup";
      const email = String(document.getElementById("gateEmail").value || "").trim();
      const password = String(input.value || "");
      if (!email) return fail("Enter your email address.");
      if (signup && password.length < 10) return fail("Use at least 10 characters for your password.");
      if (signup && password !== document.getElementById("gateRepeat").value) return fail("The two passwords don't match.");
      const payload = { email, password };
      if (signup && ui.authInfo && ui.authInfo.legacy) {
        const old = document.getElementById("gateLegacyPw").value;
        if (ui.authInfo.legacyNeedsPassword && old) payload.legacyPassword = old;
        if (!ui.authInfo.legacyNeedsPassword && document.getElementById("gateLegacyCheck").checked) payload.claimLegacy = true;
      }
      const button = document.getElementById("gateSubmit");
      button.disabled = true;
      try {
        const res = await fetch(signup ? "/api/auth/signup" : "/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.token) return fail(data.error || "Could not " + (signup ? "create your account" : "log in") + " (" + res.status + ")");
        store("key", data.token);
        store("email", data.email || email);
        const st = await fetch("/api/state", { headers: { "x-desk-key": data.token }, cache: "no-store" });
        if (!st.ok) throw new Error("Server error (" + st.status + ")");
        startApp(await st.json());
        if (signup) toast("Account created", data.broughtJournal ? "Your journal, setups and settings moved into your account." : "Welcome to Tradera. Add your markets to get started.");
        else toast("Logged in", "Welcome back to Tradera.");
      } catch (err) {
        fail(err.message);
      } finally {
        button.disabled = false;
      }
      return;
    }
    try {
      let token = key;
      if (ui.authMode !== "passcode") {
        const login = await fetch("/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ password: key })
        });
        const data = await login.json().catch(() => ({}));
        if (!login.ok || !data.token) {
          error.textContent = data.error || "Could not log in (" + login.status + ")";
          error.hidden = false;
          input.select();
          return;
        }
        token = data.token;
      }
      const res = await fetch("/api/state", { headers: { "x-desk-key": token }, cache: "no-store" });
      if (res.status === 401) {
        error.textContent = ui.authMode === "passcode" ? "That passcode is not correct." : "That password is not correct.";
        error.hidden = false;
        return;
      }
      if (!res.ok) throw new Error("Server error (" + res.status + ")");
      store("key", token);
      startApp(await res.json());
      toast("Logged in", "Welcome back to Tradera.");
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}

document.getElementById("gate").addEventListener("click", function (e) {
  const btn = e.target.closest("[data-gate]");
  if (btn) setGateStep(btn.dataset.gate);
});
/* Any typing inside the page marks it as having unsaved changes (see absorbState). */
document.addEventListener("input", function (e) {
  if (e.target.closest && e.target.closest("#view")) ui.viewDirty = true;
}, true);

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && state && state.realtime === false) pollState();
});

if ("serviceWorker" in navigator &&
  (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () { /* offline shell is optional */ });
  });
}

boot();
