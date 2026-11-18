"use strict";

/**
 * Tradera admin: platform switches, user management and an audit log.
 *
 * Who is an admin: accounts whose email is listed in TRADERA_ADMIN_EMAILS.
 * Signing in needs the account password AND a 6-digit code from an
 * authenticator app (or a one-time recovery code). Setting up that app the
 * first time can also require TRADERA_ADMIN_SETUP_CODE, a secret only the
 * site owner knows (optional: when it isn't set, the password is enough to
 * connect the authenticator app the first time).
 *
 * Admin sessions are separate from normal logins: short-lived (2 hours),
 * signed with their own key, sent in a header (never a cookie, so other
 * sites can't trigger admin actions), and revoked by logging out, changing
 * the password or the admin being removed from the list.
 */

const crypto = require("crypto");
const sec = require("./security");

const CONFIG_KEY = "admin/config.json";
const AUDIT_KEY = "admin/audit.json";
const DISABLED_PREFIX = "accounts/disabled/";
const ADMIN_TTL = 2 * 3600 * 1000;
const AUDIT_MAX = 500;

const FEATURES = {
  signups: { label: "New sign-ups", help: "Let new people create an account." },
  pasteImport: { label: "Paste or upload a setup", help: "Read setups from pasted text and screenshots." },
  aiChartReader: { label: "AI chart reading (Pro)", help: "Read chart pictures with AI. Costs money per image." },
  screenshots: { label: "Journal screenshots", help: "Upload screenshots to trades. Existing ones stay visible." },
  reminders: { label: "Chart check reminders", help: "Send scheduled 'check your charts' reminders." },
  pushover: { label: "Pushover alarms", help: "Send alerts through Pushover." },
  ntfy: { label: "ntfy phone push", help: "Send alerts through ntfy." },
  telegram: { label: "Telegram messages", help: "Send alerts through users' Telegram bots." },
  telegramCalls: { label: "Telegram calls (CallMeBot)", help: "Ring users on Telegram for entries." }
};

function defaultConfig() {
  const features = {};
  Object.keys(FEATURES).forEach(k => { features[k] = true; });
  return { features, maintenance: { enabled: false, message: "" }, announcement: "", proEmails: [], updatedAt: null, updatedBy: null };
}

function cleanConfig(raw) {
  const base = defaultConfig();
  const c = raw && typeof raw === "object" ? raw : {};
  const features = { ...base.features };
  Object.keys(FEATURES).forEach(k => { if (c.features && typeof c.features[k] === "boolean") features[k] = c.features[k]; });
  const m = c.maintenance || {};
  return {
    features,
    maintenance: { enabled: !!m.enabled, message: String(m.message || "").slice(0, 300) },
    announcement: String(c.announcement || "").slice(0, 300),
    proEmails: Array.isArray(c.proEmails)
      ? [...new Set(c.proEmails.map(e => String(e || "").trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200))].slice(0, 5000)
      : [],
    updatedAt: c.updatedAt || null,
    updatedBy: c.updatedBy || null
  };
}

function adminEmails() {
  return String(process.env.TRADERA_ADMIN_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
}
const isAdminEmail = email => adminEmails().includes(String(email || "").toLowerCase());

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex"
    },
    body: JSON.stringify(body)
  };
}

/** Never send password hashes, salts or 2-step secrets to any browser. */
function publicUser(u, extra) {
  return {
    ek: u.ek,
    id: u.id,
    email: u.email,
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null,
    plan: u.plan === "pro" ? "pro" : "free",
    disabled: !!u.disabled,
    admin: isAdminEmail(u.email),
    twoStep: !!(u.admin && u.admin.totp),
    ...(extra || {})
  };
}

/**
 * @param blobs     Netlify Blobs store
 * @param accounts  createAccounts(...).internals
 * @param shared    object kept between requests (config cache)
 */
