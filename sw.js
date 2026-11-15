// 서비스 워커: 앱 셸 캐시(오프라인 계산), 공유 대상(Share Target) 처리
const VERSION = 'cc-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './style.css',
  './src/app.js', './src/complex.js', './src/parser.js', './src/evaluator.js', './src/solve.js',
  './src/format.js', './src/session.js', './src/recognizer.js', './src/settings.js', './src/storage.js', './src/imageutil.js',
  './vendor/katex/katex.min.js', './vendor/katex/katex.min.css',
  './icons/icon-192.png', './icons/icon-512.png',
];
const SHARED_CACHE = 'cc-shared';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== SHARED_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function handleShare(request) {
  try {
    const form = await request.formData();
    let file = form.get('image');
    if (!file) for (const [, v] of form.entries()) if (v instanceof File) { file = v; break; }
    if (file && file.size) {
      const cache = await caches.open(SHARED_CACHE);
      await cache.put('./shared-image', new Response(file, { headers: { 'content-type': file.type || 'image/png', 'x-name': encodeURIComponent(file.name || '') } }));
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    }
  } catch (err) { /* 아래에서 오류 표시로 이동 */ }
  return Response.redirect(new URL('./?shared=error', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(network); return hit; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) ?? Response.error();
    return Response.error();
  })());
});
