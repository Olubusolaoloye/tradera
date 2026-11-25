"use strict";

/**
 * Tradera serverless handler (Netlify Functions).
 *
 * Storage is Netlify Blobs. The same lib/desk-core.js powers the local server,
 * so behaviour and API routes stay identical.
 *
 * Accounts mode (the default on Netlify): people sign up with an email and a
 * password, and each account gets its own private journal document.
 *
 *   accounts/meta.json            signing secret, legacy-claim marker
 *   accounts/users/<hash>.json    one per email: id, password hash, version
 *   accounts/db/<userId>.json     that account's journal, setups and settings
 *   accounts/img/<userId>/<id>    that account's trade screenshots
 *   db.json                       the single-user journal from before accounts;
 *                                 the first account that proves its old
 *                                 password takes it over
 *
 * Environment variables:
 *   TRADERA_SIGNUPS   "closed" stops new sign-ups (existing accounts still work)
 *   TRADERA_ACCOUNTS  "off" falls back to the old single-user mode
 *   DESK_PASSCODE     single-user mode only: shared passcode / master key
 *   DESK_STORE        optional Blobs store name (default "trading-desk")
 */

const crypto = require("crypto");
const { createDesk, normalizeDB, imageRoute, createMemoryImages, setFeatures } = require("./desk-core");
const sec = require("./security");
const { createAdmin, DISABLED_PREFIX } = require("./admin");
const push = require("./webpush");

const PUSH_KEY = "push/vapid.json";
let pushKeysLoaded = null;
/** The site's notification keys: made once, stored in Blobs, cached per instance. */
async function ensurePushKeys(blobs) {
  if (pushKeysLoaded) { push.setPushKeys(pushKeysLoaded); return; }
  try {
    let keys = await blobs.get(PUSH_KEY, { type: "json" });
    if (!keys || !keys.publicKey) {
      const fresh = push.newPushKeys();
      if (!fresh) return;
      const res = await blobs.setJSON(PUSH_KEY, fresh, { onlyIfNew: true });
      keys = res && res.modified === false ? await blobs.get(PUSH_KEY, { type: "json" }) : fresh;
    }
    pushKeysLoaded = keys;
    push.setPushKeys(keys);
  } catch (_) { /* notifications stay off; everything else works */ }
}

// Default kept as "trading-desk" so deployments made before the Tradera rename keep their data.
const STORE_NAME = process.env.DESK_STORE || "trading-desk";
const LEGACY_KEY = "db.json";
const META_KEY = "accounts/meta.json";
const USER_PREFIX = "accounts/users/";
const USER_DB_PREFIX = "accounts/db/";
const TOKEN_TTL = 30 * 24 * 3600 * 1000;

class ConflictError extends Error {
  constructor() {
    super("Your data changed in another window. Please try again.");
    this.conflict = true;
  }
}

// -------------------------------------------------------------------- storage

/**
 * Netlify Blobs store with strong consistency, so a read right after a save
 * sees that save. The function entry points import getStore themselves and pass
 * it in, because the bundler cannot trace a lazy require.
 */
function openBlobs(name, getStoreImpl) {
  const getStore = getStoreImpl || require("@netlify/blobs").getStore;
  return getStore({ name: name || STORE_NAME, consistency: "strong" });
}

/**
 * One JSON document with optimistic locking: save() throws ConflictError when
 * another request saved the document after this one loaded it, instead of
 * silently overwriting that newer data.
 */
function docStore(blobs, key) {
  let etag = null;
  let locked = false;
  return {
    key,
    async load() {
      const res = await blobs.getWithMetadata(key, { type: "json" });
      locked = true;
      etag = (res && res.etag) || null;
      return res && res.data ? normalizeDB(res.data) : null;
    },
    async save(db) {
      const conditions = !locked ? {} : etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const res = await blobs.setJSON(key, db, conditions);
      if (res && res.modified === false) throw new ConflictError();
      etag = (res && res.etag) || null;
      // Without an etag we cannot guard the next save; fall back to a plain write.
      locked = !!etag;
    },
    async exists() {
      return !!(await blobs.getMetadata(key));
    }
  };
}

/** Trade screenshots as binary blobs under a key prefix. */
function blobImages(blobs, prefix) {
  return {
    async put(id, data, contentType) {
      const bytes = Buffer.from(data);
      await blobs.set(prefix + id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { metadata: { contentType } });
    },
    async get(id) {
      const res = await blobs.getWithMetadata(prefix + id, { type: "arrayBuffer" });
      if (!res || !res.data) return null;
      return { data: Buffer.from(res.data), contentType: (res.metadata && res.metadata.contentType) || "image/jpeg" };
    },
    async remove(id) { await blobs.delete(prefix + id); }
  };
}

