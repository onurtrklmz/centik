// v94-ui-r47: KeyboardCore + bağımsız Main/Utility policies; utility r41, main r44 davranışı.
// v94: Beni Dürt push bildirimi eklendi; mevcut PWA/offline kabuğu korunur.
// Çentik service worker — sayfayı çevrimdışı açılabilir kılar.
// v78: Takvim/Çakılı/Çetele boş yüzeyden aşağı çekilerek kapanabilir; Çetele editörü tam görünüm için kompaktlaştırıldı.
const SURUM = "centik-v95-r57-keyboard-fix";
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


// V94 — Beni Dürt: FCM veri mesajlarını mevcut service worker üzerinden göster.
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { try { payload = { data: { body: event.data ? event.data.text() : "" } }; } catch (_) {} }
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const notification = payload && payload.notification && typeof payload.notification === "object" ? payload.notification : {};
  const title = data.title || notification.title || "Çentik — Beni Dürt";
  const body = data.body || notification.body || "";
  const url = data.url || "./";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "./icon-192.png",
    badge: "./favicon-32.png",
    tag: data.tag || "centik-beni-durt",
    renotify: false,
    data: { url }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async()=>{
    const clientsList = await self.clients.matchAll({ type:"window", includeUncontrolled:true });
    for (const client of clientsList) {
      try { await client.navigate(target); await client.focus(); return; } catch (e) { try { await client.focus(); return; } catch (_) {} }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});