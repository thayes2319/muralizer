// ============================================================
// Atmos Studio — Service Worker (v1)
// Cache-first shell, network-first for generated images
// ============================================================

const CACHE_NAME = "atmos-studio-v1";

// Add any files your app needs to load offline
const ASSETS = [
  "/",
  "/muralizer-manifest.json",
  "/styles.css",
  "/script.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png"
];

// ------------------------------------------------------------
// INSTALL — Cache the app shell
// ------------------------------------------------------------
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// ------------------------------------------------------------
// ACTIVATE — Clean up old caches
// ------------------------------------------------------------
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
});

// ------------------------------------------------------------
// FETCH — Cache-first for shell, network-first for images
// ------------------------------------------------------------
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Network-first for generated images (so you always get fresh output)
  if (url.pathname.includes("/generate")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(event.request).then(cached => {
      return (
        cached ||
        fetch(event.request).then(response => {
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
      );
    })
  );
});