/** The pre-accounts single document (kept for older callers). */
function createBlobsStore(name, getStoreImpl) {
  return docStore(openBlobs(name, getStoreImpl), LEGACY_KEY);
}

/** In-memory store for one document, used by tests. */
function createMemoryStore(seed) {
  let db = seed || null;
  return {
    async load() { return db; },
    async save(next) { db = JSON.parse(JSON.stringify(next)); },
    read() { return db; }
  };
}

/** In-memory stand-in for a Netlify Blobs store (conditional writes included). */
function createMemoryBlobs() {
  const map = new Map();
  let n = 0;
  const entry = key => map.get(key);
  return {
    async get(key) { const e = entry(key); return e ? (e.bin ? e.bin : JSON.parse(e.v)) : null; },
    async getWithMetadata(key, o) {
      const e = entry(key);
      if (!e) return null;
      if (o && o.type === "arrayBuffer") return { data: e.bin, etag: e.etag, metadata: e.metadata || {} };
      return { data: JSON.parse(e.v), etag: e.etag, metadata: {} };
    },
    async set(key, value, o) {
      const etag = '"' + (++n) + '"';
      map.set(key, { bin: Buffer.from(value), etag, metadata: (o && o.metadata) || {} });
      return { modified: true, etag };
    },
    async getMetadata(key) { const e = entry(key); return e ? { etag: e.etag, metadata: {} } : null; },
    async setJSON(key, value, cond) {
      const e = entry(key);
      const c = cond || {};
      if (c.onlyIfNew && e) return { modified: false };
      if (c.onlyIfMatch && (!e || e.etag !== c.onlyIfMatch)) return { modified: false };
      const etag = '"' + (++n) + '"';
      map.set(key, { v: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    async delete(key) { map.delete(key); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      return { blobs: [...map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, etag: map.get(key).etag })) };
    },
    keys() { return [...map.keys()]; }
  };
}

// ---------------------------------------------------------------------- utils

function apiPath(rawPath) {
  let p = String(rawPath || "/");
  const idx = p.indexOf("/api");
  if (idx >= 0) p = p.slice(idx);
  else p = "/api" + (p.startsWith("/") ? p : "/" + p);
  return p.split("?")[0];
}

function json(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

function passcodeFrom(event) {
  const headers = event.headers || {};
  const direct = headers["x-desk-key"] || headers["X-Desk-Key"];
  if (direct) return String(direct);
  const auth = headers.authorization || headers.Authorization || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "");
  const qs = event.queryStringParameters || {};
  if (qs.key) return String(qs.key);
  return "";
}

function fileResponse(result) {
  return {
    statusCode: result.status || 200,
    headers: { "Content-Type": result.file.contentType, "Cache-Control": "private, max-age=31536000, immutable" },
    body: Buffer.from(result.file.data).toString("base64"),
    isBase64Encoded: true
  };
}

const FEED_PATHS = { "/api/reminders/calendar.ics": "ics", "/api/reminders/today.json": "json" };

function feedResponse(result) {
  if (result.text) {
    return { statusCode: 200, headers: { "Content-Type": result.contentType, "Cache-Control": "no-store" }, body: result.text };
  }
  return json(result.status || 200, result.body);
}

function originOf(event) {
  try { return new URL(event.rawUrl).origin; } catch (_) { return ""; }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error("Invalid JSON body");
  }
}

function makeDesk(store, timeoutMs, images, accountId) {
  return createDesk({
    store,
    images,
    accountId: accountId || null,
    realtime: false,
    shareQuotes: true,
    timeoutMs: timeoutMs || 3500,
    onAlert() {},
    onAlerts() {},
    onSnapshot() {}
  });
}

/**
 * Fetch prices, fire alerts and save. If someone saved while prices were being
 * fetched, reload their version and lay the poll results over it.
 */
async function pollAndSave(desk, store) {
  await desk.poll();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await desk.save(true);
      return true;
    } catch (err) {
      if (!err.conflict) throw err;
      const snap = desk.pollSnapshot();
      await desk.load();
      desk.mergePoll(snap);
    }
  }
  return false;
}

// Routes with outside side effects are not repeated when a save conflicts.
const NO_RETRY = new Set(["/api/test-alert", "/api/test-call", "/api/telegram/find-chat", "/api/setups/read"]);

