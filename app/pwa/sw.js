/* eslint-env serviceworker */
// The web app's service worker. The build (pwa/vite-plugin.ts) fills in
// VERSION and PRECACHE, so every build is a new worker: the browser installs
// it in the background, and the app decides when to switch (see
// src/pwa/pwa.web.ts), never mid-session.
//
// Only the app itself is cached: the built files of this version. API
// requests, invite pages and anything else go to the network untouched; the
// app's data is end-to-end encrypted and lives in its own storage.
const VERSION = self.__VERSION__;
const PRECACHE = self.__PRECACHE__;
const CACHE = `superchat-app-${VERSION}`;
const SHELL = '/index.html';

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache =>
        cache.addAll(PRECACHE.map(url => new Request(url, {cache: 'reload'}))),
      ),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('superchat-app-') && key !== CACHE)
          await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

// Paths that belong to the server, not the app, if both share an origin.
const PASS = /^\/(v1\/|i\/|health$|\.well-known\/)/;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || PASS.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    // Opening the app: this version's shell, instantly and offline.
    event.respondWith(
      caches.match(SHELL, {cacheName: CACHE}).then(hit => hit || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches.match(req, {cacheName: CACHE}).then(hit => hit || fetch(req)),
  );
});
