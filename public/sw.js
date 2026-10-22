/**
 * Fiala's web service worker: makes the app open on a cold start while
 * offline; without it the browser has no assets cached and shows a blank page.
 *
 * Strategy, chosen to NEVER serve stale app code:
 *   - Navigations (HTML): network-first, fall back to the cached shell only
 *     when offline. Online always gets the freshly deployed HTML, so OTA-style
 *     Pages deploys land immediately.
 *   - Same-origin files Expo names by their content (`hashed`): cache-first.
 *     A new build has new names, so the cache can't shadow an update.
 *   - Every other same-origin file (favicon, icons, manifest, social card):
 *     network-first, the cache only offline. Their names never change, so
 *     cache-first kept the first copy forever.
 *   - Cross-origin (Supabase, a product page's picture): never intercepted or cached.
 */
// Bump the version when the strategy changes; `activate` drops this app's other caches.
// v2 drops the icons v1 cached for good.
const CACHE = "fiala-v2";
// Absolute so the offline fallback matches regardless of the navigated path
// (a relative "./index.html" resolved against the request, not the shell).
const SHELL = "/fiala/index.html";

// Code takes new names every deploy, so it piles up and is capped. Pictures
// and fonts keep their content hash across deploys, and the catalogue alone
// holds 133 pictures: counted with the code, they emptied the cache on every
// online start, and a picture not drawn again was missing from its tile offline.
const CODE_CAP = 120;
const MEDIA_CAP = 400;
const MEDIA = /\.(webp|png|jpe?g|svg|ttf|otf|woff2?)$/i;

/** A path a build names by its content, which can be served from the cache without asking. */
function hashed(path) {
  return path.includes("/_expo/static/") || /\.[0-9a-f]{32}\.[a-z0-9]+$/i.test(path);
}

/** The cached paths to drop: each kind whole, once it passes its own cap. */
function prunable(paths) {
  const kept = paths.filter((path) => path !== SHELL);
  const media = kept.filter((path) => MEDIA.test(path));
  const code = kept.filter((path) => !MEDIA.test(path));
  return [...(code.length > CODE_CAP ? code : []), ...(media.length > MEDIA_CAP ? media : [])];
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Helix shares this origin and its cache storage; only touch our own prefix.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("fiala-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin to the network

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
          // A navigation can target any URL under the service-worker scope,
          // including a public JS/image asset. Never let that response replace
          // the offline HTML shell and persistently break the next cold start.
          if (res.ok && contentType.startsWith("text/html")) {
            caches
              .open(CACHE)
              .then(async (cache) => {
                await cache.put(SHELL, res.clone());
                // Prune (`prunable`): old builds' code is never requested again,
                // so without a cap the cache grows by one build per deploy. We
                // are online right now (this navigation fetch succeeded), so
                // dropping it is safe — live files re-cache on their next request.
                const keys = await cache.keys();
                const stale = new Set(prunable(keys.map((cached) => new URL(cached.url).pathname)));
                await Promise.all(keys.filter((cached) => stale.has(new URL(cached.url).pathname)).map((cached) => cache.delete(cached)));
              })
              .catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(SHELL)) ||
            (await cache.match(req, { ignoreSearch: true })) ||
            new Response("<!doctype html><meta charset=utf-8><title>Fiala</title>", { headers: { "Content-Type": "text/html" } })
          );
        }),
    );
    return;
  }

  if (!hashed(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached),
    ),
  );
});
