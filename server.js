"use strict";

/**
 * Tradera — local server.
 *
 * Thin HTTP wrapper around lib/desk-core.js. No external dependencies:
 *   node server.js
 *
 * Storage: data/db.json (atomic writes).
 * Realtime: Server-Sent Events at /api/events.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const { createDesk, normalizeDB } = require("./lib/desk-core");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const OPEN_BROWSER = process.env.NO_OPEN !== "1";

// ------------------------------------------------------------------- storage

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const fileStore = {
  async load() {
    try {
      const raw = await fs.promises.readFile(DB_FILE, "utf8");
      return normalizeDB(JSON.parse(raw));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      // A corrupt file should never take the desk down; keep a backup first.
      try {
        const backup = DB_FILE + ".corrupt-" + Date.now();
        await fs.promises.copyFile(DB_FILE, backup);
        console.error("Could not parse db.json; backed up to", backup);
      } catch (_) { /* ignore backup failure */ }
      return null;
    }
  },
  async save(db) {
    ensureDataDir();
    const tmp = DB_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
    await fs.promises.rename(tmp, DB_FILE);
  }
};

/** Trade screenshots live next to the journal as plain files. */
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const fileImages = {
  async put(id, data, contentType) {
    await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(IMAGE_DIR, id + (IMAGE_EXT[contentType] || ".jpg")), data);
  },
  async get(id) {
    for (const [type, ext] of Object.entries(IMAGE_EXT)) {
      try {
        return { data: await fs.promises.readFile(path.join(IMAGE_DIR, id + ext)), contentType: type };
      } catch (_) { /* try the next extension */ }
    }
    return null;
  },
  async remove(id) {
    for (const ext of Object.values(IMAGE_EXT)) {
      try { await fs.promises.unlink(path.join(IMAGE_DIR, id + ext)); } catch (_) { /* not this one */ }
    }
  }
};

// ------------------------------------------------------------------ realtime

const sseClients = new Set();

function sseSend(res, event, data) {
  try {
    res.write("event: " + event + "\n");
    res.write("data: " + JSON.stringify(data) + "\n\n");
  } catch (_) { /* client went away */ }
}

function broadcast(event, data) {
  for (const res of sseClients) sseSend(res, event, data);
}

// ---------------------------------------------------------------------- desk

const desk = createDesk({
  store: fileStore,
  images: fileImages,
  realtime: true,
  onAlert(alert) {
    broadcast("alert", alert);
  },
  onAlerts(alerts) {
    broadcast("alerts", alerts);
  },
  onSnapshot(snapshot) {
    broadcast("snapshot", snapshot);
  }
});

// -------------------------------------------------------------------- helpers

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function sendDownload(res, payload) {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="tradera-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error("Invalid JSON body");
  }
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const base = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (!filePath.startsWith(base)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback for unknown non-API paths.
      if (!path.extname(rel)) return serveStatic(req, res, "/index.html");
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Content-Length": stat.size,
      // Revalidate every load so an upgrade never pairs new HTML with stale CSS/JS.
      "Cache-Control": "no-cache"
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------- HTTP router

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1"));
  const pathname = url.pathname;

  // Health check
  if (pathname === "/api/health") {
    return sendJSON(res, 200, { ok: true, mode: "local", now: Date.now() });
  }

  // Everything else under /api needs a login once a password is set. The live
  // stream can't send headers (EventSource), so it passes the token as ?key=.
  if (pathname.startsWith("/api/")) {
    const token = req.headers["x-desk-key"] || url.searchParams.get("key") || "";
    if (!desk.authorize(pathname, token)) {
      return sendJSON(res, 401, { error: "Password required", auth: "password" });
    }
  }

  // Live event stream
  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    sseSend(res, "snapshot", desk.snapshot());
    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch (_) { /* ignore */ }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
    return;
  }

  if (!pathname.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end("Method not allowed");
    }
    return serveStatic(req, res, pathname);
  }

  try {
    const method = String(req.method || "GET").toUpperCase();
    let body = {};
    if (method === "POST" || method === "PATCH" || method === "PUT") {
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { error: err.message });
      }
    }

    if (pathname === "/api/state" && method === "GET") {
      // Refresh quotes if the last poll is stale (keeps a cold start snappy).
      try {
        await desk.ensureFresh();
        await desk.save();
      } catch (_) { /* feed errors are surfaced in state */ }
    }

    const result = await desk.handle(method, pathname, body);

    if (result.file) {
      res.writeHead(result.status || 200, {
        "Content-Type": result.file.contentType,
        "Content-Length": result.file.data.length,
        "Cache-Control": "private, max-age=31536000, immutable"
      });
      return res.end(result.file.data);
    }

    if (result.export) {
      // Persist any in-memory quote/alert changes before exporting.
      try { await desk.save(true); } catch (_) { /* ignore */ }
      return sendDownload(res, result.body);
    }

    // Persist the mutation before responding so a refresh never loses data.
    if (method !== "GET") {
      try { await desk.save(); } catch (err) {
        return sendJSON(res, 500, { error: "Could not save data: " + err.message });
      }
    }

    // Kick off a background poll for actions that change what we track.
    if (result.poll) {
      desk.poll()
        .then(function () { return desk.save(); })
        .catch(function () { /* errors land in feedStatus */ });
    }

    return sendJSON(res, result.status || 200, result.body);
  } catch (err) {
    return sendJSON(res, 500, { error: err.message || "Server error" });
  }
});

// ------------------------------------------------------------------ polling

let pollTimer = null;

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(5, desk.effectivePollSeconds());
  pollTimer = setInterval(() => {
    desk.poll().catch(err => console.error("Poll failed:", err.message));
    // Persist freshly fetched quotes/alerts every cycle.
    desk.save().catch(err => console.error("Save failed:", err.message));
  }, seconds * 1000);
  pollTimer.unref?.();
}

function openBrowser(url) {
  const cmd = process.platform === "win32"
    ? 'start "" "' + url + '"'
    : process.platform === "darwin"
      ? 'open "' + url + '"'
      : 'xdg-open "' + url + '"';
  exec(cmd, () => { /* opening the browser is best-effort */ });
}

(async function start() {
  await desk.load();
  await desk.save(true);

  server.listen(PORT, HOST, () => {
    const url = "http://" + (HOST === "0.0.0.0" ? "127.0.0.1" : HOST) + ":" + PORT;
    console.log("");
    console.log("  Tradera running at " + url);
    console.log("  Data file: " + DB_FILE);
    console.log("  Press Ctrl+C to stop.");
    console.log("");
    schedulePolling();
    desk.poll().catch(err => console.error("Initial poll failed:", err.message));
    if (OPEN_BROWSER) openBrowser(url);
  });
})().catch(err => {
  console.error("Failed to start Tradera:", err);
  process.exitCode = 1;
});
