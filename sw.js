// Çentik service worker — sayfayı çevrimdışı açılabilir kılar.
// v64: Bugün düğmesinde normal takvim + mavi sola dönüş oku.
const SURUM = "centik-v64-blue-return-arrow";
const KABUK = [
  "./",
  "./index.html",
  "./manifest.json",
  "./favicon.ico",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil((async()=>{
    const cache=await caches.open(SURUM);
    for(const url of KABUK){
      try{
        const r=await fetch(url,{cache:"reload"});
        if(r&&(r.ok||r.type==="opaque"))await cache.put(url,r.clone());
      }catch(err){}
    }
    await self.skipWaiting();
  })());
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

  // Apps Script / Google API yanıtları hiçbir koşulda SW cache'ine girmez.
  if (url.hostname.endsWith("google.com") || url.hostname.endsWith("googleusercontent.com")) return;

  // Uygulama navigasyonu: güncel HTML önce ağdan, ağ yoksa son sağlam cache.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req,{cache:"no-store"})
        .then(r => { const k = r.clone(); caches.open(SURUM).then(c => c.put("./index.html", k)); return r; })
        .catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }

  // Statik kabuk: cache'ten hızlı aç, arkada ağdan tazele.
  if (url.origin === location.origin || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(
      caches.match(req).then(hit => {
        const ag = fetch(req,{cache:"no-store"}).then(r => {
          if (r && (r.ok || r.type === "opaque")) { const k = r.clone(); caches.open(SURUM).then(c => c.put(req, k)); }
          return r;
        }).catch(() => hit);
        return hit || ag;
      })
    );
  }
});
