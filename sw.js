// Çentik service worker — sayfayı çevrimdışı açılabilir kılar.
// index.html'i güncellediğinde SURUM değerini artır.
const SURUM = "centik-v3";
const KABUK = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(KABUK)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== SURUM).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // E-tablo betiği: asla önbelleğe alma, doğrudan ağa git
  if (url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // Sayfanın kendisi: önce ağ (güncel sürüm gelsin), yoksa önbellek
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(r => { const k = r.clone(); caches.open(SURUM).then(c => c.put("./index.html", k)); return r; })
        .catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }

  // Yazı tipleri ve diğer dosyalar: önbellekten ver, arkada yenile
  if (url.origin === location.origin || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(req).then(hit => {
        const ag = fetch(req).then(r => {
          if (r && (r.ok || r.type === "opaque")) { const k = r.clone(); caches.open(SURUM).then(c => c.put(req, k)); }
          return r;
        }).catch(() => hit);
        return hit || ag;
      })
    );
  }
});
