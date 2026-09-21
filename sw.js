/* 通学中など、通信の届かない場所でも開けるようにする。
   データそのものは IndexedDB にあるので、ここでキャッシュするのは
   アプリの外枠（HTML/JS/CSS/アイコン）だけでよい。

   ファイルを直したら、必ず下の版を1つ上げること。
   上げ忘れると、古いコードが端末に貼りついたまま入れ替わらない。 */
const VERSION = 'v2';
const CACHE = `memocard-${VERSION}`;

const CORE = [
  './',
  './index.html',
  './app.js',
  './db.js',
  './srs.js',
  './map.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(CORE.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
