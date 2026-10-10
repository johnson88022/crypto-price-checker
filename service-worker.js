const CACHE_VERSION = "v4";
const CACHE_NAME = `crypto-price-checker-${CACHE_VERSION}`;

const APP_SHELL = [
    "./",
    "./index.html",
    "./app.js",
    "./style.css",
    "./manifest.webmanifest",
    "./icon.png",
    "./icon-192.png",
    "./icon-512.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key.startsWith("crypto-price-checker-") && key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;

    if (request.method !== "GET") return;

    const url = new URL(request.url);

    // Never cache third-party API responses.
    if (
        url.origin === "https://api.binance.com" ||
        url.origin === "https://www.okx.com" ||
        url.origin === "https://api.alternative.me"
    ) {
        return;
    }

    // App shell: network first, cache fallback. This keeps deployments fresh.
    if (url.origin === self.location.origin) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then((cached) => cached || caches.match("./index.html")))
        );
    }
});
