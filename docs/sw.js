// オフラインでも開けるようにするキャッシュ（HTTPS または localhost で有効）
const V = "keiba-v2";
const SHELL = ["./", "index.html", "three.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.pathname === "/api/status" || u.host === "api.github.com") return;   // 接続確認・GitHubへの依頼は常にネットワーク
  const cacheable = u.origin === location.origin || /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (!cacheable) return;
  // ネットワーク優先・失敗したら最後に取れたもの
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok){ const c = r.clone(); const key = u.search && u.origin === location.origin ? u.origin + u.pathname : e.request;   // ?t=… は付けずに1件だけ保存
      caches.open(V).then(x => x.put(key, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