/**
 * Pro accounts. Until payments are wired in, Pro is granted by listing the
 * email in TRADERA_PRO_EMAILS (comma separated) or setting plan: "pro" on the
 * user record.
 */
function isPro(user, cfg) {
  if (!user) return false;
  if (user.plan === "pro") return true;
  if (cfg && (cfg.proEmails || []).includes(String(user.email || "").toLowerCase())) return true;
  const list = String(process.env.TRADERA_PRO_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  return list.includes(String(user.email || "").toLowerCase());
}

/**
 * Run one API request against one journal document. Edits retry on a save
 * conflict (reload, re-apply), so two devices never overwrite each other.
 */
async function runDesk(ctx) {
  const { store, method, pathname, body, waitUntil, decorate, gate, images, accountId } = ctx;
  const finish = (status, payload) => json(status, payload && payload.settings && decorate ? decorate(payload) : payload);

  for (let attempt = 0; attempt < 3; attempt++) {
    const desk = makeDesk(store, undefined, images, accountId);
    await desk.load();
    if (gate) {
      const denied = gate(desk);
      if (denied) return denied;
    }

    if (pathname === "/api/state" && method === "GET") {
      if (desk.needsFresh()) {
        const job = pollAndSave(desk, store).catch(() => { /* feed errors surface in state */ });
        // Answer at once with the saved prices and refresh in the background,
        // so the app opens fast; wait only when there is nothing to show yet.
        if (waitUntil && desk.hasQuotes()) {
          const snapshot = desk.state();
          waitUntil(job);
          return finish(200, snapshot);
        }
        await job;
      } else if (desk.dirty) {
        try { await desk.save(); } catch (_) { /* first load of a new journal; next request saves */ }
      }
      return finish(200, desk.state());
    }

    const result = await desk.handle(method, pathname, body);
    try {
      await desk.save();
    } catch (err) {
      if (err.conflict && !NO_RETRY.has(pathname) && attempt < 2) continue;
      if (method !== "GET") return json(err.conflict ? 409 : 500, { error: err.conflict ? err.message : "Could not save data: " + err.message });
    }

    if (result.file) return fileResponse(result);

    if (result.export) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="tradera-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
          "Cache-Control": "no-store"
        },
        body: JSON.stringify(result.body, null, 2)
      };
    }

    if (result.poll) {
      // Serverless cannot keep a timer; await the poll so this response
      // already carries fresh quotes.
      try { await pollAndSave(desk, store); } catch (_) { /* feed errors surface in state */ }
      const added = result.body && result.body.added;
      result.body = desk.state();
      if (added !== undefined) result.body.added = added;
    }
    return finish(result.status || 200, result.body);
  }
  return json(409, { error: new ConflictError().message });
}

// ------------------------------------------------------------------- accounts

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return email;
}
const checkNewPassword = (pw, email) => sec.checkNewPassword(pw, email);
const emailKey = email => crypto.createHash("sha256").update(email).digest("hex").slice(0, 40);
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString("hex");
function passwordMatches(record, pw) {
  if (!record || !record.hash || !record.salt) return false;
  const given = Buffer.from(hashPassword(pw, record.salt), "hex");
  const saved = Buffer.from(record.hash, "hex");
  return given.length === saved.length && crypto.timingSafeEqual(given, saved);
}

