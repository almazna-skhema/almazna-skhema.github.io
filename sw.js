/* Работа без интернета: при первом открытии сайт целиком сохраняется на компьютере.
 * Страницы — сначала из сети (чтобы сразу видеть новую версию), без сети — сохранённые;
 * скрипты и стили — сохранённые (в их адресах номер версии, новая версия — новые адреса).
 * При выпуске новой версии меняется VERSION — старое сохранённое удаляется. */
'use strict';

const VERSION = 30;
const CACHE = 'almaz-' + VERSION;
const PAGES = ['./', 'index.html', 'canvas.html', 'symbols.html', 'compose.html'];
const ASSETS = [
  'css/style.css', 'js/i18n.js', 'js/palette-dmc.js', 'js/files.js', 'js/engine.js', 'js/render.js', 'js/app.js',
  'js/canvas-app.js', 'js/cmyk-lut.js', 'js/jpeg-edit.js', 'js/png-edit.js', 'js/layout-scan.js', 'js/scheme-import.js',
  'js/scheme-ocr.js', 'js/symbol-picker.js', 'js/symbols-app.js', 'js/compose-app.js', 'js/pwa.js'
].map(function (f) { return f + '?v=' + VERSION; });
const OTHER = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];
const WAIT_NET = 4000; // медленная сеть: столько ждём страницу, потом открываем сохранённую

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // мимо HTTP-кэша браузера — чтобы сохранить именно новую версию
    return c.addAll(PAGES.concat(ASSETS, OTHER).map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('almaz-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function put(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then(function (c) { return c.put(req, copy); });
  }
  return res;
}

function page(req) {
  const net = fetch(req).then(function (res) {
    // страница с ?r=… и без — одна и та же: храним без хвоста
    const u = new URL(req.url);
    u.search = '';
    return put(new Request(u.href), res);
  });
  const saved = caches.match(req, { ignoreSearch: true });
  return new Promise(function (resolve, reject) {
    let done = false;
    function fallback() {
      if (done) return;
      saved.then(function (r) { if (r && !done) { done = true; resolve(r); } });
    }
    const timer = setTimeout(fallback, WAIT_NET);
    net.then(function (res) { clearTimeout(timer); if (!done) { done = true; resolve(res); } })
      .catch(function () {
        clearTimeout(timer);
        saved.then(function (r) {
          if (done) return;
          done = true;
          if (r) resolve(r);
          else caches.match('index.html').then(function (i) { if (i) resolve(i); else reject(new Error('offline')); });
        });
      });
  });
}

function asset(req) {
  return caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) { return put(req, res); });
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(req.mode === 'navigate' ? page(req) : asset(req));
});
