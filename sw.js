const PREFIX = 'transitgap-';
const VERSION = `${PREFIX}v8`;
const BASE = new URL(self.registration.scope);
const files = [
  './', './index.html', './style.css', './mark.svg', './src/app.js', './src/map.js',
  './src/brief.js', './src/cities.js', './src/model.js', './src/audit.js',
  './src/interventions.js', './src/policy.js', './src/policyview.js',
  './src/selftest.js', './src/sha256.js', './src/coop.js'
].map(path => new URL(path, BASE).href);
const shell = { origin: BASE.origin, entries: new Set(files) };

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(files.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== VERSION).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== shell.origin || !shell.entries.has(`${url.origin}${url.pathname}`)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    return (await cache.match(`${url.origin}${url.pathname}`)) ?? fetch(event.request);
  })());
});