function createAccounts(blobs, options) {
  const opts = options || {};
  const shared = opts.shared || {};

  async function meta() {
    if (shared.meta) return shared.meta;
    let m = await blobs.get(META_KEY, { type: "json" });
    if (!m || !m.secret) {
      const fresh = { secret: crypto.randomBytes(32).toString("hex"), createdAt: new Date().toISOString(), legacyClaimedBy: null };
      const res = await blobs.setJSON(META_KEY, fresh, { onlyIfNew: true });
      m = res && res.modified === false ? await blobs.get(META_KEY, { type: "json" }) : fresh;
    }
    shared.meta = m;
    return m;
  }
  async function saveMeta(m) {
    await blobs.setJSON(META_KEY, m);
    shared.meta = m;
  }

  const getUser = ek => blobs.get(USER_PREFIX + ek + ".json", { type: "json" });
  const putUser = user => blobs.setJSON(USER_PREFIX + user.ek + ".json", user);
  const limiter = sec.createLimiter(blobs);
  const tooMany = r => json(429, { error: "Too many wrong tries. Try again in " + sec.waitText(r.retryAfter) + "." });

  async function issueToken(user) {
    const m = await meta();
    const payload = Buffer.from(JSON.stringify({ u: user.id, e: user.ek, v: user.version, exp: Date.now() + TOKEN_TTL })).toString("base64url");
    const sig = crypto.createHmac("sha256", m.secret).update(payload).digest("base64url");
    return "u1." + payload + "." + sig;
  }

  /** The account a token belongs to, or null. */
  async function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "u1") return null;
    const m = await meta();
    const expected = Buffer.from(crypto.createHmac("sha256", m.secret).update(parts[1]).digest("base64url"));
    const given = Buffer.from(parts[2]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch (_) { return null; }
    if (!claims || !(claims.exp > Date.now()) || !/^[0-9a-f]{40}$/.test(String(claims.e))) return null;
    const user = await getUser(claims.e);
    if (!user || user.id !== claims.u || user.version !== claims.v || user.disabled) return null;
    return user;
  }

  const legacy = () => docStore(blobs, LEGACY_KEY);

  async function legacyInfo() {
    const m = await meta();
    if (m.legacyClaimedBy) return { available: false };
    const raw = await blobs.get(LEGACY_KEY, { type: "json" });
    if (!raw) return { available: false };
    return { available: true, needsPassword: !!(raw.auth && raw.auth.hash), raw };
  }

  async function status(cfg) {
    const info = await legacyInfo();
    const out = { mode: "accounts", signups: opts.signups !== false, legacy: info.available, legacyNeedsPassword: !!info.needsPassword };
    if (cfg) {
      out.announcement = cfg.announcement || "";
      if (cfg.maintenance.enabled) out.maintenance = { message: cfg.maintenance.message || "Tradera is down for maintenance. Please check back soon." };
    }
    return out;
  }

  async function signup(body, ip) {
    if (opts.signups === false) return json(403, { error: "New sign-ups are closed on this Tradera." });
    let email, password;
    try { email = cleanEmail(body.email); password = checkNewPassword(body.password, email); } catch (err) { return json(400, { error: err.message }); }
    // At most 5 new accounts per IP address per hour.
    const room = await limiter.allow("signup-ip", ip || "unknown", 5, 3600000);
    if (!room.ok) return json(429, { error: "Too many new accounts from this connection. Try again in " + sec.waitText(room.retryAfter) + "." });
    const ek = emailKey(email);

    // Bring the pre-accounts journal along, if asked and the old password checks out.
    let journal = null;
    const wantsLegacy = !!(body.legacyPassword || body.claimLegacy);
    if (wantsLegacy) {
      const info = await legacyInfo();
      if (!info.available) return json(400, { error: "There is no earlier journal left to bring over. Leave that box empty." });
      if (info.needsPassword && !passwordMatches(info.raw.auth, body.legacyPassword)) {
        return json(400, { error: "Your old Tradera password is not correct. Leave that box empty to start fresh." });
      }
      journal = normalizeDB(info.raw);
      journal.auth = null;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: crypto.randomUUID(),
      ek,
      email,
      salt,
      hash: hashPassword(password, salt),
      version: 1,
      createdAt: new Date().toISOString(),
      failed: 0,
      lockedUntil: 0
    };
    const created = await blobs.setJSON(USER_PREFIX + ek + ".json", user, { onlyIfNew: true });
    if (created && created.modified === false) return json(409, { error: "An account with this email already exists. Log in instead." });

    if (journal) {
      await blobs.setJSON(USER_DB_PREFIX + user.id + ".json", journal);
      const m = await meta();
      await saveMeta({ ...m, legacyClaimedBy: user.id, legacyClaimedAt: new Date().toISOString() });
      // Keep a copy of the old document, then retire it so it is no longer polled.
      await blobs.setJSON("backup/db-before-accounts.json", journal);
      await blobs.delete(LEGACY_KEY);
    }
    return json(200, { token: await issueToken(user), email, broughtJournal: !!journal });
  }

  /**
   * Log in. Wrong tries are limited per email AND per IP address, and the
   * limits are stored, so they hold across every server instance. The answer
   * is the same whether or not the email has an account.
   */
  async function login(body, ip) {
    let email;
    try { email = cleanEmail(body.email); } catch (err) { return json(400, { error: err.message }); }
    const byIp = await limiter.check("login-ip", ip || "unknown");
    if (byIp.locked) return tooMany(byIp);
    const byEmail = await limiter.check("login-email", email);
    if (byEmail.locked) return tooMany(byEmail);

    const user = await getUser(emailKey(email));
    const ok = user ? passwordMatches(user, body.password) : (hashPassword(String(body.password || ""), "timing-equaliser"), false);
    if (!ok) {
      const a = await limiter.fail("login-ip", ip || "unknown", sec.RULES.loginIp);
      const b = await limiter.fail("login-email", email, sec.RULES.loginEmail);
      if (a.locked || b.locked) return tooMany({ retryAfter: Math.max(a.retryAfter, b.retryAfter) });
      return json(401, { error: "Email or password is not correct.", auth: "account" });
    }
    if (user.disabled) return json(403, { error: "This account has been disabled. Contact the Tradera team." });
    await limiter.reset("login-email", email);
    user.lastLoginAt = new Date().toISOString();
    delete user.failed; delete user.lockedUntil;
    await putUser(user);
    return json(200, { token: await issueToken(user), email: user.email });
  }

  function setPassword(user, pw) {
    user.salt = crypto.randomBytes(16).toString("hex");
    user.hash = hashPassword(pw, user.salt);
  }

  async function deleteUserData(user) {
    const shots = await blobs.list({ prefix: "accounts/img/" + user.id + "/" });
    for (const b of shots.blobs || []) await blobs.delete(b.key);
    await blobs.delete(USER_DB_PREFIX + user.id + ".json");
    await blobs.delete(DISABLED_PREFIX + user.id);
    await blobs.delete(USER_PREFIX + user.ek + ".json");
  }

  /** Wrong "current password" tries are limited per account, so a stolen login can't guess it. */
  async function currentPasswordOk(user, given) {
    const lock = await limiter.check("pw", user.id);
    if (lock.locked) return tooMany(lock);
    if (!passwordMatches(user, given)) {
      const r = await limiter.fail("pw", user.id, sec.RULES.passwordCheck);
      return r.locked ? tooMany(r) : json(400, { error: "Your current password is not correct." });
    }
    await limiter.reset("pw", user.id);
    return null;
  }

  /** Routes for a logged-in account; null when the path is not an account route. */
  async function accountRoute(user, pathname, body) {
    if (pathname === "/api/auth/password") {
      // Admin passwords are only changed in the admin dashboard, which also asks for the 2-step code.
      if (opts.isAdminEmail && opts.isAdminEmail(user.email)) {
        return json(403, { error: "This is an admin account. Change its password in the admin dashboard (/admin)." });
      }
      const bad = await currentPasswordOk(user, body.current);
      if (bad) return bad;
      let pw;
      try { pw = checkNewPassword(body.password, user.email); } catch (err) { return json(400, { error: err.message }); }
      if (passwordMatches(user, pw)) return json(400, { error: "Pick a new password, not the one you have now." });
      setPassword(user, pw);
      user.version += 1; // signs out every other device
      user.passwordChangedAt = new Date().toISOString();
      await putUser(user);
      return { token: await issueToken(user) };
    }
    if (pathname === "/api/auth/logout-all") {
      user.version += 1;
      await putUser(user);
      return { token: await issueToken(user) };
    }
    if (pathname === "/api/auth/delete") {
      if (opts.isAdminEmail && opts.isAdminEmail(user.email)) {
        return json(403, { error: "Admin accounts can't be deleted from the app. Remove the email from TRADERA_ADMIN_EMAILS first." });
      }
      const bad = await currentPasswordOk(user, body.current);
      if (bad) return bad;
      await deleteUserData(user);
      return json(200, { deleted: true });
    }
    if (pathname === "/api/auth/disable") {
      return json(400, { error: "Accounts always need a password." });
    }
    return null;
  }

  return {
    status, signup, login, verify, accountRoute,
    userStore: user => docStore(blobs, USER_DB_PREFIX + user.id + ".json"),
    // for the admin module
    internals: { meta, saveMeta, getUser, putUser, cleanEmail, emailKey, hashPassword, passwordMatches, setPassword, deleteUserData }
  };
}

