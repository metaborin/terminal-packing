/* Bump APP_VERSION whenever the app shell changes. User records are in IndexedDB. */
const APP_VERSION = '1.6.0';
const SCOPE = self.registration.scope;
const SCOPE_URL = new URL(SCOPE);
const CACHE_PREFIX = `terminal-packing:${encodeURIComponent(SCOPE_URL.pathname)}:`;
const SHELL_PREFIX = `${CACHE_PREFIX}shell:`;
const SHELL_CACHE = `${SHELL_PREFIX}${APP_VERSION}`;
// Bump this only when OCR code/models change; app updates retain the large downloads.
const OCR_CACHE = `${CACHE_PREFIX}ocr:1`;
const SHELL = [
  './', './index.html', './style.css', './app.js', './core.js', './ocr.js', './scan-consensus.js', './pwa.js',
  './manifest.webmanifest', './icon.svg', './icon-180.png', './icon-192.png',
  './icon-512.png', './licenses.html',
];
const OCR = [
  './vendor/tesseract.esm.min.js', './vendor/worker.min.js',
  './vendor/core/tesseract-core-lstm.wasm.js',
  './vendor/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/core/tesseract-core-relaxedsimd-lstm.wasm.js',
  './vendor/lang/eng.traineddata.gz',
];
const urlFor = path => new URL(path, SCOPE).href;
const shellURLs = new Set(SHELL.map(urlFor));
const ocrURLs = new Set(OCR.map(urlFor));
const rootURL = urlFor('./');
const indexURL = urlFor('./index.html');
let preparation = null;
const progressPorts = new Set();

function validResponse(response, url) {
  if (!response || !response.ok || response.type === 'opaque' || response.redirected) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  const path = new URL(url).pathname;
  if (path.endsWith('.js')) return /(?:java|ecma)script/.test(type);
  if (path.endsWith('.css')) return type.includes('text/css');
  if (path.endsWith('.png')) return type.includes('image/png');
  if (path.endsWith('.svg')) return type.includes('image/svg+xml');
  if (path.endsWith('.webmanifest')) return /json|manifest/.test(type);
  if (url === rootURL || path.endsWith('.html')) return type.includes('text/html');
  return !type.includes('text/html');
}

async function fetchIntoCache(url, cacheName, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new Request(url, {
      credentials: 'same-origin', cache: 'reload', signal: controller.signal,
    }));
    if (!validResponse(response, url) || new URL(response.url).origin !== SCOPE_URL.origin) {
      throw new Error('読み取り用ファイルを取得できませんでした。通信状態を確認して、もう一度お試しください。');
    }
    const cache = await caches.open(cacheName);
    // Wait for the entire body to be saved before claiming readiness.
    await cache.put(url, response.clone());
    return response;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('準備に時間がかかっています。通信できる場所で、もう一度お試しください。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheHasAll(cacheName, urls) {
  if (!(await caches.has(cacheName))) return false;
  const cache = await caches.open(cacheName);
  const present = await Promise.all([...urls].map(async url => validResponse(await cache.match(url), url)));
  return present.every(Boolean);
}

async function getStatus() {
  const [shellReady, ocrReady] = await Promise.all([
    cacheHasAll(SHELL_CACHE, shellURLs), cacheHasAll(OCR_CACHE, ocrURLs),
  ]);
  return { version: APP_VERSION, shellReady, ocrReady };
}

self.addEventListener('install', event => {
  // A rejected install cannot replace an already working service worker.
  // A new worker waits until its update is accepted or every old window closes.
  event.waitUntil(Promise.all([...shellURLs].map(url => fetchIntoCache(url, SHELL_CACHE))));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE).map(name => caches.delete(name)));
    // Do not touch the unscoped legacy cache or other apps' caches/databases.
    await self.clients.claim();
  })());
});

function post(port, message) {
  if (!port) return;
  try { port.postMessage(message); } catch { progressPorts.delete(port); }
}

async function prepareOffline() {
  const entries = [...shellURLs].map(url => [url, SHELL_CACHE]).concat([...ocrURLs].map(url => [url, OCR_CACHE]));
  const deadline = Date.now() + 170000;
  for (let i = 0; i < entries.length; i++) {
    const [url, cacheName] = entries[i];
    for (const port of progressPorts) post(port, { progress: `準備中… ${i + 1} / ${entries.length}（約14MB）` });
    const cache = await caches.open(cacheName);
    if (validResponse(await cache.match(url), url)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('準備を完了できませんでした。通信状態を確認して、もう一度お試しください。');
    await fetchIntoCache(url, cacheName, Math.min(30000, remaining));
  }
  const status = await getStatus();
  if (!status.shellReady || !status.ocrReady) throw new Error('一部の読み取りデータを保存できませんでした。空き容量を確認して、もう一度お試しください。');
  return status;
}

self.addEventListener('message', event => {
  const port = event.ports?.[0];
  if (event.data?.type === 'GET_STATUS') {
    event.waitUntil(getStatus().then(status => post(port, status)).catch(error => post(port, { error: error.message })));
  } else if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting().then(() => post(port, { done: true, version: APP_VERSION })));
  } else if (event.data?.type === 'PREPARE_OFFLINE') {
    if (port) progressPorts.add(port);
    if (!preparation) preparation = prepareOffline().finally(() => { preparation = null; });
    event.waitUntil(preparation.then(status => post(port, { done: true, ...status }))
      .catch(error => post(port, { error: error.message }))
      .finally(() => progressPorts.delete(port)));
  }
});

function requestedAsset(request) {
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin) return null;
  url.hash = '';
  url.search = '';
  // Query strings must not prevent an installed app from opening offline.
  if (request.mode === 'navigate' && (url.href === rootURL || url.href === indexURL)) {
    return { url: rootURL, cacheName: SHELL_CACHE, navigation: true };
  }
  if (shellURLs.has(url.href)) return { url: url.href, cacheName: SHELL_CACHE };
  if (ocrURLs.has(url.href)) return { url: url.href, cacheName: OCR_CACHE };
  return null;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const asset = requestedAsset(event.request);
  if (!asset) return;
  event.respondWith((async () => {
    const cache = await caches.open(asset.cacheName);
    const cached = await cache.match(asset.url);
    if (validResponse(cached, asset.url)) return cached;
    try {
      return await fetchIntoCache(asset.url, asset.cacheName);
    } catch {
      const message = asset.navigation
        ? 'アプリをオフラインで開く準備ができていません。通信できる場所で一度開いてください。'
        : '必要なファイルを取得できません。通信できる場所でアプリの準備を行ってください。';
      return new Response(message, { status: 503, headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' } });
    }
  })());
});
