"use strict";

/* Tradera service worker: makes the app installable and quick to open on
   phones, including on weak connections. API responses are never cached.

   - Versioned files (app.js?v=…, styles.css?v=…) never change, so they are
     served from the cache straight away.
   - The page itself is fetched fresh, but if the network takes longer than a
     few seconds the cached copy is shown instead of a blank screen.
   - Everything else (icons, fonts) is served from cache and refreshed behind
     the scenes. */

const VERSION = "3.5.0";
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
  // The admin dashboard is never cached or served offline.
  if (url.origin === self.location.origin && url.pathname.indexOf("/admin") === 0) return;

  if (request.mode === "navigate") {
    event.respondWith(pageRequest(request));
    return;
  }
  event.respondWith(staticRequest(request));
});

/* ------------------------------------------------- Tradera notifications
   Alerts sent by the Tradera server arrive here even when the app is
   closed, and are shown as normal phone notifications. */

self.addEventListener("push", function (event) {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data ? event.data.text() : "" }; }
  const urgent = !!d.urgent;
  event.waitUntil(self.registration.showNotification(d.title || "Tradera", {
    body: d.body || "",
    tag: d.tag || "tradera",
    renotify: true,                        // every repeat sounds and vibrates again
    requireInteraction: urgent,            // urgent alerts stay on screen until handled
    silent: false,
    icon: "/icons/icon-192.png",
    badge: "/icons/apple-touch-icon.png",
    vibrate: urgent ? [600, 200, 600, 200, 600, 200, 1200, 300, 600, 200, 600] : [160],
    timestamp: d.at || Date.now(),
    actions: d.ack ? [{ action: "stop", title: "Stop alerts" }, { action: "open", title: "Open Tradera" }] : [],
    data: { url: d.url || "/", ack: d.ack || null }
  }));
});

/** Tell Tradera to stop re-ringing this alert. */
function stopRinging(notification) {
  const ack = notification.data && notification.data.ack;
  if (!ack) return Promise.resolve();
  return fetch("/api/push/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ack),
    keepalive: true
  }).catch(function () { /* the app stops it when opened */ });
}

/* Swiping an urgent alert away also stops the ringing. */
self.addEventListener("notificationclose", function (event) {
  event.waitUntil(stopRinging(event.notification));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const stop = stopRinging(event.notification);
  if (event.action === "stop") { event.waitUntil(stop); return; }
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (const client of list) {
        if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
          return client.focus().then(function (c) { return c && "navigate" in c ? c.navigate(target) : c; });
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

/* A browser can rotate the notification address; keep the server in step.
   The new address is sent next time the app opens (it needs the login). */
self.addEventListener("pushsubscriptionchange", function () { /* handled by the app on next open */ });