// --------------------------------------------------------------------- create

/**
 * Build a Netlify handler. Options (mostly for tests):
 *   accounts  false = old single-user mode
 *   blobs     a Blobs-like store (accounts mode)
 *   store     a single-document store (single-user mode)
 *   signups   false = closed
 *   passcode  single-user DESK_PASSCODE override
 */
function createHandler(options) {
  const opts = options || {};
  const accountsMode = opts.accounts !== undefined
    ? !!opts.accounts
    : String(process.env.TRADERA_ACCOUNTS || "").toLowerCase() !== "off";
  return accountsMode ? accountsHandler(opts) : singleUserHandler(opts);
}

function accountsHandler(opts) {
  const signups = opts.signups !== undefined
    ? opts.signups !== false
    : String(process.env.TRADERA_SIGNUPS || "").toLowerCase() !== "closed";
  // The token-signing secret rarely changes, so it is shared between requests.
  const shared = {};

  return async function accountsDeskHandler(event) {
    const method = String(event.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
    const pathname = apiPath(event.path || (event.rawUrl ? new URL(event.rawUrl).pathname : "/"));
    if (pathname === "/api/health") return json(200, { ok: true, mode: "netlify", accounts: true, now: Date.now() });

    try {
      let body = {};
      try { body = parseBody(event); } catch (err) { return json(400, { error: err.message }); }
      // Netlify hands each request a short-lived Blobs token. A warm function
      // instance must not reuse a connection opened for an earlier request, or
      // it fails later with "Token Expired". So connect afresh every time.
      const blobs = opts.blobs || openBlobs(opts.storeName, opts.getStore);
      const ip = sec.clientIp(event);
      await ensurePushKeys(blobs);
      shared.admin = shared.admin || {};
      let admin = null;
      const acc = createAccounts(blobs, { signups, shared, isAdminEmail: email => admin.isAdminEmail(email) });
      admin = createAdmin(blobs, acc.internals, shared.admin);

      // The admin dashboard has its own sign-in and sessions.
      if (pathname.startsWith("/api/admin/")) return await admin.route({ ...event, clientIp: event.clientIp || ip }, method, pathname, body);

      // Platform switches set in the admin dashboard.
      const cfg = await admin.config();
      setFeatures(cfg.features);
      const f = cfg.features;

      if (pathname === "/api/auth/status") {
        const st = await acc.status(cfg);
        st.signups = st.signups && f.signups;
        return json(200, st);
      }
      if (cfg.maintenance.enabled && !FEED_PATHS[pathname]) {
        return json(503, { error: cfg.maintenance.message || "Tradera is down for maintenance. Please check back soon.", maintenance: true });
      }
      if (pathname === "/api/auth/signup" && method === "POST") {
        if (!f.signups) return json(403, { error: "New sign-ups are closed on this Tradera." });
        return await acc.signup(body, ip);
      }
      if (pathname === "/api/auth/login" && method === "POST") return await acc.login(body, ip);

      // The Android app's alarm check-in: the device's own key is the proof.
      if (pathname === "/api/alarm/poll" && method === "GET") {
        const qs = event.queryStringParameters || {};
        if (!/^[0-9a-f-]{36}$/.test(String(qs.u || ""))) return json(404, { error: "This phone isn't paired." });
        const store = docStore(blobs, USER_DB_PREFIX + qs.u + ".json");
        const desk = makeDesk(store, undefined, undefined, qs.u);
        await desk.load();
        const r = desk.alarmPoll(qs.d, qs.k);
        if (desk.dirty) { try { await desk.save(); } catch (_) { /* next check-in */ } }
        return json(r.status, r.body);
      }

      // "Stop alerts" from a notification: the alert's own key is the proof.
      if (pathname === "/api/push/ack" && method === "POST") {
        if (!/^[0-9a-f-]{36}$/.test(String((body && body.u) || ""))) return json(400, { error: "Unknown alert." });
        return await runDesk({ store: docStore(blobs, USER_DB_PREFIX + body.u + ".json"), method, pathname, body, accountId: body.u });
      }

      // iPhone calendar / Shortcut links carry their own secret instead of a login.
      if (FEED_PATHS[pathname] && method === "GET") {
        const qs = event.queryStringParameters || {};
        if (!/^[0-9a-f-]{36}$/.test(String(qs.u || ""))) return json(404, { error: "This reminder link is not valid." });
        const store = docStore(blobs, USER_DB_PREFIX + qs.u + ".json");
        const raw = await store.load();
        if (!raw) return json(404, { error: "This reminder link is not valid." });
        const desk = makeDesk(store);
        await desk.load();
        return feedResponse(desk.reminderFeed(FEED_PATHS[pathname], qs.k, originOf(event)));
      }

      const user = await acc.verify(passcodeFrom(event));
      if (!user) return json(401, { error: "Please log in", auth: "account" });

      const store = acc.userStore(user);
      const images = blobImages(blobs, "accounts/img/" + user.id + "/");
      if (pathname === "/api/images" && method === "POST" && !f.screenshots) {
        return json(403, { error: "Screenshot uploads are switched off for now." });
      }
      // Screenshots never need the journal loaded.
      const imaged = await imageRoute(images, method, pathname, body);
      if (imaged) return imaged.file ? fileResponse(imaged) : json(imaged.status, imaged.body);
      // Admins get every Pro feature.
      const plan = isPro(user, cfg) || admin.isAdminEmail(user.email) ? "pro" : "free";
      const features = { pasteImport: f.pasteImport, aiChartReader: f.aiChartReader, screenshots: f.screenshots, reminders: f.reminders,
        pushover: f.pushover, ntfy: f.ntfy, telegram: f.telegram, telegramCalls: f.telegramCalls, webpush: f.webpush, alarm: f.alarm };
      const decorate = state => ({ ...state, accounts: true, passwordSet: true, plan, features, announcement: cfg.announcement || "",
        account: { email: user.email, id: user.id, plan, admin: admin.isAdminEmail(user.email) } });

      if (pathname === "/api/setups/read" && method === "POST") {
        if (!f.pasteImport) return json(403, { error: "Reading pasted setups is switched off for now." });
        if (body && body.image && !f.aiChartReader) return json(403, { error: "AI chart reading is switched off for now. Screenshots of written signals still work.", needsText: true });
      }
      // Reading chart pictures with AI costs money per image, so it is Pro.
      if (pathname === "/api/setups/read" && method === "POST" && body && body.image && plan !== "pro") {
        return json(402, { error: "Reading chart pictures with AI is part of Tradera Pro. Screenshots of written signals are still read for free.", pro: true, needsText: true });
      }

      if (pathname.startsWith("/api/auth/")) {
        const routed = await acc.accountRoute(user, pathname, body);
        if (routed && routed.statusCode) return routed;
        if (routed && routed.token) {
          const desk = makeDesk(store);
          await desk.load();
          return json(200, { ...decorate(desk.state()), token: routed.token });
        }
        return json(404, { error: "Unknown API route" });
      }

      return await runDesk({ store, method, pathname, body, waitUntil: event.waitUntil, decorate, images, accountId: user.id });
    } catch (err) {
      return json(500, { error: err.message || "Server error" });
    }
  };
}

function singleUserHandler(opts) {
  // A fresh Blobs connection per request (see accountsHandler for why).
  const getStore = () => opts.store || createBlobsStore(opts.storeName, opts.getStore);
  const passcode = opts.passcode !== undefined
    ? opts.passcode
    : String(process.env.DESK_PASSCODE || "").trim();
  const memoryImages = opts.store && !opts.blobs ? createMemoryImages() : null;

  return async function deskHandler(event) {
    const method = String(event.httpMethod || "GET").toUpperCase();
    if (method === "OPTIONS") return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };

    const key = passcodeFrom(event);
    const pathname = apiPath(event.path || (event.rawUrl ? new URL(event.rawUrl).pathname : "/"));
    if (pathname === "/api/health") return json(200, { ok: true, mode: "netlify", now: Date.now() });

    try {
      let body = {};
      try { body = parseBody(event); } catch (err) { return json(400, { error: err.message }); }
      // An app password (set in Settings) takes over from DESK_PASSCODE; the
      // passcode still works as a master key so you can never lock yourself out.
      if (pathname === "/api/push/ack" && method === "POST") {
        return await runDesk({ store: getStore(), method, pathname, body, images: memoryImages || undefined });
      }
      if (pathname === "/api/alarm/poll" && method === "GET") {
        const qs = event.queryStringParameters || {};
        const store = getStore();
        const desk = makeDesk(store);
        await desk.load();
        const r = desk.alarmPoll(qs.d, qs.k);
        if (desk.dirty) { try { await desk.save(); } catch (_) { /* next check-in */ } }
        return json(r.status, r.body);
      }
      if (FEED_PATHS[pathname] && method === "GET") {
        const desk = makeDesk(getStore());
        await desk.load();
        return feedResponse(desk.reminderFeed(FEED_PATHS[pathname], (event.queryStringParameters || {}).k, originOf(event)));
      }
      const gate = desk => {
        const passcodeOk = !!passcode && key === passcode;
        if (desk.passwordSet()) {
          if (!passcodeOk && !desk.authorize(pathname, key)) return json(401, { error: "Password required", auth: "password" });
        } else if (passcode && !passcodeOk) {
          return json(401, { error: "Passcode required", auth: "passcode" });
        }
        return null;
      };
      const singleImages = opts.images || memoryImages ||
        blobImages(opts.blobs || openBlobs(opts.storeName, opts.getStore), "images/");
      return await runDesk({ store: getStore(), method, pathname, body, waitUntil: event.waitUntil, gate, images: singleImages });
    } catch (err) {
      return json(500, { error: err.message || "Server error" });
    }
  };
}

