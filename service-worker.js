/*
 * Service Worker — 利き酒手帖
 * アプリシェル (HTML/CSS/JS/アイコン/マスタ) をキャッシュしてオフラインでも開けるように。
 * 画像 (銘柄サムネ) は stale-while-revalidate。
 */

const VERSION = "v4";
const SHELL_CACHE = `shell-${VERSION}`;
const IMG_CACHE = `img-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/storage.js",
  "./js/github-api.js",
  "./js/app.js",
  "./manifest.json",
  "./icon.svg",
  "./data/master.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // GitHub API (records.json) は常にネットワーク優先、キャッシュしない
  if (url.hostname === "api.github.com") return;

  // ぽんしゅ館の画像は stale-while-revalidate
  if (url.hostname.includes("ponshukan.com")) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetched = fetch(req).then((resp) => {
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fetched;
      })
    );
    return;
  }

  // 自撮影した写真 (data/photos/) も stale-while-revalidate
  if (url.origin === location.origin && url.pathname.includes("/data/photos/")) {
    event.respondWith(
      caches.open(IMG_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const fetched = fetch(req).then((resp) => {
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || fetched;
      })
    );
    return;
  }

  // アプリシェルは cache first
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
        if (resp.ok && req.url.startsWith(location.origin)) {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      }).catch(() => caches.match("./index.html")))
    );
  }
});
