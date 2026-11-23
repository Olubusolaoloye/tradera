"use strict";

/**
 * Tradera's own phone notifications (the Web Push standard), so users don't
 * need a separate app. The browser or the iPhone home-screen app gives us a
 * private delivery address ("subscription"); we send encrypted messages to
 * it, signed with the site's VAPID key pair.
 *
 * Keys are made once per site and stored with the site's data (Netlify Blobs
 * online, data/push-keys.json locally). The library is passed in by the
 * Netlify function so the bundler ships it; locally it is required directly.
 */

let lib = null;
function useWebPush(mod) { lib = mod && (mod.default || mod); }
function webPush() {
  if (!lib) {
    try { lib = require("web-push"); } catch (_) { lib = null; }
  }
  return lib;
}

let KEYS = null;
function setPushKeys(keys) {
  KEYS = keys && keys.publicKey && keys.privateKey ? keys : null;
}
function pushKeys() { return KEYS; }
function pushReady() { return !!(webPush() && KEYS); }
function newPushKeys() {
  const wp = webPush();
  if (!wp) return null;
  const k = wp.generateVAPIDKeys();
  return { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: new Date().toISOString() };
}

/** Only accept real push-service addresses from a browser. */
function cleanSubscription(raw) {
  const s = raw && typeof raw === "object" ? raw : null;
  if (!s) return null;
  const endpoint = String(s.endpoint || "");
  const keys = s.keys || {};
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(String(keys.p256dh || "")) || !/^[A-Za-z0-9_-]{10,100}$/.test(String(keys.auth || ""))) return null;
  return { endpoint, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) } };
}

/**
 * Send one message to one device. Resolves { ok, gone } — gone means the
 * device turned notifications off or the app was removed, so drop it.
 */
async function sendPush(sub, payload, opts) {
  const wp = webPush();
  if (!wp || !KEYS) return { ok: false, error: "Push is not set up" };
  const o = opts || {};
  const subject = String(process.env.URL || process.env.TRADERA_PUSH_SUBJECT || "https://tradera.app");
  try {
    await wp.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject: /^(https:|mailto:)/.test(subject) ? subject : "https://tradera.app", publicKey: KEYS.publicKey, privateKey: KEYS.privateKey },
      TTL: o.ttl || 3600,
      urgency: o.urgency || "normal",
      topic: o.topic ? String(o.topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined : undefined,
      timeout: o.timeoutMs || 8000
    });
    return { ok: true };
  } catch (err) {
    const code = err && err.statusCode;
    return { ok: false, gone: code === 404 || code === 410, error: "push " + (code || (err && err.message) || "failed") };
  }
}

module.exports = { useWebPush, setPushKeys, pushKeys, pushReady, newPushKeys, cleanSubscription, sendPush };
