/* Раздел «Фото на холсте»: макет для печати картины или постера из одного фото или коллажа.
 * Кадр каждого фото, раскладка с промежутками и полями, художественные эффекты, свет и цвет,
 * надписи, торцы подрамника, примерка на стене, файл CMYK или RGB, превью для заказчика, проект. */
(function (A) {
  'use strict';

  const T = A.T, CL = A.collage, TX = A.canvasText;
  const FX = function () { return A.canvasFx; }; // модуль эффектов может не загрузиться — тогда без эффектов
  const ASSET_VERSION = 32; // тот же номер, что в адресах скриптов в canvas.html
  const VERSION = T('версия') + ' 32 · 17.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  // телефоны и планшеты не держат большие холсты в памяти — там пределы скромнее
  const COARSE = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const MAX_SOURCE = COARSE ? 12e6 : 40e6;      // рабочая копия одного фото, точек
  const SOURCE_BUDGET = COARSE ? 30e6 : 110e6;  // все фото коллажа вместе
  const MAX_OUT = COARSE ? 16e6 : 90e6;         // предел размера файла для печати, точек
  const MAX_SIDE = 16000;
  const MAX_PHOTOS = 20;
  const SAVED = ['wCm', 'hCm', 'wrap', 'wrapMode', 'wrapColor', 'colorMode', 'gap', 'margin', 'radius', 'bgColor'];
  const ADJUST = ['brightness', 'contrast', 'saturation', 'warmth', 'sharp', 'vignette'];
  const STEP_NAMES = { 1: 'Фото', 2: 'Размер', 3: 'Коллаж', 4: 'Эффекты', 5: 'Текст', 6: 'Файл' };
  const LAST = 6;
  const state = {
    photos: [], sel: 0, tpl: '', texts: [], tsel: -1, effect: 'none', tab: 'layout', step: 1, busy: false, dirty: false,
    view: null, overlay: null, ppc: 1, lay: null, nextId: 1, snap: null
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function release(cv) { if (cv && cv.getContext) cv.width = cv.height = 0; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function num(v) { return String(Math.round(v * 10) / 10).replace('.', ','); }
  function setStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', kind === 'error');
    s.classList.toggle('ok', kind === 'ok');
  }
  function touch() { state.dirty = true; }

  // ---------- настройки ----------
  function params() {
    const def = (FX() && FX().EFFECTS || []).find(function (e) { return e.id === state.effect; });
    return {
      w: clamp(parseFloat($('wCm').value) || 50, 5, 300), h: clamp(parseFloat($('hCm').value) || 40, 5, 300),
      wrap: clamp(parseFloat(String($('wrap').value).replace(',', '.')) || 0, 0, 10),
      wrapMode: $('wrapMode').value, wrapColor: $('wrapColor').value,
      gap: clamp(+$('gap').value || 0, 0, 200) / 10, margin: clamp(+$('margin').value || 0, 0, 300) / 10,
      radius: clamp(+$('radius').value || 0, 0, 200) / 10, bg: $('bgColor').value,
      effect: def ? state.effect : 'none', fxSize: +$('fxSize').value, fxRelief: +$('fxRelief').value, fxAmount: +$('fxAmount').value,
      auto: $('autoLevel').checked, brightness: +$('brightness').value, contrast: +$('contrast').value, saturation: +$('saturation').value,
      warmth: +$('warmth').value, sharp: +$('sharp').value, vignette: +$('vignette').value, tone: $('tone').value,
      order: $('order').value.trim(), colorMode: $('colorMode').value
    };
  }

  function saveSettings() {
    try {
      const o = {};
      SAVED.forEach(function (id) { o[id] = $(id).value; });
      localStorage.setItem('almaz-canvas', JSON.stringify(o));
    } catch (e) { /* хранилище недоступно */ }
  }

  function loadSettings() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-canvas') || 'null');
      if (o && typeof o === 'object') SAVED.forEach(function (id) { if (typeof o[id] === 'string') $(id).value = o[id]; });
    } catch (e) { /* игнорируем */ }
  }

  function syncOutputs() {
    ['brightness', 'contrast', 'saturation', 'warmth', 'sharp', 'vignette', 'gap', 'margin', 'radius', 'fxRelief', 'fxAmount'].forEach(function (id) { $(id + 'Out').textContent = $(id).value; });
    $('fxSizeOut').textContent = num(+$('fxSize').value);
    $('zoomOut').textContent = $('zoom').value + '%';
    $('wrapColorRow').hidden = $('wrapMode').value !== 'color';
    const w = +$('wCm').value, h = +$('hCm').value, key = Math.min(w, h) + 'x' + Math.max(w, h), preset = $('sizePreset');
    preset.value = Array.prototype.some.call(preset.options, function (o) { return o.value === key; }) ? key : 'custom';
    const p = params();
    $('wrapNote').hidden = !(p.wrapMode === 'extend' && (state.photos.length > 1 || p.margin > 0));
  }

  // ---------- фото ----------
  function photoBudget(n) { return Math.min(MAX_SOURCE, Math.max(6e6, SOURCE_BUDGET / Math.max(1, n))); }

  /* Рабочая копия фото с поворотом и отражением + уменьшенная для экрана. */
  function rebuildSource(ph, budget) {
    const raw = ph.raw, iw = raw.naturalWidth, ih = raw.naturalHeight;
    const k = Math.min(1, Math.sqrt((budget || photoBudget(state.photos.length)) / (iw * ih)));
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k)), turned = ph.rot % 180 !== 0;
    const cv = A.makeCanvas(turned ? h : w, turned ? w : h), x = cv.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cv.width, cv.height);
    x.translate(cv.width / 2, cv.height / 2);
    x.rotate((ph.rot * Math.PI) / 180);
    x.scale(ph.flipX ? -1 : 1, ph.flipY ? -1 : 1);
    x.drawImage(raw, -w / 2, -h / 2, w, h);
    release(ph.src);
    ph.src = cv;
    // для экрана — уменьшенная копия: кадр двигается плавно даже с очень большим фото
    const side = state.photos.length > 4 ? 1200 : 1800, sk = Math.min(1, side / Math.max(cv.width, cv.height));
    release(ph.small);
    ph.small = sk < 1 ? A.downscale(cv, { x: 0, y: 0, w: cv.width, h: cv.height }, Math.max(1, Math.round(cv.width * sk)), Math.max(1, Math.round(cv.height * sk))) : null;
    ph.ver = (ph.ver || 0) + 1;
    ph.levels = null;
    ph.thumb = null;
  }

  function thumbUrl(ph) {
    if (ph.thumb) return ph.thumb;
    const s = ph.small || ph.src, k = Math.min(1, 160 / Math.max(s.width, s.height));
    const t = A.downscale(s, { x: 0, y: 0, w: s.width, h: s.height }, Math.max(1, Math.round(s.width * k)), Math.max(1, Math.round(s.height * k)));
    ph.thumb = t.toDataURL('image/jpeg', 0.8);
    release(t);
    return ph.thumb;
  }

  /* Автокоррекция: края гистограммы каждого канала растягиваем на весь диапазон (с ограничением). */
  function levelsOf(ph) {
    if (ph.levels) return ph.levels;
    const s = ph.small || ph.src, k = Math.min(1, 400 / Math.max(s.width, s.height));
    const t = A.downscale(s, { x: 0, y: 0, w: s.width, h: s.height }, Math.max(1, Math.round(s.width * k)), Math.max(1, Math.round(s.height * k)));
    const d = t.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, t.width, t.height).data;
    release(t);
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; }
    ph.levels = hist.map(function (h) {
      let lo = 0, hi = 255, acc = 0;
      for (; lo < 255; lo++) { acc += h[lo]; if (acc > n * 0.004) break; }
      acc = 0;
      for (; hi > 0; hi--) { acc += h[hi]; if (acc > n * 0.004) break; }
      if (hi - lo < 40) return { lo: 0, k: 1 };
      return { lo: lo, k: Math.min(2.2, 255 / (hi - lo)) };
    });
    return ph.levels;
  }

  // ---------- раскладка ----------
  /* Вся площадь печати (лицо + торцы), лицевая часть и клетки фото — в сантиметрах. */
  function layoutOf(p) {
    const n = Math.max(1, state.photos.length), total = { w: p.w + 2 * p.wrap, h: p.h + 2 * p.wrap };
    const face = { x: p.wrap, y: p.wrap, w: p.w, h: p.h };
    const extend = n === 1 && p.margin === 0 && p.wrapMode === 'extend' && p.wrap > 0;
    const tpl = CL.find(n, state.tpl, p.w / p.h);
    const cells = extend ? [{ x: 0, y: 0, w: total.w, h: total.h }] : CL.rects(tpl, face, p.margin, p.gap);
    return { total: total, face: face, cells: cells, tpl: tpl, extend: extend, wrapMode: p.wrapMode === 'extend' && !extend ? 'mirror' : p.wrapMode };
  }

  /* Какая часть фото попадает в клетку (в точках того холста, что передан: полного или уменьшенного). */
  function cropOf(ph, cell, sw, sh) {
    const aspect = cell.w / cell.h;
    let cw = sw, ch = cw / aspect;
    if (ch > sh) { ch = sh; cw = ch * aspect; }
    cw /= ph.zoom; ch /= ph.zoom;
    return { x: (sw - cw) * ph.fx, y: (sh - ch) * ph.fy, w: cw, h: ch };
  }

  /* Кусок фото под клетку размером W × H точек (+ автокоррекция). */
  function cellBase(ph, cell, W, H, small, p) {
    const src = small && ph.small ? ph.small : ph.src, c = cropOf(ph, cell, src.width, src.height);
    let cv;
    if (c.w > W * 2 && c.h > H * 2) cv = A.downscale(src, c, W, H);
    else {
      cv = A.makeCanvas(W, H);
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, c.x, c.y, c.w, c.h, 0, 0, W, H);
    }
    if (p.auto) autoLevels(cv, levelsOf(ph));
    return cv;
  }

  function bands(cv, fn) {
    const x = cv.getContext('2d', { willReadFrequently: true });
    for (let y0 = 0; y0 < cv.height; y0 += 256) {
      const rows = Math.min(256, cv.height - y0), im = x.getImageData(0, y0, cv.width, rows);
      fn(im.data, y0, rows);
      x.putImageData(im, 0, y0);
    }
  }

  function autoLevels(cv, lv) {
    if (lv.every(function (l) { return l.k === 1 && !l.lo; })) return;
    const lut = lv.map(function (l) { const t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) t[v] = (v - l.lo) * l.k; return t; });
    bands(cv, function (d) { for (let i = 0; i < d.length; i += 4) { d[i] = lut[0][d[i]]; d[i + 1] = lut[1][d[i + 1]]; d[i + 2] = lut[2][d[i + 2]]; } });
  }

  /* Размытие яркости коробкой радиуса r (два прохода — мягко) — для резкости. */
  function boxBlur(src, W, H, r) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), d = 2 * r + 1;
    for (let pass = 0; pass < 2; pass++) {
      const a = pass ? out : src;
      for (let y = 0; y < H; y++) {
        const o = y * W;
        let s = 0;
        for (let i = -r; i <= r; i++) s += a[o + clamp(i, 0, W - 1)];
        for (let x = 0; x < W; x++) {
          tmp[o + x] = s / d;
          s += a[o + Math.min(W - 1, x + r + 1)] - a[o + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += tmp[clamp(i, 0, H - 1) * W + x];
        for (let y = 0; y < H; y++) {
          out[y * W + x] = s / d;
          s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
        }
      }
    }
    return out;
  }

  function adjustKey(p) { return [p.brightness, p.contrast, p.saturation, p.warmth, p.sharp, p.vignette, p.tone].join(','); }
  function needsAdjust(p) { return ADJUST.some(function (k) { return p[k]; }) || p.tone !== 'color'; }

  /* Свет, цвет, тон, резкость и виньетка — по точкам; ppc нужен, чтобы резкость была одинаковой на экране и в файле. */
  function adjust(cv, p, ppc) {
    if (!needsAdjust(p)) return;
    const W = cv.width, H = cv.height, br = p.brightness * 1.1, c = p.contrast * 1.2, cf = (259 * (c + 255)) / (255 * (259 - c));
    const sf = 1 + p.saturation / 100, wm = p.warmth * 0.5, vg = (p.vignette / 100) * 0.62;
    let L = null, B = null, k = 0;
    if (p.sharp > 0) {
      L = new Uint8Array(W * H);
      bands(cv, function (d, y0) { for (let i = 0, j = y0 * W; i < d.length; i += 4, j++) L[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; });
      B = boxBlur(L, W, H, Math.max(1, Math.round(ppc * 0.025))); // 0,25 мм
      k = p.sharp / 45;
    }
    const cx = W / 2, cy = H / 2, inv = 1 / Math.hypot(cx, cy);
    bands(cv, function (d, y0, rows) {
      for (let yy = 0, i = 0; yy < rows; yy++) {
        const y = y0 + yy, dy2 = (y - cy) * (y - cy);
        for (let x = 0; x < W; x++, i += 4) {
          let r = d[i], g = d[i + 1], b = d[i + 2];
          if (L) { const j = y * W + x, dl = k * (L[j] - B[j]); r += dl; g += dl; b += dl; }
          r = cf * (r + br - 128) + 128; g = cf * (g + br - 128) + 128; b = cf * (b + br - 128) + 128;
          r += wm; b -= wm;
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          r = gray + (r - gray) * sf; g = gray + (g - gray) * sf; b = gray + (b - gray) * sf;
          if (p.tone === 'bw') r = g = b = gray;
          else if (p.tone === 'sepia' || p.tone === 'vintage') {
            const R = 0.393 * r + 0.769 * g + 0.189 * b, G = 0.349 * r + 0.686 * g + 0.168 * b, Bb = 0.272 * r + 0.534 * g + 0.131 * b;
            if (p.tone === 'sepia') { r = R; g = G; b = Bb; } else { // винтаж: лёгкая сепия, поднятые тени, тёплый оттенок
              r = (r * 0.6 + R * 0.4) * 0.86 + 26; g = (g * 0.6 + G * 0.4) * 0.86 + 20; b = (b * 0.6 + Bb * 0.4) * 0.84 + 14;
            }
          }
          if (vg) {
            const t = clamp((Math.sqrt((x - cx) * (x - cx) + dy2) * inv - 0.42) / 0.58, 0, 1), f = 1 - vg * t * t * (3 - 2 * t);
            r *= f; g *= f; b *= f;
          }
          d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray сам обрежет до 0…255
        }
      }
    });
  }

  function fxKey(p) { return [p.effect, p.fxSize, p.fxRelief, p.fxAmount].join(','); }
  function seedOf(ph) { return (ph.id * 7919) % 100003; }

  function clipCell(x, r, rad) {
    if (rad > 0) { TX.roundRect(x, r.x, r.y, r.w, r.h, rad); x.clip(); }
  }

  /* Поля на торцах: цвет или зеркало края лицевой стороны. */
  function wraps(x, W, H, wr, mode, color) {
    if (!wr) return;
    const fw = W - 2 * wr, fh = H - 2 * wr, cv = x.canvas;
    if (mode === 'color') {
      x.fillStyle = color;
      x.fillRect(0, 0, W, wr); x.fillRect(0, H - wr, W, wr); x.fillRect(0, wr, wr, fh); x.fillRect(W - wr, wr, wr, fh);
    } else if (mode === 'mirror') {
      // сначала боковые торцы, потом верх и низ во всю ширину — так сами собой заполняются углы
      x.save(); x.translate(2 * wr, 0); x.scale(-1, 1); x.drawImage(cv, wr, wr, wr, fh, wr, wr, wr, fh); x.restore();
      x.save(); x.translate(2 * (W - wr), 0); x.scale(-1, 1); x.drawImage(cv, W - 2 * wr, wr, wr, fh, W - 2 * wr, wr, wr, fh); x.restore();
      x.save(); x.translate(0, 2 * wr); x.scale(1, -1); x.drawImage(cv, 0, wr, W, wr, 0, wr, W, wr); x.restore();
      x.save(); x.translate(0, 2 * (H - wr)); x.scale(1, -1); x.drawImage(cv, 0, H - 2 * wr, W, wr, 0, H - 2 * wr, W, wr); x.restore();
    }
  }

  /* Пиксельные прямоугольники клеток при ppc точек на сантиметр (края — по целым точкам). */
  function cellPx(cell, ppc) {
    const x0 = Math.round(cell.x * ppc), y0 = Math.round(cell.y * ppc), x1 = Math.round((cell.x + cell.w) * ppc), y1 = Math.round((cell.y + cell.h) * ppc);
    return { x: x0, y: y0, w: Math.max(2, x1 - x0), h: Math.max(2, y1 - y0) };
  }

  /* Собрать макет: фон, фото (getCell даёт готовый кусок клетки), торцы, надписи. */
  async function compose(p, lay, ppc, getCell, target) {
    const W = Math.max(8, Math.round(lay.total.w * ppc)), H = Math.max(8, Math.round(lay.total.h * ppc)), wr = Math.round(p.wrap * ppc);
    const cv = target || A.makeCanvas(W, H);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = p.bg;
    x.fillRect(0, 0, W, H);
    for (let i = 0; i < lay.cells.length; i++) {
      const ph = state.photos[i];
      if (!ph) continue;
      const r = cellPx(lay.cells[i], ppc), img = await getCell(i, ph, lay.cells[i], r.w, r.h);
      x.save();
      clipCell(x, r, p.radius * ppc);
      x.drawImage(img, r.x, r.y, r.w, r.h);
      x.restore();
    }
    wraps(x, W, H, wr, lay.wrapMode, p.wrapColor);
    drawTexts(x, lay, ppc);
    return cv;
  }

  function textCenter(L, lay, ppc) { return { x: (lay.face.x + L.x * lay.face.w) * ppc, y: (lay.face.y + L.y * lay.face.h) * ppc }; }
  function drawTexts(x, lay, ppc) {
    state.texts.forEach(function (L) { const c = textCenter(L, lay, ppc); TX.draw(x, L, ppc, c.x, c.y); });
  }

  // ---------- экран: кусочки клеток считаются один раз и хранятся ----------
  const cache = new Map(); // клетка → { baseKey, base, fxKey, fx, finKey, fin }
  const pending = new Map();
  let fxRunning = false, fxTimer = 0, running = null;

  function dropCache() {
    cache.forEach(function (e) { if (e.fin !== e.base && e.fin !== e.fx) release(e.fin); release(e.base); release(e.fx); });
    cache.clear();
    pending.clear();
  }

  function previewCell(p) {
    return function (i, ph, cell, W, H) {
      const baseKey = [ph.id, ph.ver, ph.fx.toFixed(4), ph.fy.toFixed(4), ph.zoom.toFixed(3), cell.w.toFixed(3), cell.h.toFixed(3), W, H, p.auto ? 1 : 0].join('|');
      let e = cache.get(i);
      if (!e) { e = {}; cache.set(i, e); }
      if (e.baseKey !== baseKey) {
        if (e.fin !== e.base && e.fin !== e.fx) release(e.fin);
        release(e.base); release(e.fx);
        e.base = cellBase(ph, cell, W, H, true, p); e.baseKey = baseKey; e.fx = null; e.fxKey = ''; e.fin = null; e.finKey = '';
      }
      let img = e.base, key = baseKey;
      if (p.effect !== 'none' && FX()) {
        const want = baseKey + '#' + fxKey(p);
        if (e.fxKey === want && e.fx) { img = e.fx; key = want; } else queueFx(i, e, want, ph, p, W / cell.w);
      }
      const finKey = key + '#' + adjustKey(p);
      if (e.finKey !== finKey) {
        if (e.fin !== e.base && e.fin !== e.fx) release(e.fin);
        e.fin = needsAdjust(p) ? copyOf(img) : img;
        adjust(e.fin, p, W / cell.w);
        e.finKey = finKey;
      }
      return e.fin;
    };
  }

  function copyOf(cv) {
    const c = A.makeCanvas(cv.width, cv.height);
    c.getContext('2d', { willReadFrequently: true }).drawImage(cv, 0, 0);
    return c;
  }

  function queueFx(i, e, want, ph, p, ppc) {
    const cur = pending.get(i);
    if ((cur && cur.want === want) || (running && running.i === i && running.want === want)) return;
    pending.set(i, { e: e, want: want, ph: ph, p: p, ppc: ppc });
    clearTimeout(fxTimer);
    fxTimer = setTimeout(runFx, 220);
  }

  async function runFx() {
    if (fxRunning) return;
    fxRunning = true;
    $('fxBusy').hidden = false;
    while (pending.size) {
      const i = pending.keys().next().value, job = pending.get(i);
      pending.delete(i);
      const e = cache.get(i);
      if (e !== job.e || job.want.indexOf(e.baseKey + '#') !== 0) continue; // уже не нужно
      running = { i: i, want: job.want };
      try {
        const out = await FX().apply(e.base, {
          effect: job.p.effect, ppc: job.ppc, size: job.p.fxSize, relief: job.p.fxRelief, amount: job.p.fxAmount, seed: seedOf(job.ph),
          isCancelled: function () { const c = cache.get(i); const q = pending.get(i); return c !== job.e || (q && q.want !== job.want) || job.want.indexOf(c.baseKey + '#') !== 0; }
        });
        if (cache.get(i) !== e) { release(out); continue; }
        if (e.fin === e.fx) e.fin = null;
        release(e.fx); e.fx = out; e.fxKey = job.want; e.finKey = '';
        redraw();
      } catch (err) { if (!err || !err.cancelled) { console.error(err); setStatus(T('Не получилось применить эффект: браузеру не хватило памяти.'), 'error'); } }
      running = null;
    }
    fxRunning = false;
    $('fxBusy').hidden = true;
  }

  let frame = 0;
  function redraw() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      if (!state.photos.length) return;
      const p = params(), lay = layoutOf(p);
      state.lay = lay;
      state.ppc = clamp(1300 / Math.max(lay.total.w, lay.total.h), 1.5, 60);
      if (!state.view) {
        const holder = $('holder');
        holder.textContent = '';
        state.view = A.makeCanvas(10, 10);
        state.overlay = A.makeCanvas(10, 10);
        state.overlay.className = 'overlay';
        holder.appendChild(state.view);
        holder.appendChild(state.overlay);
      }
      compose(p, lay, state.ppc, previewCell(p), state.view).then(function () {
        if (state.tab === 'wall') showWall(p, lay); else { state.view.hidden = false; drawOverlay(p, lay); }
        fit();
        showQuality(p, lay);
        showFileInfo(p);
        if (state.step === 5) showTextWarn(lay);
        if (state.step === 6) showChecks(p, lay);
      });
    });
  }

  /* Слой поверх макета: торцы приглушены, линия сгиба, выбранное фото и надпись. */
  function drawOverlay(p, lay) {
    const ov = state.overlay, v = state.view, ppc = state.ppc;
    ov.width = v.width; ov.height = v.height;
    ov.hidden = false;
    const x = ov.getContext('2d'), W = ov.width, H = ov.height, wr = Math.round(p.wrap * ppc), fw = W - 2 * wr, fh = H - 2 * wr;
    if (wr) {
      x.fillStyle = 'rgba(255,255,255,0.28)';
      x.fillRect(0, 0, W, wr); x.fillRect(0, H - wr, W, wr); x.fillRect(0, wr, wr, fh); x.fillRect(W - wr, wr, wr, fh);
      x.setLineDash([Math.max(4, W / 90), Math.max(3, W / 140)]);
      x.lineWidth = Math.max(1, W / 600);
      x.strokeStyle = '#ffffff'; x.strokeRect(wr, wr, fw, fh);
      x.lineDashOffset = Math.max(4, W / 90);
      x.strokeStyle = '#000000'; x.strokeRect(wr, wr, fw, fh);
      x.setLineDash([]);
    }
    if (state.step === 5 && state.texts.length) { // безопасная зона для надписей
      const s = safeInset(p) * ppc;
      x.setLineDash([6, 5]); x.lineWidth = 1.5; x.strokeStyle = 'rgba(232,70,70,0.85)';
      x.strokeRect(wr + s, wr + s, fw - 2 * s, fh - 2 * s);
      x.setLineDash([]);
    }
    if (state.photos.length > 1 && state.step < 5 && lay.cells[state.sel]) {
      const r = cellPx(lay.cells[state.sel], ppc);
      x.lineWidth = Math.max(2, W / 400);
      x.strokeStyle = '#ffffff'; x.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      x.strokeStyle = '#4a67d6'; x.setLineDash([8, 6]); x.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); x.setLineDash([]);
    }
    const L = state.texts[state.tsel];
    if (L && (state.step === 5 || state.dragText)) {
      const c = textCenter(L, lay, ppc), b = TX.box(x, L, ppc, c.x, c.y), pts = TX.corners(b);
      x.beginPath(); pts.forEach(function (q, i) { if (i) x.lineTo(q.x, q.y); else x.moveTo(q.x, q.y); }); x.closePath();
      x.lineWidth = 2; x.strokeStyle = '#ffffff'; x.stroke();
      x.setLineDash([6, 4]); x.strokeStyle = '#4a67d6'; x.stroke(); x.setLineDash([]);
    }
    if (state.snap) { // направляющие при выравнивании надписи по центру
      x.strokeStyle = '#e8467c'; x.lineWidth = 1;
      if (state.snap.x) { const sx = (lay.face.x + lay.face.w / 2) * ppc; x.beginPath(); x.moveTo(sx, wr); x.lineTo(sx, H - wr); x.stroke(); }
      if (state.snap.y) { const sy = (lay.face.y + lay.face.h / 2) * ppc; x.beginPath(); x.moveTo(wr, sy); x.lineTo(W - wr, sy); x.stroke(); }
    }
  }

  function safeInset(p) { return p.wrap > 0 ? 1 : 0.5; } // см от сгиба (или от края постера)

  function fit() {
    const stage = $('stage');
    const size = function (c, ref) {
      if (!c || !ref) return;
      const s = Math.max(0.02, Math.min((stage.clientWidth - 44) / ref.width, (stage.clientHeight - 44) / ref.height));
      c.style.width = Math.round(ref.width * s) + 'px';
      c.style.height = Math.round(ref.height * s) + 'px';
    };
    size(state.view, state.view); size(state.overlay, state.view); size(state.wall, state.wall);
    stage.classList.toggle('pannable', state.tab === 'layout');
  }

  // ---------- примерка на стене ----------
  /* Картина на стене рядом с человеком ростом 165 см; face — лицевая сторона картины. */
  function renderWall(p, face, scale, watermark) {
    const S = scale || 1, W = Math.round(1400 * S), H = Math.round(900 * S), floor = 760 * S;
    const wallCm = Math.max(260, p.w * 1.9, (p.h + 150) * 1.05), k = (W * 0.86) / wallCm; // точек на см
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    const bg = x.createLinearGradient(0, 0, 0, floor);
    bg.addColorStop(0, '#eceae5'); bg.addColorStop(1, '#dedbd4');
    x.fillStyle = bg; x.fillRect(0, 0, W, floor);
    x.fillStyle = '#b9ab98'; x.fillRect(0, floor, W, H - floor);
    x.fillStyle = '#f4f2ee'; x.fillRect(0, floor - 14 * S, W, 14 * S);
    const pw = p.w * k, ph = p.h * k, px = W * 0.56 - pw / 2, py = Math.max(20 * S, floor - 150 * k - ph); // центр картины примерно на уровне глаз
    x.shadowColor = 'rgba(0,0,0,0.3)'; x.shadowBlur = 22 * S; x.shadowOffsetY = 10 * S;
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(face, px, py, pw, ph);
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
    if (watermark) watermarkOn(x, px, py, pw, ph);
    // фигура человека: голова, корпус, ноги
    const hh = 165 * k, fxp = W * 0.16, top = floor - hh;
    x.fillStyle = '#7b8490';
    x.beginPath(); x.arc(fxp, top + hh * 0.065, hh * 0.058, 0, Math.PI * 2); x.fill();
    x.beginPath(); // плечи, корпус и ноги одним мягким контуром
    x.moveTo(fxp - hh * 0.1, top + hh * 0.2);
    x.quadraticCurveTo(fxp - hh * 0.1, top + hh * 0.145, fxp - hh * 0.035, top + hh * 0.14);
    x.lineTo(fxp + hh * 0.035, top + hh * 0.14);
    x.quadraticCurveTo(fxp + hh * 0.1, top + hh * 0.145, fxp + hh * 0.1, top + hh * 0.2);
    x.lineTo(fxp + hh * 0.085, top + hh * 0.5);
    x.lineTo(fxp + hh * 0.07, top + hh);
    x.lineTo(fxp + hh * 0.012, top + hh);
    x.lineTo(fxp, top + hh * 0.56);
    x.lineTo(fxp - hh * 0.012, top + hh);
    x.lineTo(fxp - hh * 0.07, top + hh);
    x.lineTo(fxp - hh * 0.085, top + hh * 0.5);
    x.closePath(); x.fill();
    x.fillStyle = '#6b7480'; x.font = Math.round(22 * S) + 'px Arial, Helvetica, sans-serif'; x.textAlign = 'center';
    x.fillText('165 ' + T('см'), fxp, floor + 40 * S);
    x.fillText(p.w + ' × ' + p.h + ' ' + T('см'), px + pw / 2, floor + 40 * S);
    return cv;
  }

  /* Водяной знак наискосок по прямоугольнику картины. */
  function watermarkOn(x, px, py, pw, ph) {
    x.save();
    x.beginPath(); x.rect(px, py, pw, ph); x.clip();
    x.translate(px + pw / 2, py + ph / 2); x.rotate(-Math.atan2(ph, pw));
    const fs = Math.max(14, Math.hypot(pw, ph) / 9);
    x.font = 'bold ' + fs + 'px Arial, Helvetica, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = Math.max(1, fs / 22); x.strokeStyle = 'rgba(0,0,0,0.35)'; x.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = -2; i <= 2; i++) { x.strokeText(T('ОБРАЗЕЦ'), 0, i * fs * 1.9); x.fillText(T('ОБРАЗЕЦ'), 0, i * fs * 1.9); }
    x.restore();
  }

  /* Превью для заказчика: картина крупно слева, справа — примерка на стене и размер. */
  function previewSheet(p, face, watermark) {
    const W = 2100, H = 1400, cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    x.fillStyle = '#f3f1ed'; x.fillRect(0, 0, W, H);
    const box = { x: 70, y: 70, w: 1300, h: H - 140 }, k = Math.min(box.w / face.width, box.h / face.height);
    const pw = face.width * k, ph = face.height * k, px = box.x + (box.w - pw) / 2, py = box.y + (box.h - ph) / 2;
    x.shadowColor = 'rgba(0,0,0,0.28)'; x.shadowBlur = 30; x.shadowOffsetY = 12;
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(face, px, py, pw, ph);
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
    if (watermark) watermarkOn(x, px, py, pw, ph);
    const wall = renderWall(p, face, 0.5, watermark), wx = 1430, ww = W - wx - 60, wh = (wall.height * ww) / wall.width;
    x.drawImage(wall, wx, 120, ww, wh);
    release(wall);
    x.fillStyle = '#3b3f45'; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    x.font = 'bold 44px Arial, Helvetica, sans-serif';
    x.fillText(p.w + ' × ' + p.h + ' ' + T('см'), wx, 120 + wh + 90, ww);
    x.font = '30px Arial, Helvetica, sans-serif'; x.fillStyle = '#6b7480';
    const lines = [];
    if (p.order) lines.push(T('Заказ') + ' ' + p.order);
    lines.push(p.wrap > 0 ? T('Холст на подрамнике') : T('Постер'));
    if (state.photos.length > 1) lines.push(T('Коллаж') + ': ' + state.photos.length + ' ' + T('фото'));
    if (p.effect !== 'none') lines.push(effectName(p.effect));
    lines.forEach(function (l, i) { x.fillText(l, wx, 120 + wh + 145 + i * 46, ww); });
    return cv;
  }

  /* Лицевая сторона из уже собранного макета на экране. */
  function faceOf(lay) {
    const v = state.view, ppc = state.ppc, r = cellPx(lay.face, ppc), cv = A.makeCanvas(r.w, r.h);
    cv.getContext('2d').drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return cv;
  }

  function showWall(p, lay) {
    const face = faceOf(lay);
    release(state.wall);
    state.wall = renderWall(p, face, 1, false);
    release(face);
    state.view.hidden = true;
    state.overlay.hidden = true;
    const holder = $('holder');
    if (state.wall.parentNode !== holder) holder.appendChild(state.wall);
    Array.prototype.forEach.call(holder.querySelectorAll('canvas.wall'), function (c) { if (c !== state.wall) c.remove(); });
    state.wall.className = 'wall';
  }

  // ---------- качество ----------
  /* Сколько точек фото придётся на дюйм в каждой клетке; худшее — главное. */
  function cellDpi(lay) {
    return lay.cells.map(function (cell, i) {
      const ph = state.photos[i];
      if (!ph) return Infinity;
      const c = cropOf(ph, cell, ph.src.width, ph.src.height);
      return c.w / (cell.w / 2.54);
    });
  }

  function showQuality(p, lay) {
    const box = $('quality'), dpis = cellDpi(lay), dpi = Math.min.apply(null, dpis), worst = dpis.indexOf(dpi);
    box.hidden = false;
    box.classList.toggle('bad', dpi < 70);
    box.classList.toggle('warn', dpi >= 70 && dpi < 110);
    const verdict = dpi >= 110 ? T('качества хватает') : dpi >= 70 ? T('приемлемо, вблизи может быть мягковато') : T('мало для этого размера — картина выйдет размытой');
    if (state.photos.length === 1) {
      const ph = state.photos[0], cell = lay.cells[0], k = dpi / 100, mw = Math.floor((cell.w * k) / 5) * 5, mh = Math.floor((cell.h * k) / 5) * 5;
      box.textContent = fmt(ph.src.width) + ' × ' + fmt(ph.src.height) + ' ' + T('точек') + ' · ' + verdict + ' (' + Math.round(dpi) + ' dpi)' +
        (dpi < 110 && mw >= 10 && mh >= 10 && !p.margin ? '. ' + T('Чётко выйдет до ') + mw + ' × ' + mh + ' ' + T('см') : '');
    } else {
      box.textContent = state.photos.length + ' ' + T('фото') + ' · ' + verdict + (dpi < 110 ? ' — ' + T('слабее всего фото №') + (worst + 1) : '') + ' (' + Math.round(dpi) + ' dpi)';
    }
  }

  function outputSize(p, lay) {
    const t = (lay || layoutOf(p)).total;
    let dpi = 300, w = (t.w / 2.54) * dpi, h = (t.h / 2.54) * dpi;
    const k = Math.min(1, Math.sqrt(MAX_OUT / (w * h)), MAX_SIDE / Math.max(w, h)); // очень большие холсты — с меньшим разрешением
    dpi = Math.max(50, Math.floor(dpi * k));
    return { dpi: dpi, w: Math.round((t.w / 2.54) * dpi), h: Math.round((t.h / 2.54) * dpi), cm: t };
  }

  function showFileInfo(p) {
    const o = outputSize(p);
    $('fileInfo').textContent = fileName(p) + ' · ' + fmt(o.w) + ' × ' + fmt(o.h) + ' ' + T('точек') + ' · ' + o.dpi + ' dpi · ' +
      T('лист') + ' ' + num(o.cm.w) + ' × ' + num(o.cm.h) + ' ' + T('см');
  }

  function fileName(p, suffix) {
    const base = (p.order || (state.photos[0] && state.photos[0].name || '').replace(/\.[^.]+$/, '') || T('Картина')).replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 60) || T('Картина');
    return base + ' ' + p.w + 'x' + p.h + (suffix || '.jpg');
  }

  /* Надписи, которые заходят за безопасную зону у сгиба. */
  function textsNearEdge(lay, p) {
    const ppc = 10, s = safeInset(p), x = probeCtx(), out = [];
    state.texts.forEach(function (L, i) {
      if (!String(L.text || '').trim()) return;
      const c = textCenter(L, lay, ppc), b = TX.box(x, L, ppc, c.x, c.y);
      const bad = TX.corners(b).some(function (q) {
        return q.x < (lay.face.x + s) * ppc || q.x > (lay.face.x + lay.face.w - s) * ppc || q.y < (lay.face.y + s) * ppc || q.y > (lay.face.y + lay.face.h - s) * ppc;
      });
      if (bad) out.push(i);
    });
    return out;
  }
  let probeCanvas = null;
  function probeCtx() { if (!probeCanvas) probeCanvas = A.makeCanvas(4, 4); return probeCanvas.getContext('2d'); }

  function showTextWarn(lay) {
    const p = params(), bad = textsNearEdge(lay, p), w = $('tWarn');
    w.hidden = bad.indexOf(state.tsel) < 0;
    w.textContent = p.wrap > 0 ? T('Надпись ближе 1 см к сгибу: при натяжке часть букв может уйти на торец. Сдвиньте её внутрь красной рамки.') : T('Надпись у самого края: при обрезке её могут задеть. Сдвиньте внутрь красной рамки.');
  }

  function showChecks(p, lay) {
    const list = $('checks'), dpis = cellDpi(lay), dpi = Math.min.apply(null, dpis), near = textsNearEdge(lay, p), items = [];
    items.push(dpi >= 110 ? ['ok', T('Разрешения фото хватает на этот размер.')] : dpi >= 70 ? ['warn', T('Фото на пределе: вблизи будет мягковато') + (state.photos.length > 1 ? ' (№' + (dpis.indexOf(dpi) + 1) + ')' : '') + '.'] : ['bad', T('Фото слишком маленькое для этого размера — картина выйдет размытой') + (state.photos.length > 1 ? ' (№' + (dpis.indexOf(dpi) + 1) + ')' : '') + '.']);
    if (near.length) items.push(['warn', T('Надписи у края: ') + near.map(function (i) { return '«' + String(state.texts[i].text).split('\n')[0].slice(0, 24) + '»'; }).join(', ') + T(' — часть букв может уйти на торец.')]);
    if (p.effect !== 'none') items.push(['ok', T('Эффект «') + effectName(p.effect) + T('» будет рассчитан в полном разрешении — сохранение займёт до минуты.')]);
    list.textContent = '';
    items.forEach(function (it) { const li = document.createElement('li'); li.className = it[0]; li.textContent = it[1]; list.appendChild(li); });
  }

  function effectName(id) {
    const e = FX() && FX().EFFECTS.find(function (x) { return x.id === id; });
    return e ? T(e.name) : id;
  }

  // ---------- файл для печати ----------
  let cmykLut = null;
  function loadCmykLut() {
    if (cmykLut) return cmykLut;
    cmykLut = new Promise(function (resolve, reject) {
      const sc = document.createElement('script');
      sc.src = 'js/cmyk-lut.js?v=' + ASSET_VERSION;
      sc.onload = function () {
        try {
          const bin = atob(A.CMYK_LUT.base64), data = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
          resolve({ n: A.CMYK_LUT.n, data: data });
        } catch (e) { cmykLut = null; reject(e); }
      };
      sc.onerror = function () { cmykLut = null; reject(new Error('cmyk')); };
      document.head.appendChild(sc);
    });
    return cmykLut;
  }

  /* Макет в печатном качестве: каждая клетка — из полного фото, эффект и обработка в полном разрешении. */
  async function renderPrint(p, ppc, onStep) {
    const lay = layoutOf(p), n = lay.cells.length;
    let done = 0;
    return compose(p, lay, ppc, async function (i, ph, cell, W, H) {
      const base = cellBase(ph, cell, W, H, false, p);
      let img = base;
      if (p.effect !== 'none' && FX()) {
        img = await FX().apply(base, {
          effect: p.effect, ppc: W / cell.w, size: p.fxSize, relief: p.fxRelief, amount: p.fxAmount, seed: seedOf(ph),
          onProgress: function (f) { if (onStep) onStep((done + f) / n); }
        });
        release(base);
      }
      adjust(img, p, W / cell.w);
      done++;
      if (onStep) onStep(done / n);
      await wait(0);
      // клетку освобождаем после того, как её нарисуют на макете
      setTimeout(function () { release(img); }, 0);
      return img;
    });
  }

  async function buildFile() {
    const p = params(), o = outputSize(p);
    const cv = await renderPrint(p, o.dpi / 2.54, function (f) { setStatus(T('Готовлю файл в печатном качестве: ') + Math.round(f * 100) + '%'); });
    try {
      if (p.colorMode === 'cmyk') {
        const lut = await loadCmykLut(), x = cv.getContext('2d', { willReadFrequently: true });
        const enc = A.jpegCmyk(cv.width, cv.height, lut, 86, o.dpi);
        for (let y = 0, n = 0; y < cv.height; y += 8, n++) {
          const rows = Math.min(8, cv.height - y);
          enc.band(x.getImageData(0, y, cv.width, rows).data, rows);
          if (n % 24 === 23) await wait(0);
        }
        return { name: fileName(p), parts: enc.finish(), dpi: o.dpi, w: cv.width, h: cv.height, mode: 'cmyk' };
      }
      const blob = await new Promise(function (resolve, reject) {
        cv.toBlob(function (b) { if (b) resolve(b); else reject(new Error('jpeg')); }, 'image/jpeg', 0.94);
      });
      const bytes = A.jpegSetDpi(new Uint8Array(await blob.arrayBuffer()), o.dpi);
      return { name: fileName(p), parts: [bytes], dpi: o.dpi, w: cv.width, h: cv.height, mode: 'rgb' };
    } finally {
      release(cv);
    }
  }

  function download(parts, name, type) {
    const url = URL.createObjectURL(new Blob(parts, { type: type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function setBusy(on) {
    state.busy = on;
    ['save', 'saveTop', 'previewSave', 'projSave'].forEach(function (id) { $(id).disabled = on || !state.photos.length; });
  }

  async function save() {
    if (!state.photos.length || state.busy) return;
    setBusy(true);
    setStatus(T('Готовлю файл в печатном качестве, это займёт несколько секунд…'));
    await wait(40);
    try {
      const f = await buildFile();
      download(f.parts, f.name, 'image/jpeg');
      setStatus(f.dpi < 300 ? T('Сохранено с разрешением ') + f.dpi + T(' dpi: для такого большого холста браузер не держит 300.') : T('Сохранено в папку загрузок'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти. Попробуйте размер меньше или другой компьютер.'), 'error');
    }
    setBusy(false);
  }

  /* Превью для заказчика: картина на стене, JPG ~2100 точек. */
  async function savePreview() {
    if (!state.photos.length || state.busy) return;
    setBusy(true);
    setStatus(T('Готовлю превью…'));
    await wait(30);
    try {
      const p = params(), lay = layoutOf(p);
      // лицо — с более высоким разрешением, чем на экране: эффект считаем заново
      const ppc = clamp(1500 / Math.max(lay.face.w, lay.face.h), 2, 60);
      const full = await renderPrint(p, ppc);
      const r = cellPx(lay.face, ppc), face = A.makeCanvas(r.w, r.h);
      face.getContext('2d').drawImage(full, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      release(full);
      const sheet = previewSheet(p, face, $('watermark').checked);
      release(face);
      const blob = await new Promise(function (resolve, reject) { sheet.toBlob(function (b) { if (b) resolve(b); else reject(new Error('jpeg')); }, 'image/jpeg', 0.88); });
      release(sheet);
      download([blob], fileName(p, ' ' + T('превью') + '.jpg'), 'image/jpeg');
      setStatus(T('Превью сохранено — его можно отправить заказчику.'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить превью.'), 'error');
    }
    setBusy(false);
  }

  // ---------- проект ----------
  function canvasToDataUrl(cv) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) {
        if (!b) { reject(new Error('jpeg')); return; }
        const r = new FileReader();
        r.onload = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
        r.readAsDataURL(b);
      }, 'image/jpeg', 0.92);
    });
  }

  async function saveProject() {
    if (!state.photos.length || state.busy) return;
    setBusy(true);
    setStatus(T('Сохраняю проект…'));
    try {
      const p = params(), photos = [];
      for (const ph of state.photos) {
        // фото без поворота — поворот и кадр хранятся отдельно
        const raw = ph.raw, k = Math.min(1, Math.sqrt(MAX_SOURCE / (raw.naturalWidth * raw.naturalHeight)));
        const cv = A.makeCanvas(Math.max(1, Math.round(raw.naturalWidth * k)), Math.max(1, Math.round(raw.naturalHeight * k)));
        const x = cv.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, cv.width, cv.height);
        x.imageSmoothingQuality = 'high'; x.drawImage(raw, 0, 0, cv.width, cv.height);
        photos.push({ name: ph.name, data: await canvasToDataUrl(cv), rot: ph.rot, flipX: ph.flipX, flipY: ph.flipY, fx: ph.fx, fy: ph.fy, zoom: ph.zoom });
        release(cv);
        await wait(0);
      }
      const fields = {};
      SAVED.concat(ADJUST, ['tone', 'fxSize', 'fxRelief', 'fxAmount', 'order']).forEach(function (id) { fields[id] = $(id).value; });
      fields.autoLevel = $('autoLevel').checked;
      const fonts = [];
      state.texts.forEach(function (L) { if (TX.isUserFont(L.font) && !fonts.some(function (f) { return f.family === L.font; })) fonts.push({ family: L.font, data: TX.fontData(L.font) }); });
      const o = { app: 'almaz-canvas', v: 1, fields: fields, effect: state.effect, tpl: layoutOf(p).tpl.id, photos: photos, texts: state.texts, fonts: fonts };
      download([JSON.stringify(o)], fileName(p, '.almaz'), 'application/json');
      state.dirty = false;
      setStatus(T('Проект сохранён. Откройте его кнопкой «Открыть проект» на шаге «Фото».'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить проект: браузеру не хватило памяти.'), 'error');
    }
    setBusy(false);
  }

  async function openProject(file) {
    if (!file || state.busy) return;
    if (file.size > 400e6) { setStatus(T('Файл проекта слишком большой.'), 'error'); return; }
    setStatus(T('Открываю проект…'));
    try {
      const o = JSON.parse(await file.text());
      if (!o || o.app !== 'almaz-canvas' || !Array.isArray(o.photos) || !o.photos.length) throw new Error('не проект');
      for (const f of (o.fonts || [])) { if (f && typeof f.family === 'string' && typeof f.data === 'string') { try { await TX.addFontData(f.family, f.data); } catch (e) { /* шрифт не загрузился — будет запасной */ } } }
      TX.resetCache();
      clearPhotos();
      for (const it of o.photos.slice(0, MAX_PHOTOS)) {
        if (!it || typeof it.data !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(it.data)) continue;
        const img = await imageFrom(it.data);
        state.photos.push({ id: state.nextId++, raw: img, url: '', name: String(it.name || '').slice(0, 120), rot: [0, 90, 180, 270].indexOf(it.rot) >= 0 ? it.rot : 0, flipX: !!it.flipX, flipY: !!it.flipY, fx: clamp(+it.fx || 0.5, 0, 1), fy: clamp(+it.fy || 0.5, 0, 1), zoom: clamp(+it.zoom || 1, 1, 4) });
      }
      if (!state.photos.length) throw new Error('нет фото');
      state.photos.forEach(function (ph) { rebuildSource(ph); ph.budget = photoBudget(state.photos.length); });
      const f = o.fields || {};
      Object.keys(f).forEach(function (id) { const el = $(id); if (!el || id === 'autoLevel') return; if (typeof f[id] === 'string') el.value = f[id]; });
      $('autoLevel').checked = !!f.autoLevel;
      state.effect = typeof o.effect === 'string' ? o.effect : 'none';
      state.tpl = typeof o.tpl === 'string' ? o.tpl : '';
      state.texts = (Array.isArray(o.texts) ? o.texts : []).filter(function (L) { return L && typeof L.text === 'string'; }).map(function (L) { return Object.assign(TX.newLayer(''), L); });
      state.tsel = state.texts.length ? 0 : -1;
      state.sel = 0;
      afterPhotos();
      state.dirty = false;
      setStatus(T('Проект открыт.'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не удалось открыть проект: файл повреждён или это не проект раздела «Фото на холсте».'), 'error');
    }
  }

  // ---------- загрузка фото ----------
  function imageFrom(src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { if (img.naturalWidth && img.naturalHeight) resolve(img); else reject(new Error('empty')); };
      img.onerror = function () { reject(new Error('load')); };
      img.src = src;
    });
  }

  function clearPhotos() {
    state.photos.forEach(function (ph) { release(ph.src); release(ph.small); if (ph.url) URL.revokeObjectURL(ph.url); });
    state.photos = [];
    dropCache();
  }

  /* Добавить фото (или заменить фото номер replace). */
  async function addFiles(files, replace) {
    files = Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name); });
    if (!files.length) { setStatus(T('Это не картинка. Подойдут JPG, PNG, WebP.'), 'error'); return; }
    if (state.busy) return;
    const room = replace >= 0 ? 1 : MAX_PHOTOS - state.photos.length;
    if (room <= 0) { setStatus(T('В коллаже уже 20 фото — больше не поместится.'), 'error'); return; }
    const first = !state.photos.length;
    setStatus(T('Открываю картинку…'));
    let added = 0, failed = 0;
    for (const file of files.slice(0, room)) {
      const url = URL.createObjectURL(file);
      try {
        const img = await imageFrom(url);
        const ph = { id: state.nextId++, raw: img, url: url, name: String(file.name || '').slice(0, 120), rot: 0, flipX: false, flipY: false, fx: 0.5, fy: 0.5, zoom: 1 };
        if (replace >= 0 && state.photos[replace]) {
          const old = state.photos[replace];
          release(old.src); release(old.small); if (old.url) URL.revokeObjectURL(old.url);
          state.photos[replace] = ph;
        } else state.photos.push(ph);
        added++;
      } catch (e) { URL.revokeObjectURL(url); failed++; }
    }
    if (!added) { setStatus(T('Не удалось открыть файл. Подойдут JPG, PNG, WebP. Фото с iPhone в формате HEIC сначала сохраните как JPG.'), 'error'); return; }
    try {
      // при каждом изменении числа фото пересчитываем рабочие копии: на все фото один бюджет памяти
      const budget = photoBudget(state.photos.length);
      state.photos.forEach(function (ph) { if (!ph.src || !ph.budget || budget < ph.budget * 0.8) { rebuildSource(ph, budget); ph.budget = budget; } });
    } catch (e) {
      console.error(e);
      setStatus(T('Не удалось прочитать эту картинку. Сохраните её как JPG или PNG и загрузите снова.'), 'error');
    }
    if (first) {
      $('order').value = ''; // номер относится к прошлому заказу
      state.texts = []; state.tsel = -1; state.effect = 'none';
      ADJUST.forEach(function (id) { $(id).value = 0; });
      $('tone').value = 'color'; $('autoLevel').checked = false; $('fxAmount').value = 100;
      // холст поворачиваем под ориентацию фото
      const s = state.photos[0].src, w = +$('wCm').value, h = +$('hCm').value, land = s.width > s.height * 1.05, port = s.height > s.width * 1.05;
      if (state.photos.length === 1 && ((land && w < h) || (port && w > h))) { $('wCm').value = h; $('hCm').value = w; }
    }
    if (replace >= 0) state.sel = replace; else if (!first) state.sel = state.photos.length - 1;
    touch();
    afterPhotos();
    if (first) setStep(state.photos.length > 1 ? 3 : 2);
    setStatus(failed ? T('Часть файлов не открылась: ') + failed + '.' : state.photos.length > 1 ? T('Фото в коллаже: ') + state.photos.length + T('. Выберите раскладку.') : T('Фото загружено. Выберите размер и кадр.'), failed ? 'error' : '');
  }

  function removePhoto(i) {
    const ph = state.photos[i];
    if (!ph) return;
    release(ph.src); release(ph.small); if (ph.url) URL.revokeObjectURL(ph.url);
    state.photos.splice(i, 1);
    state.sel = clamp(state.sel, 0, Math.max(0, state.photos.length - 1));
    dropCache();
    touch();
    if (!state.photos.length) {
      state.view = null; state.overlay = null;
      $('holder').textContent = ''; $('holder').hidden = true; $('empty').hidden = false;
      $('quality').hidden = true;
      afterPhotos();
      setStep(1);
      setStatus(T('Загрузите фото, чтобы начать'));
      return;
    }
    afterPhotos();
  }

  /* Всё, что зависит от числа фото: список, раскладки, кнопки. */
  function afterPhotos() {
    const n = state.photos.length;
    $('photoList').hidden = !n;
    $('imageTools').hidden = !n;
    $('empty').hidden = !!n; $('holder').hidden = !n;
    $('dropTitle').textContent = n ? T('Добавить фото') : T('Выбрать фото');
    $('dropHint').textContent = n ? T('можно сразу несколько — получится коллаж') : T('можно сразу несколько; или перетащите файлы, или вставьте из буфера (Ctrl+V)');
    $('dropThumb').style.backgroundImage = '';
    $('dropThumb').textContent = '＋';
    setBusy(false);
    renderPhotoList();
    renderTemplates();
    renderFxList();
    renderTextList();
    syncSelection();
    syncOutputs();
    setStep(state.step);
  }

  function renderPhotoList() {
    const list = $('photoList');
    list.textContent = '';
    state.photos.forEach(function (ph, i) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'photo-tile';
      b.style.backgroundImage = 'url("' + thumbUrl(ph) + '")';
      b.setAttribute('aria-pressed', i === state.sel ? 'true' : 'false');
      b.title = ph.name || T('Фото') + ' ' + (i + 1);
      const s = document.createElement('span'); s.className = 'num'; s.textContent = i + 1; b.appendChild(s);
      b.addEventListener('click', function () { selectCell(i); });
      list.appendChild(b);
    });
    if (state.photos.length && state.photos.length < MAX_PHOTOS) {
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'photo-tile add'; add.textContent = '＋'; add.title = T('Добавить фото');
      add.addEventListener('click', function () { $('file').click(); });
      list.appendChild(add);
    }
  }

  function syncSelection() {
    const n = state.photos.length, ph = state.photos[state.sel];
    $('photoSel').textContent = ph ? (n > 1 ? T('Фото') + ' ' + (state.sel + 1) + ' ' + T('из') + ' ' + n + (ph.name ? ' · ' + ph.name : '') : ph.name) : '';
    $('photoRemove').hidden = n < 2;
    $('zoom').value = ph ? Math.round(ph.zoom * 100) : 100;
    $('zoomLabel').textContent = n > 1 ? T('Приблизить выбранное фото') : T('Приблизить фото');
    $('cellInfo').textContent = n > 1 ? T('Выбрано фото') + ' ' + (state.sel + 1) : '';
    $('cellPrev').disabled = state.sel <= 0;
    $('cellNext').disabled = state.sel >= n - 1;
    Array.prototype.forEach.call($('photoList').children, function (b, i) { if (!b.classList.contains('add')) b.setAttribute('aria-pressed', i === state.sel ? 'true' : 'false'); });
    syncOutputs();
  }

  function selectCell(i) {
    state.sel = clamp(i, 0, Math.max(0, state.photos.length - 1));
    syncSelection();
    redraw();
  }

  function swapCells(a, b) {
    if (!state.photos[a] || !state.photos[b]) return;
    const t = state.photos[a]; state.photos[a] = state.photos[b]; state.photos[b] = t;
    state.sel = b;
    dropCache();
    touch();
    renderPhotoList();
    syncSelection();
    redraw();
  }

  function turn(change) {
    const ph = state.photos[state.sel];
    if (!ph) return;
    const single = state.photos.length === 1;
    if (change.rot) {
      ph.rot = (ph.rot + change.rot + 360) % 360;
      if (single) { const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w; }
    }
    if (change.flipX) ph.flipX = !ph.flipX;
    if (change.flipY) ph.flipY = !ph.flipY;
    ph.fx = ph.fy = 0.5;
    try {
      rebuildSource(ph);
    } catch (e) { // не хватило памяти на повёрнутую копию — возвращаем как было
      console.error(e);
      if (change.rot) { ph.rot = (ph.rot - change.rot + 360) % 360; if (single) { const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w; } }
      if (change.flipX) ph.flipX = !ph.flipX;
      if (change.flipY) ph.flipY = !ph.flipY;
      setStatus(T('Не получилось повернуть: браузеру не хватило памяти.'), 'error');
    }
    touch();
    renderPhotoList();
    syncOutputs();
    redraw();
  }

  // ---------- раскладки ----------
  function renderTemplates() {
    const n = state.photos.length, box = $('tplBox'), list = $('tplList');
    box.hidden = n < 2;
    list.textContent = '';
    if (n < 2) return;
    const p = params(), aspect = p.w / p.h, tpls = CL.templates(n, aspect), cur = CL.find(n, state.tpl, aspect);
    state.tpl = cur.id;
    tpls.forEach(function (t) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tpl-item';
      b.setAttribute('aria-pressed', t.id === cur.id ? 'true' : 'false');
      b.appendChild(CL.thumb(t, aspect, 64));
      b.addEventListener('click', function () {
        state.tpl = t.id;
        state.photos.forEach(function (ph) { ph.fx = ph.fy = 0.5; });
        dropCache(); touch();
        renderTemplates();
        redraw();
      });
      list.appendChild(b);
    });
  }

  // ---------- эффекты ----------
  const fxThumbs = new Map(); // эффект → картинка для кнопки (для текущего фото)
  let fxThumbFor = '';
  function renderFxList() {
    const list = $('fxList'), fx = FX();
    list.textContent = '';
    const effects = fx ? fx.EFFECTS : [{ id: 'none', name: 'Без эффекта' }];
    effects.forEach(function (e) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fx-item'; b.dataset.fx = e.id;
      b.setAttribute('aria-pressed', e.id === state.effect ? 'true' : 'false');
      const th = document.createElement('span'); th.className = 'fx-thumb';
      if (fxThumbs.has(e.id)) th.style.backgroundImage = 'url("' + fxThumbs.get(e.id) + '")';
      b.appendChild(th);
      b.appendChild(document.createTextNode(T(e.name)));
      b.addEventListener('click', function () { setEffect(e.id); });
      list.appendChild(b);
    });
    syncFxControls();
  }

  function setEffect(id) {
    const def = FX() && FX().EFFECTS.find(function (e) { return e.id === id; });
    state.effect = def ? id : 'none';
    if (def && def.size) { $('fxSize').min = def.size.min; $('fxSize').max = def.size.max; $('fxSize').step = def.size.step || 0.5; $('fxSize').value = def.size.def; }
    if (def && def.relief) $('fxRelief').value = def.reliefDef == null ? 50 : def.reliefDef;
    Array.prototype.forEach.call($('fxList').children, function (b) { b.setAttribute('aria-pressed', b.dataset.fx === state.effect ? 'true' : 'false'); });
    syncFxControls();
    touch();
    syncOutputs();
    redraw();
  }

  /* Что значат ползунки у каждого эффекта. */
  const FX_LABELS = {
    oil: ['Размер мазка, мм', 'Рельеф мазков'],
    watercolor: ['Размер размывов, мм', 'Фактура бумаги'],
    pencil: ['Толщина линий, мм', 'Фактура бумаги'],
    colorpencil: ['Толщина линий, мм', 'Фактура бумаги'],
    cartoon: ['Толщина контура, мм', ''],
    poster: ['Крупность деталей, мм', '']
  };
  function syncFxControls() {
    const def = FX() && FX().EFFECTS.find(function (e) { return e.id === state.effect; }), lb = FX_LABELS[state.effect] || ['Размер мазка, мм', 'Рельеф мазков'];
    $('fxControls').hidden = !def || state.effect === 'none';
    $('fxSizeRow').hidden = !(def && def.size);
    $('fxReliefRow').hidden = !(def && def.relief);
    $('fxSizeName').textContent = T(lb[0]);
    $('fxReliefName').textContent = T(lb[1] || 'Рельеф мазков');
  }

  /* Миниатюры эффектов на текущем фото — чтобы выбирать глазами. Считаются по очереди в фоне. */
  async function makeFxThumbs() {
    const fx = FX(), ph = state.photos[state.sel] || state.photos[0];
    if (!fx || !ph) return;
    const sig = ph.id + ':' + ph.ver;
    if (fxThumbFor === sig) return;
    fxThumbFor = sig;
    fxThumbs.clear();
    const s = ph.small || ph.src, aspect = 4 / 3;
    let cw = s.width, ch = cw / aspect;
    if (ch > s.height) { ch = s.height; cw = ch * aspect; }
    const base = A.downscale(s, { x: (s.width - cw) / 2, y: (s.height - ch) / 2, w: cw, h: ch }, 240, 180);
    for (const e of fx.EFFECTS) {
      if (fxThumbFor !== sig) break;
      try {
        // как на холсте 24 × 18 см: мазки видны и на маленькой картинке
        const out = e.id === 'none' ? base : await fx.apply(base, { effect: e.id, ppc: 10, size: e.size ? e.size.def : 3, relief: e.reliefDef == null ? 50 : e.reliefDef, amount: 100, seed: 7, isCancelled: function () { return fxThumbFor !== sig; } });
        fxThumbs.set(e.id, out.toDataURL('image/jpeg', 0.8));
        if (out !== base) release(out);
        const b = $('fxList').querySelector('[data-fx="' + e.id + '"] .fx-thumb');
        if (b) b.style.backgroundImage = 'url("' + fxThumbs.get(e.id) + '")';
      } catch (err) { if (!err || !err.cancelled) console.error(err); }
      await wait(0);
    }
    release(base);
  }

  // ---------- надписи ----------
  function renderTextList() {
    const list = $('textList');
    list.textContent = '';
    state.texts.forEach(function (L, i) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', i === state.tsel ? 'true' : 'false');
      const s = document.createElement('span'); s.textContent = String(L.text || '').split('\n')[0] || T('(пустая надпись)');
      const sm = document.createElement('small'); sm.textContent = L.font + ' · ' + num(L.size) + ' ' + T('см');
      b.appendChild(s); b.appendChild(sm);
      b.addEventListener('click', function () { selectText(i); });
      li.appendChild(b);
      list.appendChild(li);
    });
    $('textEditor').hidden = !state.texts[state.tsel];
    fillTextEditor();
  }

  function fillFonts(current) {
    const sel = $('tFont');
    sel.textContent = '';
    let found = false;
    TX.available().forEach(function (g) {
      const og = document.createElement('optgroup');
      og.label = T(g.group);
      g.fonts.forEach(function (f) {
        const o = document.createElement('option');
        o.value = f.family;
        o.textContent = f.family + (f.cyr ? '' : ' — ' + T('только латиница'));
        o.style.fontFamily = '"' + f.family + '"';
        if (f.family === current) found = true;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (current && !found) { const o = document.createElement('option'); o.value = current; o.textContent = current + ' — ' + T('нет на этом компьютере'); sel.insertBefore(o, sel.firstChild); }
    sel.value = current;
  }

  const TFIELDS = {
    tSize: ['size', 'num'], tOpacity: ['opacity', 'num'], tRot: ['rot', 'num'], tSpacing: ['spacing', 'num'], tLineH: ['lineH', 'num'],
    tColor: ['color'], tFill: ['fill'], tFont: ['font'], tText: ['text'],
    tShadow: ['shadow.on', 'check'], tShadowColor: ['shadow.color'], tShadowAlpha: ['shadow.alpha', 'num'], tShadowBlur: ['shadow.blur', 'num'], tShadowDx: ['shadow.dx', 'num'], tShadowDy: ['shadow.dy', 'num'],
    tOutline: ['outline.on', 'check'], tOutlineColor: ['outline.color'], tOutlineWidth: ['outline.width', 'num'],
    tPlate: ['plate.on', 'check'], tPlateColor: ['plate.color'], tPlateAlpha: ['plate.alpha', 'num'], tPlatePad: ['plate.pad', 'num'], tPlateRadius: ['plate.radius', 'num']
  };
  function getPath(o, path) { return path.split('.').reduce(function (a, k) { return a && a[k]; }, o); }
  function setPath(o, path, v) { const ks = path.split('.'), last = ks.pop(), t = ks.reduce(function (a, k) { return a[k]; }, o); t[last] = v; }

  function fillTextEditor() {
    const L = state.texts[state.tsel];
    if (!L) return;
    fillFonts(L.font);
    Object.keys(TFIELDS).forEach(function (id) {
      const f = TFIELDS[id], v = getPath(L, f[0]), el = $(id);
      if (id === 'tFont') return;
      if (f[1] === 'check') el.checked = !!v; else el.value = v;
    });
    $('tBold').setAttribute('aria-pressed', L.bold ? 'true' : 'false');
    $('tItalic').setAttribute('aria-pressed', L.italic ? 'true' : 'false');
    document.querySelectorAll('input[name=tAlign]').forEach(function (r) { r.checked = r.value === L.align; });
    syncTextOutputs();
  }

  function syncTextOutputs() {
    ['tSize', 'tOpacity', 'tRot', 'tSpacing', 'tLineH', 'tShadowAlpha', 'tShadowBlur', 'tShadowDx', 'tShadowDy', 'tOutlineWidth', 'tPlateAlpha', 'tPlatePad', 'tPlateRadius'].forEach(function (id) {
      $(id + 'Out').textContent = num(+$(id).value);
    });
    $('tLineHOut').textContent = (+$('tLineH').value).toFixed(2).replace('.', ',');
    $('tColorRow').hidden = $('tFill').value !== 'color';
  }

  function selectText(i) {
    state.tsel = i;
    renderTextList();
    redraw();
  }

  function textChanged(listToo) {
    touch();
    if (listToo) {
      const L = state.texts[state.tsel], b = $('textList').children[state.tsel];
      if (L && b) { b.querySelector('span').textContent = String(L.text || '').split('\n')[0] || T('(пустая надпись)'); b.querySelector('small').textContent = L.font + ' · ' + num(L.size) + ' ' + T('см'); }
    }
    redraw();
  }

  function addText() {
    const L = TX.newLayer(state.texts.length ? '' : T('Ваш текст'));
    // новая надпись — ниже предыдущей, чтобы не легла сверху
    if (state.texts.length) { const prev = state.texts[state.texts.length - 1]; Object.assign(L, JSON.parse(JSON.stringify(prev))); L.text = T('Ваш текст'); L.y = clamp(prev.y - 0.15, 0.1, 0.9); }
    state.texts.push(L);
    state.tsel = state.texts.length - 1;
    touch();
    renderTextList();
    redraw();
    setTimeout(function () { $('tText').focus(); $('tText').select(); }, 30);
  }

  // ---------- этапы ----------
  function setStep(n) {
    n = clamp(n | 0, 1, LAST);
    if (!state.photos.length) n = 1;
    state.step = n;
    document.querySelectorAll('[data-step]').forEach(function (s) { s.hidden = +s.dataset.step !== n; });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      const k = +b.dataset.go;
      b.disabled = k > 1 && !state.photos.length;
      if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', k < n);
    });
    $('stepBack').hidden = n === 1;
    $('stepNext').hidden = n === LAST;
    $('stepNext').disabled = !state.photos.length;
    $('stepNext').textContent = n < LAST ? T('Далее: ') + T(STEP_NAMES[n + 1]) + ' →' : '';
    $('save').hidden = n !== LAST;
    $('panel').scrollTop = 0;
    if (n === 4) makeFxThumbs();
    if (n === 5 && state.texts.length && state.tsel < 0) { state.tsel = 0; renderTextList(); }
    redraw();
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
    if (tab === 'layout' && state.wall) { state.wall.remove(); release(state.wall); state.wall = null; }
    redraw();
  }

  // ---------- подсказки по наведению ----------
  function setupHints() {
    const tip = $('tip');
    let shown = null;
    function hide() { if (shown) shown.setAttribute('aria-expanded', 'false'); shown = null; tip.hidden = true; }
    function show(btn) {
      if (shown === btn) return;
      hide();
      shown = btn;
      btn.setAttribute('aria-expanded', 'true');
      tip.textContent = btn.dataset.tip;
      tip.hidden = false;
      const r = btn.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      tip.style.left = Math.round(clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8)) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }
    document.querySelectorAll('.hint:not(.keep), .lead').forEach(function (p) {
      if (p.id) return;
      const text = p.textContent.trim(), b = document.createElement('button');
      b.type = 'button'; b.className = 'info'; b.textContent = '!';
      b.dataset.tip = text;
      b.setAttribute('aria-label', text);
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('mouseenter', function () { show(b); });
      b.addEventListener('mouseleave', hide);
      b.addEventListener('focus', function () { show(b); });
      b.addEventListener('blur', hide);
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); show(b); });
      const target = p.previousElementSibling;
      if (target && target.tagName === 'LABEL') {
        const node = Array.prototype.find.call(target.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
        if (node) {
          const wrap = document.createElement('span');
          wrap.className = 'with-info';
          wrap.appendChild(document.createTextNode(node.nodeValue.trim()));
          wrap.appendChild(b);
          target.replaceChild(wrap, node);
        } else target.appendChild(b);
      } else if (target && /^H[23]$/.test(target.tagName)) target.appendChild(b);
      else p.parentElement.insertBefore(b, p);
      p.remove();
    });
    window.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    document.addEventListener('click', function (e) { if (shown && !e.target.closest('.info')) hide(); });
  }

  // ---------- работа мышью на макете ----------
  /* Точка экрана → сантиметры макета. */
  function toCm(e) {
    const r = state.view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * (state.view.width / state.ppc), y: ((e.clientY - r.top) / r.height) * (state.view.height / state.ppc), k: r.width / state.view.width };
  }
  function cellAt(lay, pt) {
    for (let i = 0; i < lay.cells.length; i++) { const c = lay.cells[i]; if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h) return i; }
    return -1;
  }
  function textAt(lay, pt) {
    const x = probeCtx(), ppc = state.ppc;
    for (let i = state.texts.length - 1; i >= 0; i--) {
      const L = state.texts[i];
      if (!String(L.text || '').trim()) continue;
      const c = textCenter(L, lay, ppc);
      if (TX.hit(TX.box(x, L, ppc, c.x, c.y), pt.x * ppc, pt.y * ppc)) return i;
    }
    return -1;
  }

  function setupStage() {
    const stage = $('stage'), touches = new Map();
    let drag = null, pinch = null;
    function dist() { const t = Array.from(touches.values()); return Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y); }
    stage.addEventListener('pointerdown', function (e) {
      if (!state.photos.length || state.tab !== 'layout' || e.target !== state.view && e.target !== state.overlay && e.target !== $('holder')) return;
      if (e.target === $('holder')) return;
      const lay = state.lay, pt = toCm(e);
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
      if (touches.size === 2) { const ph = state.photos[state.sel]; pinch = { d: dist(), zoom: ph ? ph.zoom : 1 }; drag = null; return; }
      if (touches.size > 2) return;
      const ti = textAt(lay, pt);
      if (ti >= 0) {
        if (state.tsel !== ti) { state.tsel = ti; renderTextList(); }
        const L = state.texts[ti];
        drag = { kind: 'text', x: e.clientX, y: e.clientY, lx: L.x, ly: L.y };
        state.dragText = true;
        stage.classList.add('panning');
        redraw();
        return;
      }
      const ci = cellAt(lay, pt);
      if (ci < 0 || !state.photos[ci]) return;
      if (ci !== state.sel) selectCell(ci);
      const ph = state.photos[ci];
      drag = { kind: 'photo', i: ci, x: e.clientX, y: e.clientY, fx: ph.fx, fy: ph.fy };
      stage.classList.add('panning');
    });
    stage.addEventListener('pointermove', function (e) {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const ph = state.photos[state.sel];
      if (pinch && touches.size === 2 && ph) {
        ph.zoom = clamp(pinch.zoom * (dist() / Math.max(10, pinch.d)), 1, 4);
        syncSelection(); redraw();
        return;
      }
      if (!drag) return;
      const lay = state.lay, r = state.view.getBoundingClientRect(), cmPerScreen = state.view.width / state.ppc / r.width;
      if (drag.kind === 'text') {
        const L = state.texts[state.tsel];
        if (!L) return;
        let nx = drag.lx + ((e.clientX - drag.x) * cmPerScreen) / lay.face.w, ny = drag.ly + ((e.clientY - drag.y) * cmPerScreen) / lay.face.h;
        state.snap = { x: Math.abs(nx - 0.5) < 0.012, y: Math.abs(ny - 0.5) < 0.012 };
        if (state.snap.x) nx = 0.5;
        if (state.snap.y) ny = 0.5;
        L.x = clamp(nx, -0.2, 1.2); L.y = clamp(ny, -0.2, 1.2);
        touch();
        redraw();
        return;
      }
      const p = state.photos[drag.i], cell = lay.cells[drag.i];
      if (!p || !cell) return;
      const c = cropOf(p, cell, p.src.width, p.src.height), s = (cell.w / cmPerScreen) / c.w; // экранных точек на точку фото
      const slackX = p.src.width - c.w, slackY = p.src.height - c.h;
      if (slackX > 0.5) p.fx = clamp(drag.fx - (e.clientX - drag.x) / s / slackX, 0, 1);
      if (slackY > 0.5) p.fy = clamp(drag.fy - (e.clientY - drag.y) / s / slackY, 0, 1);
      touch();
      redraw();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) {
      stage.addEventListener(ev, function (e) {
        if (!touches.has(e.pointerId) && ev === 'lostpointercapture') return;
        touches.delete(e.pointerId); if (touches.size < 2) pinch = null;
        if (drag && drag.kind === 'text') { state.dragText = false; state.snap = null; if (state.step !== 5) redraw(); else redraw(); }
        drag = null; stage.classList.remove('panning');
      });
    });
    stage.addEventListener('dblclick', function (e) {
      if (!state.photos.length || state.tab !== 'layout') return;
      const i = textAt(state.lay, toCm(e));
      if (i >= 0) { state.tsel = i; setStep(5); renderTextList(); setTimeout(function () { $('tText').focus(); }, 30); }
    });
    stage.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !state.photos.length || state.tab !== 'layout') return;
      e.preventDefault();
      const ci = cellAt(state.lay, toCm(e));
      if (ci >= 0 && ci !== state.sel) selectCell(ci);
      const ph = state.photos[state.sel];
      if (!ph) return;
      ph.zoom = clamp(ph.zoom * Math.exp(-e.deltaY * 0.01), 1, 4);
      touch(); syncSelection(); redraw();
    }, { passive: false });
    // стрелки двигают выбранную надпись: 1 мм, с Shift — 1 см
    document.addEventListener('keydown', function (e) {
      if (state.step !== 5 || !state.texts[state.tsel] || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (d) {
        e.preventDefault();
        const L = state.texts[state.tsel], lay = state.lay, step = e.shiftKey ? 1 : 0.1;
        L.x = clamp(L.x + (d[0] * step) / lay.face.w, -0.2, 1.2); L.y = clamp(L.y + (d[1] * step) / lay.face.h, -0.2, 1.2);
        touch(); redraw();
      } else if (e.key === 'Delete') { e.preventDefault(); $('tDel').click(); }
    });
  }

  // ---------- события ----------
  function init() {
    A.translateDom(document.body);
    setupHints();
    $('version').textContent = VERSION;
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === A.lang ? 'true' : 'false');
      b.addEventListener('click', function () { if (b.dataset.lang !== A.lang) { A.setLang(b.dataset.lang); location.reload(); } });
    });
    loadSettings();
    syncOutputs();
    renderFxList();
    setStep(1);
    TX.loadUserFonts().then(function (n) { if (n) { TX.resetCache(); fillTextEditor(); } });

    ['drop', 'emptyPick'].forEach(function (id) { $(id).addEventListener('click', function () { $('file').click(); }); });
    $('file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    $('replaceFile').addEventListener('change', function (e) { addFiles(e.target.files, state.sel); e.target.value = ''; });
    $('photoReplace').addEventListener('click', function () { $('replaceFile').click(); });
    $('photoRemove').addEventListener('click', function () { removePhoto(state.sel); });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (!fs || !fs.length) return;
      if (fs.length === 1 && /\.almaz$|\.json$/i.test(fs[0].name)) openProject(fs[0]); else addFiles(fs);
    });
    document.addEventListener('paste', function (e) {
      const t = e.target, cd = e.clipboardData;
      if (!cd || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const f = Array.prototype.filter.call(cd.files, function (x) { return /^image\//.test(x.type); });
      if (f.length) { e.preventDefault(); addFiles(f); }
    });
    $('projOpen').addEventListener('click', function () { $('projFile').click(); });
    $('projFile').addEventListener('change', function (e) { openProject(e.target.files[0]); e.target.value = ''; });
    $('projSave').addEventListener('click', saveProject);
    $('previewSave').addEventListener('click', savePreview);

    ['wCm', 'hCm', 'wrap', 'wrapMode', 'wrapColor', 'gap', 'margin', 'radius', 'bgColor', 'colorMode', 'order'].forEach(function (id) {
      const on = function () { syncOutputs(); saveSettings(); touch(); redraw(); if (id === 'wCm' || id === 'hCm') renderTemplates(); };
      $(id).addEventListener('input', on);
      $(id).addEventListener('change', on);
    });
    ADJUST.concat(['tone', 'autoLevel', 'fxSize', 'fxRelief', 'fxAmount']).forEach(function (id) {
      const on = function () { syncOutputs(); touch(); redraw(); };
      $(id).addEventListener('input', on);
      $(id).addEventListener('change', on);
    });
    $('zoom').addEventListener('input', function () {
      const ph = state.photos[state.sel];
      if (ph) { ph.zoom = clamp(+$('zoom').value / 100, 1, 4); touch(); }
      syncOutputs(); redraw();
    });
    $('sizePreset').addEventListener('change', function (e) {
      if (e.target.value === 'custom') { $('wCm').focus(); return; }
      const wh = e.target.value.split('x'), land = +$('wCm').value >= +$('hCm').value;
      $('wCm').value = land ? wh[1] : wh[0];
      $('hCm').value = land ? wh[0] : wh[1];
      state.photos.forEach(function (ph) { ph.fx = ph.fy = 0.5; });
      syncOutputs(); saveSettings(); touch(); renderTemplates(); redraw();
    });
    $('swap').addEventListener('click', function () {
      const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w;
      state.photos.forEach(function (ph) { ph.fx = ph.fy = 0.5; });
      syncOutputs(); saveSettings(); touch(); renderTemplates(); redraw();
    });
    $('rotL').addEventListener('click', function () { turn({ rot: -90 }); });
    $('rotR').addEventListener('click', function () { turn({ rot: 90 }); });
    $('flipH').addEventListener('click', function () { turn({ flipX: true }); });
    $('flipV').addEventListener('click', function () { turn({ flipY: true }); });
    $('cellPrev').addEventListener('click', function () { swapCells(state.sel, state.sel - 1); });
    $('cellNext').addEventListener('click', function () { swapCells(state.sel, state.sel + 1); });
    $('resetAdjust').addEventListener('click', function () {
      ADJUST.forEach(function (id) { $(id).value = 0; });
      $('tone').value = 'color';
      $('autoLevel').checked = false;
      $('fxAmount').value = 100;
      setEffect('none');
    });

    // надписи
    $('textAdd').addEventListener('click', addText);
    Object.keys(TFIELDS).forEach(function (id) {
      const f = TFIELDS[id], el = $(id);
      const on = function () {
        const L = state.texts[state.tsel];
        if (!L) return;
        setPath(L, f[0], f[1] === 'check' ? el.checked : f[1] === 'num' ? +el.value : el.value);
        syncTextOutputs();
        textChanged(id === 'tText' || id === 'tFont' || id === 'tSize');
      };
      el.addEventListener('input', on);
      el.addEventListener('change', on);
    });
    $('tBold').addEventListener('click', function () { const L = state.texts[state.tsel]; if (!L) return; L.bold = !L.bold; $('tBold').setAttribute('aria-pressed', L.bold ? 'true' : 'false'); textChanged(); });
    $('tItalic').addEventListener('click', function () { const L = state.texts[state.tsel]; if (!L) return; L.italic = !L.italic; $('tItalic').setAttribute('aria-pressed', L.italic ? 'true' : 'false'); textChanged(); });
    document.querySelectorAll('input[name=tAlign]').forEach(function (r) { r.addEventListener('change', function () { const L = state.texts[state.tsel]; if (L && r.checked) { L.align = r.value; textChanged(); } }); });
    $('tPresets').addEventListener('click', function (e) {
      const b = e.target.closest('[data-preset]'), L = state.texts[state.tsel];
      if (!b || !L) return;
      TX.applyPreset(L, b.dataset.preset);
      fillTextEditor();
      textChanged();
    });
    const place = function (fn) { return function () { const L = state.texts[state.tsel]; if (!L) return; fn(L); touch(); redraw(); }; };
    $('tCenterX').addEventListener('click', place(function (L) { L.x = 0.5; }));
    $('tTop').addEventListener('click', place(function (L) { L.y = 0.14; }));
    $('tMiddle').addEventListener('click', place(function (L) { L.y = 0.5; }));
    $('tBottom').addEventListener('click', place(function (L) { L.y = 0.86; }));
    $('tDup').addEventListener('click', function () {
      const L = state.texts[state.tsel];
      if (!L) return;
      const c = JSON.parse(JSON.stringify(L));
      c.y = clamp(c.y - 0.12, 0.05, 0.95);
      state.texts.push(c); state.tsel = state.texts.length - 1;
      touch(); renderTextList(); redraw();
    });
    $('tDel').addEventListener('click', function () {
      if (!state.texts[state.tsel]) return;
      state.texts.splice(state.tsel, 1);
      state.tsel = Math.min(state.tsel, state.texts.length - 1);
      touch(); renderTextList(); redraw();
    });
    $('tFontAdd').addEventListener('click', function () { $('tFontFile').click(); });
    $('tFontFile').addEventListener('change', async function (e) {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const family = await TX.addUserFont(f);
        TX.resetCache();
        const L = state.texts[state.tsel];
        if (L) L.font = family;
        fillTextEditor(); textChanged(true);
        setStatus(T('Шрифт добавлен: ') + family + T('. Он сохранится в этом браузере.'), 'ok');
      } catch (err) {
        console.error(err);
        setStatus(err && err.code === 'type' ? T('Нужен файл шрифта TTF, OTF или WOFF.') : T('Не удалось прочитать шрифт.'), 'error');
      }
    });

    document.querySelectorAll('[data-go]').forEach(function (b) { b.addEventListener('click', function () { setStep(+b.dataset.go); }); });
    $('stepBack').addEventListener('click', function () { setStep(state.step - 1); });
    $('stepNext').addEventListener('click', function () { setStep(state.step + 1); });
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
    $('save').addEventListener('click', save);
    $('saveTop').addEventListener('click', save); // скачать можно с любого этапа, не доходя до последнего
    $('panelToggle').addEventListener('click', function () {
      const hidden = document.body.classList.toggle('hide-panel');
      $('panelToggle').setAttribute('aria-pressed', hidden ? 'false' : 'true');
      fit();
    });
    setupStage();
    window.addEventListener('resize', fit);
    window.addEventListener('beforeunload', function (e) { if (state.photos.length && state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  A.canvasApp = {
    state: state, params: params, layoutOf: layoutOf, outputSize: outputSize, buildFile: buildFile, setStep: setStep, selectTab: selectTab,
    addFiles: addFiles, fileName: fileName, setEffect: setEffect, addText: addText, renderPrint: renderPrint, cellDpi: cellDpi,
    loadUrl: function (url, name) { return fetch(url).then(function (r) { return r.blob(); }).then(function (b) { return addFiles([new File([b], name || 'photo.jpg', { type: b.type || 'image/jpeg' })]); }); }
  };
  init();
})(window.ALMAZ = window.ALMAZ || {});
