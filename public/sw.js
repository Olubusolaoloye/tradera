"use strict";

/* Tradera service worker: makes the app installable and quick to open on
   phones, including on weak connections. API responses are never cached.

   - Versioned files (app.js?v=…, styles.css?v=…) never change, so they are
     served from the cache straight away.
   - The page itself is fetched fresh, but if the network takes longer than a
     few seconds the cached copy is shown instead of a blank screen.
   - Everything else (icons, fonts) is served from cache and refreshed behind
     the scenes. */

const VERSION = "2.6.0";
const CACHE = "tradera-shell-" + VERSION;
const SHELL = [
  "/",
  "/styles.css?v=" + VERSION,
  "/app.js?v=" + VERSION,
  "/manifest.webmanifest",
  "/icons/icon-192.svg",
  "/icons/icon-512.svg",
  "/icons/apple-touch-icon.png"
];
const NAV_TIMEOUT = 3500;

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (key) { return key !== CACHE; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function store(request, response) {
  if (response && (response.ok || response.type === "opaque")) {
    const copy = response.clone();
    caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
  }
  return response;
}

/** Network first, but give up waiting after NAV_TIMEOUT and use the cache. */
function pageRequest(request) {
  const network = fetch(request).then(function (response) {
    if (response && response.ok) store("/", response.clone());
    return response;
  });
  const fallback = new Promise(function (resolve) {
    setTimeout(function () {
      caches.match("/").then(function (hit) { if (hit) resolve(hit); });
    }, NAV_TIMEOUT);
  });
  return Promise.race([
    network.catch(function () {
      return caches.match("/").then(function (hit) { return hit || Response.error(); });
    }),
    fallback
  ]);
}

/** Cache first, refreshing the cached copy in the background. */
function staticRequest(request) {
  return caches.match(request).then(function (hit) {
    const network = fetch(request).then(function (response) { return store(request, response); });
    if (hit) {
      network.catch(function () { /* offline: the cached copy is enough */ });
      return hit;
    }
    return network;
  });
}

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== self.location.origin && !fonts) return;
  if (url.origin === self.location.origin && url.pathname.indexOf("/api/") === 0) return;

  if (request.mode === "navigate") {
    event.respondWith(pageRequest(request));
    return;
  }
  event.respondWith(staticRequest(request));
});
