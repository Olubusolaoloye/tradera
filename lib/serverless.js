"use strict";

/**
 * Tradera serverless handler (Netlify Functions).
 *
 * Storage is Netlify Blobs. The same lib/desk-core.js powers the local server,
 * so behaviour and API routes stay identical.
 *
 * Environment variables:
 *   DESK_PASSCODE   optional shared passcode; when set, every /api request
 *                   must send it in the x-desk-key header (or ?key=).
 *   DESK_STORE      optional Blobs store name (default "trading-desk").
 */

const { createDesk, normalizeDB } = require("./desk-core");

// Default kept as "trading-desk" so deployments made before the Tradera rename keep their data.
const STORE_NAME = process.env.DESK_STORE || "trading-desk";
const DB_KEY = "db.json";

// -------------------------------------------------------------------- storage

/**
 * Netlify Blobs store. The function entry points import getStore themselves and
 * pass it in, because the bundler cannot trace a lazy require; the fallback
 * require keeps older callers working. The local server never loads this.
 */
function createBlobsStore(name, getStoreImpl) {
  const getStore = getStoreImpl || require("@netlify/blobs").getStore;
  const store = getStore({ name: name || STORE_NAME });
  return {
    async load() {
      const raw = await store.get(DB_KEY, { type: "json" });
      return raw ? normalizeDB(raw) : null;
    },
    async save(db) {
      await store.setJSON(DB_KEY, db);
    }
  };
}

/** In-memory store, useful for tests and local handler harnesses. */
function createMemoryStore(seed) {
  let db = seed || null;
  return {
    async load() { return db; },
    async save(next) { db = JSON.parse(JSON.stringify(next)); },
    read() { return db; }
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

// --------------------------------------------------------------------- create

/**
 * Build a Netlify handler. Pass a custom store/passcode for tests.
 */
function createHandler(options) {
  const opts = options || {};
  let store = opts.store || null;
  const getStore = () => {
    if (!store) store = createBlobsStore(opts.storeName, opts.getStore);
    return store;
  };
  const passcode = opts.passcode !== undefined
    ? opts.passcode
    : String(process.env.DESK_PASSCODE || "").trim();

  return async function deskHandler(event) {
    const method = String(event.httpMethod || "GET").toUpperCase();

    if (method === "OPTIONS") {
      return { statusCode: 204, headers: { "Cache-Control": "no-store" }, body: "" };
    }

    const key = passcodeFrom(event);
    const pathname = apiPath(event.path || (event.rawUrl ? new URL(event.rawUrl).pathname : "/"));

    if (pathname === "/api/health") {
      return json(200, { ok: true, mode: "netlify", now: Date.now() });
    }

    const desk = createDesk({
      store: getStore(),
      realtime: false,
      timeoutMs: 3500,
      onAlert() {},
      onAlerts() {},
      onSnapshot() {}
    });

    try {
      await desk.load();

      // An app password (set in Settings) takes over from DESK_PASSCODE; the
      // passcode still works as a master key so you can never lock yourself out.
      const passcodeOk = !!passcode && key === passcode;
      if (desk.passwordSet()) {
        if (!passcodeOk && !desk.authorize(pathname, key)) return json(401, { error: "Password required", auth: "password" });
      } else if (passcode && !passcodeOk) {
        return json(401, { error: "Passcode required", auth: "passcode" });
      }

      if (pathname === "/api/state" && method === "GET") {
        try { await desk.ensureFresh(); } catch (_) { /* feed errors surface in state */ }
      }

      let body = {};
      try {
        body = parseBody(event);
      } catch (err) {
        return json(400, { error: err.message });
      }

      const result = await desk.handle(method, pathname, body);
      // Persist quotes/alerts too, not just mutations.
      try {
        await desk.save();
      } catch (err) {
        if (method !== "GET") {
          return json(500, { error: "Could not save data: " + err.message });
        }
      }

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
        // Serverless cannot keep a timer; await the poll so this response and
        // the saved state already carry fresh quotes.
        try { await desk.poll(); await desk.save(); } catch (_) { /* feed errors surface in state */ }
        const added = result.body && result.body.added;
        result.body = desk.state();
        if (added !== undefined) result.body.added = added;
      }

      return json(result.status || 200, result.body);
    } catch (err) {
      return json(500, { error: err.message || "Server error" });
    }
  };
}

const handler = createHandler();

/**
 * Adapter for Netlify's current function format (a web Request in, a Response
 * out) around the event-style handler above, which the tests also drive.
 */
function toWebHandler(eventHandler) {
  return async function (req) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const res = await eventHandler({
      httpMethod: method,
      path: url.pathname,
      rawUrl: req.url,
      headers: Object.fromEntries(req.headers),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: method === "GET" || method === "HEAD" ? undefined : await req.text(),
      isBase64Encoded: false
    });
    return new Response(res.body, { status: res.statusCode, headers: res.headers });
  };
}

module.exports = {
  handler,
  createHandler,
  toWebHandler,
  createMemoryStore,
  createBlobsStore,
  apiPath
};
