const CACHE_VERSION = "v11";
const CACHE_NAME = `crypto-price-checker-${CACHE_VERSION}`;
const APP_SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest", "./icon.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("crypto-price-checker-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    // Never cache API responses or third-party market data.
    if (url.pathname.startsWith("/api/") || ["https://api.binance.com", "https://www.okx.com", "https://api.alternative.me", "https://api.coingecko.com"].includes(url.origin)) return;
    if (url.origin === self.location.origin) event.respondWith(fetch(request).then(response => {
        if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(request, copy)); }
        return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match("./index.html"))));
});
self.addEventListener('push', event => {
    let payload = { title: 'Crypto Price Checker', body: '有新的市場訊號。', url: '/' };
    try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch { try { payload.body = event.data.text(); } catch {} }
    event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, icon: './icon-192.png', badge: './icon-192.png', tag: payload.tag || undefined, renotify: false, data: { url: payload.url || '/' } }));
});
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        const existing = clients.find(client => client.url.startsWith(self.location.origin));
        if (existing) return existing.focus();
        return self.clients.openWindow(target);
    }));
});
