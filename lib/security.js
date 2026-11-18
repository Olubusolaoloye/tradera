"use strict";

/**
 * Security helpers shared by the accounts and admin code:
 *  - rate limits stored in Netlify Blobs, so they hold across every function
 *    instance (an in-memory counter resets whenever Netlify starts a new one);
 *  - the password rules for new passwords;
 *  - time-based one-time codes (TOTP, the 6-digit codes from Google
 *    Authenticator, Authy, 1Password…) and one-time recovery codes;
 *  - reading the caller's IP address.
 */

const crypto = require("crypto");

const RL_PREFIX = "security/rl/";

const sha = (text, len) => crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, len || 64);

/**
 * Login-style limiter. Each key (an email, an IP, a user) may fail `limit`
 * times within `windowMs`; then it is locked for `lockMs`, doubling with
 * every further lock (up to `maxLockMs`). Success resets the failures.
 */
function createLimiter(blobs) {
  const keyOf = (bucket, id) => RL_PREFIX + bucket + "/" + sha(bucket + "|" + String(id).toLowerCase(), 40) + ".json";

  async function read(bucket, id) {
    try { return (await blobs.get(keyOf(bucket, id), { type: "json" })) || null; } catch (_) { return null; }
  }

  /** { locked, retryAfter (seconds) } */
  async function check(bucket, id) {
    const rec = await read(bucket, id);
    const now = Date.now();
    if (rec && rec.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - now) / 1000) };
    return { locked: false, retryAfter: 0 };
  }

  async function fail(bucket, id, rule) {
    const now = Date.now();
    const rec = (await read(bucket, id)) || { fails: [], strikes: 0, lockedUntil: 0 };
    rec.fails = (rec.fails || []).filter(t => now - t < rule.windowMs);
    rec.fails.push(now);
    // Strikes fade after a quiet day.
    if (rec.lastLockAt && now - rec.lastLockAt > 24 * 3600 * 1000) rec.strikes = 0;
    let locked = false;
    if (rec.fails.length >= rule.limit) {
      const lockMs = Math.min(rule.lockMs * Math.pow(2, rec.strikes || 0), rule.maxLockMs || rule.lockMs * 16);
      rec.lockedUntil = now + lockMs;
      rec.lastLockAt = now;
      rec.strikes = (rec.strikes || 0) + 1;
      rec.fails = [];
      locked = true;
    }
    try { await blobs.setJSON(keyOf(bucket, id), rec); } catch (_) { /* best effort */ }
    return { locked, retryAfter: locked ? Math.ceil((rec.lockedUntil - now) / 1000) : 0 };
  }

  async function reset(bucket, id) {
    const rec = await read(bucket, id);
    if (rec && (rec.fails && rec.fails.length || rec.lockedUntil)) {
      try { await blobs.setJSON(keyOf(bucket, id), { fails: [], strikes: rec.strikes || 0, lockedUntil: 0, lastLockAt: rec.lastLockAt || 0 }); } catch (_) { /* best effort */ }
    }
  }

  /** Simple counter: allow `limit` events per `windowMs` (e.g. sign-ups per IP). */
  async function allow(bucket, id, limit, windowMs) {
    const now = Date.now();
    const rec = (await read(bucket, id)) || { hits: [] };
    rec.hits = (rec.hits || []).filter(t => now - t < windowMs);
    if (rec.hits.length >= limit) {
      return { ok: false, retryAfter: Math.ceil((rec.hits[0] + windowMs - now) / 1000) };
    }
    rec.hits.push(now);
    try { await blobs.setJSON(keyOf(bucket, id), rec); } catch (_) { /* best effort */ }
    return { ok: true, retryAfter: 0 };
  }

  return { check, fail, reset, allow };
}

/** Rules used across the app. */
const RULES = {
  // Per account email: 5 wrong passwords in 15 min → 1 min lock, then 2, 4… up to 1 hour.
  loginEmail: { limit: 5, windowMs: 15 * 60000, lockMs: 60000, maxLockMs: 3600000 },
  // Per IP across all accounts (stops password spraying): 20 fails / 15 min → 15 min lock.
  loginIp: { limit: 20, windowMs: 15 * 60000, lockMs: 15 * 60000, maxLockMs: 24 * 3600000 },
  // Wrong "current password" when changing password / deleting: 5 / 15 min → 15 min lock.
  passwordCheck: { limit: 5, windowMs: 15 * 60000, lockMs: 15 * 60000, maxLockMs: 24 * 3600000 },
  // Admin sign-in is stricter: 3 fails / 15 min → 15 min lock, doubling up to a day.
  adminEmail: { limit: 3, windowMs: 15 * 60000, lockMs: 15 * 60000, maxLockMs: 24 * 3600000 },
  adminIp: { limit: 5, windowMs: 15 * 60000, lockMs: 30 * 60000, maxLockMs: 24 * 3600000 }
};

