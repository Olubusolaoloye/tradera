"use strict";

/**
 * Local harness for the Netlify handler: serves public/ and routes /api/*
 * through lib/serverless.js with an in-memory Blobs stand-in.
 *
 *   node test/harness.js           # port 4180, passcode "demo123"
 *   HARNESS_PASSCODE= node ...     # no passcode
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHandler, createMemoryStore } = require("../lib/serverless");

const PORT = Number(process.env.HARNESS_PORT || 4180);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PASSCODE = process.env.HARNESS_PASSCODE === "" ? "" : (process.env.HARNESS_PASSCODE || "demo123");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

const handler = createHandler({ store: createMemoryStore(null), passcode: PASSCODE });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
    const event = {
      httpMethod: req.method,
      path: url.pathname,
      headers: req.headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body,
      isBase64Encoded: false
    };
    const result = await handler(event);
    res.writeHead(result.statusCode, result.headers || {});
    return res.end(result.body || "");
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Serverless harness on http://127.0.0.1:" + PORT + " (passcode: " + (PASSCODE || "none") + ")");
});
