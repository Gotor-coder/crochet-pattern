// 오프라인 실행용 서비스 워커: 앱 파일을 저장해 두고 인터넷 없이도 열리게 함.
// 앱 파일을 고치면 CACHE_VERSION 숫자를 올려야 폰에 새 버전이 반영됨.
const CACHE_VERSION = 'crochet-v2';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/gauge.js',
  './js/quantize.js',
  './js/pattern.js',
  './js/render.js',
  './js/app.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크 우선(최신 버전), 실패하면 저장본 사용(오프라인)
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })),
  );
});