function waitText(seconds) {
  if (seconds < 90) return seconds + " seconds";
  const m = Math.ceil(seconds / 60);
  return m < 90 ? m + " minutes" : Math.ceil(m / 60) + " hours";
}

// ------------------------------------------------------------- passwords

const COMMON = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword",
  "12345678", "123456789", "1234567890", "12345678910", "11111111", "00000000", "87654321", "123123123",
  "qwertyuiop", "qwerty123", "qwerty1234", "1q2w3e4r", "1q2w3e4r5t", "zaq12wsx", "abc12345", "abcd1234",
  "iloveyou", "iloveyou1", "sunshine1", "princess1", "football1", "baseball1", "welcome1", "welcome123",
  "letmein1", "letmein123", "trustno1", "monkey123", "dragon123", "master123", "admin123", "administrator",
  "changeme", "changeme1", "trading123", "forex123", "tradera123", "tradera", "trader123", "money123"
]);

/** New passwords: 10+ characters, not a common one, not the email, not all one character. */
function checkNewPassword(pw, email) {
  const p = String(pw || "");
  if (p.length < 10) throw new Error("Use at least 10 characters for your password.");
  if (p.length > 200) throw new Error("That password is too long.");
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9]/g, ""))) throw new Error("That password is too common. Pick something harder to guess.");
  if (/^(.)\1+$/.test(p)) throw new Error("That password is too easy to guess.");
  const local = String(email || "").toLowerCase().split("@")[0];
  if (local && local.length >= 4 && lower.includes(local)) throw new Error("Don't use your email in your password.");
  return p;
}

// ------------------------------------------------------------------- TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

function totpAt(secret, step) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1000000).padStart(6, "0");
}

/**
 * Check a 6-digit code, allowing one 30-second step either way for clock
 * drift. Returns the matching step (so it can't be used twice) or -1.
 */
function verifyTotp(secret, code, lastStep, now) {
  const c = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return -1;
  const step = Math.floor((now || Date.now()) / 30000);
  for (const s of [step - 1, step, step + 1]) {
    if (lastStep && s <= lastStep) continue;
    const a = Buffer.from(totpAt(secret, s));
    if (crypto.timingSafeEqual(a, Buffer.from(c))) return s;
  }
  return -1;
}

function otpauthUri(secret, email, issuer) {
  const label = encodeURIComponent((issuer || "Tradera Admin") + ":" + email);
  return "otpauth://totp/" + label + "?secret=" + secret + "&issuer=" + encodeURIComponent(issuer || "Tradera Admin") + "&algorithm=SHA1&digits=6&period=30";
}

/** 8 one-time recovery codes like "k7qp-2mxa-9tdz"; only their hashes are stored. */
function newRecoveryCodes() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const bytes = crypto.randomBytes(12);
    let c = "";
    for (let j = 0; j < 12; j++) c += alphabet[bytes[j] % alphabet.length];
    codes.push(c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8, 12));
  }
  return codes;
}
const hashRecovery = code => sha("recovery|" + String(code || "").toLowerCase().replace(/[^a-z0-9]/g, ""));

// ---------------------------------------------------------------- request

/** The caller's IP: Netlify's own header first (clients can't forge it). */
function clientIp(event) {
  const h = event.headers || {};
  const get = name => h[name] || h[name.toLowerCase()] || "";
  const ip = event.clientIp || get("x-nf-client-connection-ip") || String(get("x-forwarded-for")).split(",")[0].trim();
  return String(ip || "unknown").slice(0, 64);
}

/** Encrypt small secrets (the admin's TOTP key) at rest with AES-256-GCM. */
function seal(text, keyHex) {
  const key = crypto.createHash("sha256").update("tradera-seal|" + keyHex).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv.toString("base64url"), data.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}
function unseal(box, keyHex) {
  try {
    const [iv, data, tag] = String(box || "").split(".");
    const key = crypto.createHash("sha256").update("tradera-seal|" + keyHex).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch (_) { return null; }
}

module.exports = {
  createLimiter, RULES, waitText, checkNewPassword,
  newTotpSecret, totpAt, verifyTotp, otpauthUri, newRecoveryCodes, hashRecovery,
  clientIp, seal, unseal, sha
};