function createAdmin(blobs, accounts, shared) {
  const cache = shared || {};
  const limiter = sec.createLimiter(blobs);

  async function config(fresh) {
    if (!fresh && cache.config && Date.now() - cache.configAt < 15000) return cache.config;
    let raw = null;
    try { raw = await blobs.get(CONFIG_KEY, { type: "json" }); } catch (_) { /* default */ }
    cache.config = cleanConfig(raw);
    cache.configAt = Date.now();
    return cache.config;
  }

  async function audit(entry) {
    try {
      const list = (await blobs.get(AUDIT_KEY, { type: "json" })) || [];
      list.unshift({ at: new Date().toISOString(), ...entry });
      await blobs.setJSON(AUDIT_KEY, list.slice(0, AUDIT_MAX));
    } catch (_) { /* never block an action on logging */ }
  }

  async function adminKey() {
    const m = await accounts.meta();
    if (m.adminSecret) return m.adminSecret;
    const next = { ...m, adminSecret: crypto.randomBytes(32).toString("hex") };
    await accounts.saveMeta(next);
    return next.adminSecret;
  }

  async function issue(user) {
    const key = await adminKey();
    const exp = Date.now() + ADMIN_TTL;
    const payload = Buffer.from(JSON.stringify({ u: user.id, e: user.ek, v: user.version, av: (user.admin && user.admin.version) || 1, iat: Date.now(), exp })).toString("base64url");
    const sig = crypto.createHmac("sha256", key).update("admin|" + payload).digest("base64url");
    return { token: "a1." + payload + "." + sig, expiresAt: exp };
  }

  async function verifyAdmin(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "a1") return null;
    const key = await adminKey();
    const expected = Buffer.from(crypto.createHmac("sha256", key).update("admin|" + parts[1]).digest("base64url"));
    const given = Buffer.from(parts[2]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let c;
    try { c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch (_) { return null; }
    if (!c || !(c.exp > Date.now()) || !/^[0-9a-f]{40}$/.test(String(c.e))) return null;
    const user = await accounts.getUser(c.e);
    if (!user || user.id !== c.u || user.version !== c.v || user.disabled) return null;
    if (!isAdminEmail(user.email) || !user.admin || !user.admin.totp) return null;
    if (((user.admin && user.admin.version) || 1) !== c.av) return null;
    return { user, exp: c.exp };
  }

  async function sealKey() { return (await accounts.meta()).secret; }

  /** Check a 6-digit code or a recovery code; updates the user record on success. */
  async function checkSecondStep(user, code) {
    const a = user.admin || {};
    const raw = String(code || "").trim();
    if (/^\d{3}\s?\d{3}$/.test(raw)) {
      const secret = sec.unseal(a.totp, await sealKey());
      const step = sec.verifyTotp(secret, raw.replace(/\s+/g, ""), a.lastStep || 0);
      if (step < 0) return false;
      a.lastStep = step; // a code can never be used twice
      user.admin = a;
      return true;
    }
    const h = sec.hashRecovery(raw);
    const list = a.recovery || [];
    const i = list.findIndex(x => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
    if (i < 0) return false;
    list.splice(i, 1);
    a.recovery = list;
    a.recoveryUsedAt = new Date().toISOString();
    user.admin = a;
    return true;
  }

  const GENERIC = "Email, password or code is not correct.";

  /** Limit by IP and by email before even looking the account up. */
  async function gate(ip, email) {
    const a = await limiter.check("admin-ip", ip);
    if (a.locked) return json(429, { error: "Too many attempts. Try again in " + sec.waitText(a.retryAfter) + "." });
    const b = await limiter.check("admin-email", email);
    if (b.locked) return json(429, { error: "Too many attempts. Try again in " + sec.waitText(b.retryAfter) + "." });
    return null;
  }
  async function failed(ip, email, reason) {
    const a = await limiter.fail("admin-ip", ip, sec.RULES.adminIp);
    const b = await limiter.fail("admin-email", email, sec.RULES.adminEmail);
    await audit({ admin: email || "?", ip, action: "login-failed", detail: reason });
    const locked = a.locked || b.locked;
    return json(locked ? 429 : 401, { error: locked ? "Too many attempts. Try again in " + sec.waitText(Math.max(a.retryAfter, b.retryAfter)) + "." : GENERIC });
  }

  async function passwordStep(body, ip) {
    if (!adminEmails().length) return { res: json(404, { error: "The admin dashboard is not switched on for this site." }) };
    let email;
    try { email = accounts.cleanEmail(body.email); } catch (_) { return { res: json(400, { error: GENERIC }) }; }
    const blocked = await gate(ip, email);
    if (blocked) return { res: blocked };
    const user = await accounts.getUser(accounts.emailKey(email));
    if (!user) { accounts.hashPassword(String(body.password || ""), "timing-equaliser"); return { res: await failed(ip, email, "unknown or not admin") }; }
    const okPw = accounts.passwordMatches(user, body.password);
    if (!okPw || !isAdminEmail(email) || user.disabled) return { res: await failed(ip, email, okPw ? "not an admin" : "wrong password") };
    return { user, email };
  }

  // -------------------------------------------------------------- routes

  async function login(body, ip) {
    const step = await passwordStep(body, ip);
    if (step.res) return step.res;
    const { user, email } = step;
    if (!user.admin || !user.admin.totp) {
      // Right password, but no authenticator app yet.
      return json(200, { needsSetup: true, setupAvailable: true, needsSetupCode: !!String(process.env.TRADERA_ADMIN_SETUP_CODE || "").trim() });
    }
    if (!(await checkSecondStep(user, body.code))) return failed(ip, email, "wrong code");
    user.lastLoginAt = new Date().toISOString();
    user.admin.lastLoginAt = user.lastLoginAt;
    user.admin.lastLoginIp = ip;
    await accounts.putUser(user);
    await limiter.reset("admin-email", email);
    await limiter.reset("admin-ip", ip);
    await audit({ admin: email, ip, action: "login" });
    const s = await issue(user);
    return json(200, { ...s, email, recoveryLeft: (user.admin.recovery || []).length });
  }

  async function setup(body, ip) {
    // Optional extra secret for connecting the authenticator app.
    const want = String(process.env.TRADERA_ADMIN_SETUP_CODE || "").trim();
    const step = await passwordStep(body, ip);
    if (step.res) return step.res;
    const { user, email } = step;
    if (want) {
      const given = Buffer.from(sec.sha(String(body.setupCode || "")));
      if (!crypto.timingSafeEqual(given, Buffer.from(sec.sha(want)))) return failed(ip, email, "wrong setup code");
    }
    if (user.admin && user.admin.totp) return json(409, { error: "Two-step sign-in is already set up for this admin. Sign in normally." });

    const key = await sealKey();
    if (body.step === "start") {
      const secret = sec.newTotpSecret();
      user.admin = { ...(user.admin || {}), pending: sec.seal(secret, key), pendingAt: Date.now() };
      await accounts.putUser(user);
      return json(200, { secret, uri: sec.otpauthUri(secret, email, "Tradera Admin") });
    }
    if (body.step === "confirm") {
      const a = user.admin || {};
      if (!a.pending || Date.now() - (a.pendingAt || 0) > 15 * 60000) return json(400, { error: "That setup expired. Start again." });
      const secret = sec.unseal(a.pending, key);
      const s = sec.verifyTotp(secret, body.code, 0);
      if (s < 0) return failed(ip, email, "wrong code during setup");
      const codes = sec.newRecoveryCodes();
      user.admin = {
        totp: sec.seal(secret, key),
        lastStep: s,
        recovery: codes.map(sec.hashRecovery),
        version: ((a.version || 0) + 1),
        enrolledAt: new Date().toISOString()
      };
      user.lastLoginAt = new Date().toISOString();
      await accounts.putUser(user);
      await limiter.reset("admin-email", email);
      await audit({ admin: email, ip, action: "two-step-setup" });
      const sess = await issue(user);
      return json(200, { ...sess, email, recoveryCodes: codes });
    }
    return json(400, { error: "Unknown setup step." });
  }

  async function allUsers() {
    if (cache.users && Date.now() - cache.usersAt < 20000) return cache.users;
    const keys = [];
    const page = await blobs.list({ prefix: "accounts/users/" });
    (page.blobs || []).forEach(b => keys.push(b.key));
    const out = [];
    for (let i = 0; i < keys.length; i += 25) {
      const batch = await Promise.all(keys.slice(i, i + 25).map(k => blobs.get(k, { type: "json" }).catch(() => null)));
      batch.forEach(u => { if (u && u.ek) out.push(u); });
    }
    cache.users = out;
    cache.usersAt = Date.now();
    return out;
  }

  async function overview() {
    const cfg = await config(true);
    const users = await allUsers();
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const since = (iso, ms) => iso && now - Date.parse(iso) < ms;
    const proSet = new Set(cfg.proEmails.concat(String(process.env.TRADERA_PRO_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean)));
    const isPro = u => u.plan === "pro" || proSet.has(u.email);
    let auditList = [];
    try { auditList = (await blobs.get(AUDIT_KEY, { type: "json" })) || []; } catch (_) { /* none */ }
    return {
      stats: {
        users: users.length,
        newToday: users.filter(u => since(u.createdAt, day)).length,
        new7: users.filter(u => since(u.createdAt, 7 * day)).length,
        new30: users.filter(u => since(u.createdAt, 30 * day)).length,
        active7: users.filter(u => since(u.lastLoginAt, 7 * day)).length,
        pro: users.filter(isPro).length,
        disabled: users.filter(u => u.disabled).length,
        failedAdminLogins24h: auditList.filter(a => a.action === "login-failed" && since(a.at, day)).length
      },
      env: {
        signupsClosedByEnv: String(process.env.TRADERA_SIGNUPS || "").toLowerCase() === "closed",
        aiKey: !!String(process.env.ANTHROPIC_API_KEY || "").trim(),
        pushoverToken: !!String(process.env.PUSHOVER_APP_TOKEN || "").trim(),
        admins: adminEmails().length
      },
      config: cfg,
      features: FEATURES,
      audit: auditList.slice(0, 15)
    };
  }

  async function saveConfig(admin, body, ip) {
    const before = await config(true);
    const next = cleanConfig({
      features: { ...before.features, ...(body.features || {}) },
      maintenance: body.maintenance !== undefined ? body.maintenance : before.maintenance,
      announcement: body.announcement !== undefined ? body.announcement : before.announcement,
      proEmails: body.proEmails !== undefined ? body.proEmails : before.proEmails
    });
    next.updatedAt = new Date().toISOString();
    next.updatedBy = admin.email;
    await blobs.setJSON(CONFIG_KEY, next);
    cache.config = next;
    cache.configAt = Date.now();
    const changed = [];
    Object.keys(next.features).forEach(k => { if (next.features[k] !== before.features[k]) changed.push(k + " " + (next.features[k] ? "on" : "off")); });
    if (next.maintenance.enabled !== before.maintenance.enabled) changed.push("maintenance " + (next.maintenance.enabled ? "on" : "off"));
    if (next.announcement !== before.announcement) changed.push("announcement updated");
    if (next.proEmails.join() !== before.proEmails.join()) changed.push("Pro list " + before.proEmails.length + " → " + next.proEmails.length);
    await audit({ admin: admin.email, ip, action: "config", detail: changed.join(", ") || "no change" });
    return json(200, { config: next });
  }

  async function userAction(admin, body, ip) {
    if (!/^[0-9a-f]{40}$/.test(String(body.ek || ""))) return json(400, { error: "Unknown user." });
    const user = await accounts.getUser(body.ek);
    if (!user) return json(404, { error: "That user no longer exists." });
    const self = user.id === admin.id;
    const act = String(body.action || "");
    const touches = ["disable", "delete", "logout"];
    if (self && touches.includes(act)) return json(400, { error: "You can't do that to your own admin account here." });
    if (isAdminEmail(user.email) && (act === "disable" || act === "delete")) return json(400, { error: "Remove this email from TRADERA_ADMIN_EMAILS before disabling or deleting it." });

    let detail = "";
    if (act === "plan") {
      user.plan = body.plan === "pro" ? "pro" : "free";
      detail = "plan " + user.plan;
    } else if (act === "disable") {
      user.disabled = true;
      user.version += 1; // signs them out everywhere
      await blobs.setJSON(DISABLED_PREFIX + user.id, { at: new Date().toISOString() });
      detail = "disabled";
    } else if (act === "enable") {
      user.disabled = false;
      await blobs.delete(DISABLED_PREFIX + user.id);
      detail = "enabled";
    } else if (act === "logout") {
      user.version += 1;
      detail = "signed out everywhere";
    } else if (act === "delete") {
      // Deleting is permanent: re-type the email and give a fresh code.
      if (String(body.confirmEmail || "").trim().toLowerCase() !== user.email) return json(400, { error: "Type the user's email exactly to confirm." });
      const me = await accounts.getUser(admin.ek);
      if (!me || !(await checkSecondStep(me, body.code))) {
        await audit({ admin: admin.email, ip, action: "delete-user-denied", target: user.email, detail: "wrong code" });
        return json(401, { error: "That code is not correct." });
      }
      await accounts.putUser(me);
      await accounts.deleteUserData(user);
      cache.users = null;
      await audit({ admin: admin.email, ip, action: "delete-user", target: user.email });
      return json(200, { deleted: true });
    } else {
      return json(400, { error: "Unknown action." });
    }
    user.updatedAt = new Date().toISOString();
    await accounts.putUser(user);
    cache.users = null;
    await audit({ admin: admin.email, ip, action: "user", target: user.email, detail });
    return json(200, { user: publicUser(user) });
  }

  async function changePassword(admin, body, ip) {
    const me = await accounts.getUser(admin.ek);
    const lock = await limiter.check("pw", me.id);
    if (lock.locked) return json(429, { error: "Too many wrong tries. Try again in " + sec.waitText(lock.retryAfter) + "." });
    const okPw = accounts.passwordMatches(me, body.current);
    const okCode = okPw && (await checkSecondStep(me, body.code));
    if (!okPw || !okCode) {
      const r = await limiter.fail("pw", me.id, sec.RULES.passwordCheck);
      await audit({ admin: admin.email, ip, action: "password-change-denied" });
      return json(r.locked ? 429 : 401, { error: r.locked ? "Too many wrong tries. Try again in " + sec.waitText(r.retryAfter) + "." : "Current password or code is not correct." });
    }
    let pw;
    try { pw = sec.checkNewPassword(body.password, me.email); } catch (err) { return json(400, { error: err.message }); }
    if (String(body.password).length < 12) return json(400, { error: "Admin passwords need at least 12 characters." });
    if (accounts.passwordMatches(me, pw)) return json(400, { error: "Pick a password you haven't used here." });
    accounts.setPassword(me, pw);
    me.version += 1;                                        // signs out the app everywhere
    me.admin.version = (me.admin.version || 1) + 1;         // and every admin session
    me.passwordChangedAt = new Date().toISOString();
    await accounts.putUser(me);
    await limiter.reset("pw", me.id);
    await audit({ admin: admin.email, ip, action: "password-changed" });
    const s = await issue(me);
    return json(200, { ...s, email: me.email });
  }

  async function newRecovery(admin, body, ip) {
    const me = await accounts.getUser(admin.ek);
    if (!(await checkSecondStep(me, body.code))) {
      await audit({ admin: admin.email, ip, action: "recovery-codes-denied" });
      return json(401, { error: "That code is not correct." });
    }
    const codes = sec.newRecoveryCodes();
    me.admin.recovery = codes.map(sec.hashRecovery);
    await accounts.putUser(me);
    await audit({ admin: admin.email, ip, action: "recovery-codes-renewed" });
    return json(200, { recoveryCodes: codes });
  }

  /** Every /api/admin/* request. */
  async function route(event, method, pathname, body) {
    const ip = sec.clientIp(event);
    if (pathname === "/api/admin/login" && method === "POST") return login(body || {}, ip);
    if (pathname === "/api/admin/setup" && method === "POST") return setup(body || {}, ip);

    const headers = event.headers || {};
    const token = headers["x-admin-token"] || headers["X-Admin-Token"] || "";
    const session = await verifyAdmin(token);
    if (!session) return json(401, { error: "Please sign in again.", admin: "login" });
    const admin = { id: session.user.id, ek: session.user.ek, email: session.user.email };

    if (pathname === "/api/admin/session" && method === "GET") {
      return json(200, { email: admin.email, expiresAt: session.exp, recoveryLeft: (session.user.admin.recovery || []).length });
    }
    if (pathname === "/api/admin/logout" && method === "POST") {
      const me = session.user;
      me.admin.version = (me.admin.version || 1) + 1; // ends every admin session for this account
      await accounts.putUser(me);
      await audit({ admin: admin.email, ip, action: "logout" });
      return json(200, { ok: true });
    }
    if (pathname === "/api/admin/overview" && method === "GET") return json(200, await overview());
    if (pathname === "/api/admin/config" && method === "POST") return saveConfig(admin, body || {}, ip);
    if (pathname === "/api/admin/users" && method === "GET") {
      const cfg = await config();
      const proSet = new Set(cfg.proEmails.concat(String(process.env.TRADERA_PRO_EMAILS || "").toLowerCase().split(/[\s,;]+/).filter(Boolean)));
      const users = (await allUsers()).map(u => publicUser(u, { proByList: proSet.has(u.email) }));
      users.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return json(200, { users });
    }
    if (pathname === "/api/admin/users/action" && method === "POST") return userAction(admin, body || {}, ip);
    if (pathname === "/api/admin/audit" && method === "GET") {
      let list = [];
      try { list = (await blobs.get(AUDIT_KEY, { type: "json" })) || []; } catch (_) { /* none */ }
      return json(200, { audit: list });
    }
    if (pathname === "/api/admin/password" && method === "POST") return changePassword(admin, body || {}, ip);
    if (pathname === "/api/admin/recovery-codes" && method === "POST") return newRecovery(admin, body || {}, ip);
    return json(404, { error: "Unknown admin route." });
  }

  return { route, config, audit, isAdminEmail };
}

module.exports = { createAdmin, cleanConfig, defaultConfig, FEATURES, DISABLED_PREFIX, isAdminEmail };