/**
 * Scheduled price check for every journal: each account plus the
 * pre-accounts document while it is still unclaimed. Runs a few at a time and
 * stops before the scheduled-function time limit.
 */
const POLL_CURSOR_KEY = "accounts/poll-cursor.json";

/**
 * Scheduled price check for every journal. Built to keep up with many
 * accounts:
 *  - prices are shared between journals (one fetch per market, not per user);
 *  - journals run 12 at a time from a pool, not in fixed batches;
 *  - if the time budget runs out, the next run starts where this one stopped,
 *    so every account is still reached in turn.
 */
async function pollAll(getStoreImpl, options) {
  const opts = options || {};
  const blobs = opts.blobs || openBlobs(opts.storeName, getStoreImpl);
  const started = Date.now();
  const budget = opts.budgetMs || 22000;
  const workers = Math.max(1, opts.concurrency || 12);

  await ensurePushKeys(blobs);
  // Respect the admin switches, and skip disabled accounts.
  try {
    const cfgRaw = await blobs.get("admin/config.json", { type: "json" });
    setFeatures(require("./admin").cleanConfig(cfgRaw).features);
  } catch (_) { setFeatures({}); }
  const disabled = new Set();
  try {
    const d = await blobs.list({ prefix: DISABLED_PREFIX });
    (d.blobs || []).forEach(b => disabled.add(b.key.slice(DISABLED_PREFIX.length)));
  } catch (_) { /* none */ }

  const keys = [];
  let cursor;
  do {
    const page = await blobs.list({ prefix: USER_DB_PREFIX, ...(cursor ? { cursor } : {}) });
    (page.blobs || []).forEach(b => {
      const id = b.key.slice(USER_DB_PREFIX.length).replace(/\.json$/, "");
      if (!disabled.has(id)) keys.push(b.key);
    });
    cursor = page.cursor || null;
  } while (cursor && keys.length < 100000);
  keys.sort();
  if (await blobs.getMetadata(LEGACY_KEY)) keys.push(LEGACY_KEY);

  // Start after the last journal the previous run reached.
  let startAt = 0;
  try {
    const saved = await blobs.get(POLL_CURSOR_KEY, { type: "json" });
    if (saved && saved.next) {
      const i = keys.findIndex(k => k >= saved.next);
      startAt = i < 0 ? 0 : i;
    }
  } catch (_) { /* first run */ }
  const order = keys.slice(startAt).concat(keys.slice(0, startAt));

  let polled = 0;
  let visited = 0;
  let next = 0;
  async function worker() {
    while (next < order.length && Date.now() - started < budget) {
      const key = order[next++];
      visited++;
      try {
        const store = docStore(blobs, key);
        const id = key.startsWith(USER_DB_PREFIX) ? key.slice(USER_DB_PREFIX.length).replace(/\.json$/, "") : null;
        const desk = makeDesk(store, 8000, undefined, id);
        await desk.load();
        if (!desk.symbolList().length && !desk.remindersOn() && !desk.isRinging()) continue;
        await pollAndSave(desk, store);
        polled++;
      } catch (err) {
        if (typeof console !== "undefined") console.error("Poll failed for " + key + ": " + err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, order.length || 1) }, worker));

  const finished = visited >= order.length;
  try {
    await blobs.setJSON(POLL_CURSOR_KEY, { next: finished ? null : order[next] || null, at: new Date().toISOString() });
  } catch (_) { /* best effort */ }
  return { journals: keys.length, visited, polled, finished };
}

const handler = createHandler();

/**
 * Adapter for Netlify's current function format (a web Request in, a Response
 * out) around the event-style handler above, which the tests also drive.
 */
function toWebHandler(eventHandler) {
  return async function (req, context) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const res = await eventHandler({
      httpMethod: method,
      path: url.pathname,
      rawUrl: req.url,
      headers: Object.fromEntries(req.headers),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: method === "GET" || method === "HEAD" ? undefined : await req.text(),
      isBase64Encoded: false,
      clientIp: context && context.ip ? String(context.ip) : "",
      waitUntil: context && typeof context.waitUntil === "function" ? p => context.waitUntil(p) : null
    });
    const payload = res.isBase64Encoded ? Buffer.from(res.body, "base64") : res.body;
    return new Response(payload, { status: res.statusCode, headers: res.headers });
  };
}

module.exports = {
  handler,
  createHandler,
  toWebHandler,
  pollAll,
  createMemoryStore,
  createMemoryBlobs,
  createBlobsStore,
  openBlobs,
  docStore,
  blobImages,
  apiPath
};
