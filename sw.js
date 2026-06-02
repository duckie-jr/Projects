const CACHE_NAME = "github-projects-v1";

// Static shell assets to pre-cache on install
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/main.js",
  "/manifest.json",
];

// ── Install: pre-cache the app shell ────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete stale caches ───────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((staleCacheName) => caches.delete(staleCacheName))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for assets ────
self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);

  // Always go network-first for GitHub API calls so data stays fresh
  if (requestUrl.hostname === "api.github.com") {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ message: "You are offline. GitHub API unavailable." }),
          { headers: { "Content-Type": "application/json" }, status: 503 }
        )
      )
    );
    return;
  }

  // Cache-first for everything else (app shell)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        // Only cache same-origin GET responses
        if (
          event.request.method === "GET" &&
          requestUrl.origin === self.location.origin
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
