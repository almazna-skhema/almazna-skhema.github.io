/* Интерфейс: настройки, предпросмотр, список цветов, выгрузка файлов. */
(function (A) {
  'use strict';

  const VERSION = 'версия 4 · 16.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  const defaultPal = A.parsePalette(A.DMC_RAW);
  let pal = defaultPal;      // действующая таблица цветов
  let palName = '';
  let palNote = '';          // что не удалось прочитать в загруженной таблице
  let wantColors = 26;       // сколько цветов просил пользователь (таблица может вместить меньше)
  const state = {
    img: null, imgUrl: '', thumb: null, logo: null, logoUrl: '',
    res: null, p: null, tab: 'mosaic', zoom: 1, cache: {},
    focusX: 0.5, focusY: 0.5, highlightCode: null, excluded: new Set(), busy: false
  };
  const SAVED = ['wCm', 'hCm', 'nColors', 'cleanup', 'smooth', 'urls', 'gram'];
  const DEFAULTS = { wCm: 40, hCm: 50, nColors: 26, cleanup: 1, smooth: 20, dither: 0, brightness: 0, contrast: 0, saturation: 0, gram: '0,0057' };
  const FILE_NAMES = { mosaic: 'Вид мозаики.png', scheme: 'Схема для печати.png', legend: 'Легенда.png', layout: 'Макет.png' };
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i;
  const MAX_IMAGE_PIXELS = 150e6;

  // ---------- мелочи ----------
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0'); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function setStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', kind === 'error');
    s.classList.toggle('ok', kind === 'ok');
  }

  // ---------- настройки ----------
  function readGram() {
    const g = parseFloat(String($('gram').value).replace(',', '.'));
    return g > 0 && g < 1 ? g : 0.0057;
  }

  function params() {
    const shape = document.querySelector('input[name=shape]:checked').value;
    const pitch = shape === 'round' ? 2.8 : 2.5;
    const wCm = clamp(parseFloat($('wCm').value) || DEFAULTS.wCm, 5, 120);
    const hCm = clamp(parseFloat($('hCm').value) || DEFAULTS.hCm, 5, 120);
    return {
      shape: shape, pitch: pitch, wCm: wCm, hCm: hCm,
      cols: Math.max(4, Math.round((wCm * 10) / pitch)),
      rows: Math.max(4, Math.round((hCm * 10) / pitch)),
      nColors: +$('nColors').value,
      cleanup: +$('cleanup').value,
      smooth: +$('smooth').value / 100,
      dither: +$('dither').value / 100,
      brightness: +$('brightness').value,
      contrast: +$('contrast').value,
      saturation: +$('saturation').value,
      focusX: state.focusX,
      focusY: state.focusY,
      article: $('article').value.trim(),
      title: $('title').value.trim(),
      urls: $('urls').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3),
      gramPerStone: readGram(),
      logo: state.logo
    };
  }

  /* Приводит поля к допустимым значениям, чтобы на экране было то, что реально считается. */
  function normalizeInputs() {
    ['wCm', 'hCm'].forEach(function (id) {
      const v = clamp(parseFloat($(id).value) || DEFAULTS[id], 5, 120);
      if (String(v) !== $(id).value) $(id).value = v;
    });
    $('gram').value = String(readGram()).replace('.', ',');
  }

  function saveSettings() {
    try {
      const o = {};
      SAVED.forEach(function (id) { o[id] = $(id).value; });
      o.nColors = String(wantColors); // запоминаем желаемое число, а не урезанное маленькой таблицей
      o.shape = document.querySelector('input[name=shape]:checked').value;
      localStorage.setItem('almaz-settings', JSON.stringify(o));
    } catch (e) { /* хранилище недоступно — работаем без него */ }
  }

  function loadSettings() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-settings') || 'null');
      if (!o || typeof o !== 'object') return;
      SAVED.forEach(function (id) { if (typeof o[id] === 'string') $(id).value = o[id]; });
      const n = parseInt(o.nColors, 10);
      if (n >= 2 && n <= A.MAX_COLORS) wantColors = n; // сам ползунок мог обрезать значение
      const r = o.shape === 'round' || o.shape === 'square' ? document.querySelector('input[name=shape][value=' + o.shape + ']') : null;
      if (r) r.checked = true;
    } catch (e) { /* игнорируем */ }
  }

  function syncOutputs() {
    ['nColors', 'smooth', 'dither', 'brightness', 'contrast', 'saturation'].forEach(function (id) {
      $(id + 'Out').textContent = $(id).value;
    });
    const w = +$('wCm').value, h = +$('hCm').value;
    const key = Math.min(w, h) + 'x' + Math.max(w, h); // пресеты записаны как «меньшая x большая»
    const preset = $('sizePreset');
    const has = Array.prototype.some.call(preset.options, function (o) { return o.value === key; });
    preset.value = has ? key : 'custom';
  }

  function exportCell(p, res) {
    const lc = A.layoutCells(res, p.pitch);
    let c = Math.ceil(11.82 * p.pitch); // не меньше 300 dpi: 30 точек на стразу 2,5 мм, 34 — на 2,8 мм
    while (c > 8 && lc.cols * lc.rows * c * c > 96e6) c--; // очень большие холсты печатаем с меньшим разрешением
    return c;
  }

  function dpiOf(cell, p) { return Math.round((cell / p.pitch) * 25.4); }

  function updateStats() {
    const p = state.p || params();
    let text = p.cols + ' × ' + p.rows + ' страз · ' + fmt(p.cols * p.rows) + ' шт';
    if (state.res) text += ' · печать ' + dpiOf(exportCell(p, state.res), p) + ' dpi';
    $('stats').textContent = text;
  }

  // ---------- расчёт ----------
  let timer = null, pendingFull = false;

  function schedule(full) {
    syncOutputs();
    saveSettings();
    if (!state.img) { state.p = params(); updateStats(); return; }
    pendingFull = pendingFull || full; // пересчёт не должен теряться, если следом поменяли текстовое поле
    clearTimeout(timer);
    if (pendingFull) setStatus('Считаю…');
    timer = setTimeout(flush, pendingFull ? 140 : 250);
  }

  function flush() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const full = pendingFull;
    pendingFull = false;
    if (full) recompute(); else rerender();
  }

  function activePalette() {
    return state.excluded.size ? A.paletteWithout(pal, state.excluded) : pal;
  }

  /* Убирает холсты предпросмотра из памяти (на планшетах она быстро кончается). */
  function dropCache(kinds) {
    (kinds || Object.keys(state.cache)).forEach(function (k) {
      release(state.cache[k]);
      delete state.cache[k];
    });
  }

  function highlightIndex() {
    if (!state.res || state.highlightCode === null) return -1;
    for (let i = 0; i < state.res.colors.length; i++) if (state.res.colors[i].code === state.highlightCode) return i;
    return -1;
  }

  function recompute() {
    if (!state.img) return;
    const p = params();
    const t0 = performance.now();
    let res;
    try {
      const grid = A.sampleGrid(state.img, p.cols, p.rows, p);
      res = A.quantize(grid, activePalette(), p);
    } catch (e) {
      // старую схему не оставляем: иначе скачается результат от прежней картинки или настроек
      console.error(e);
      state.res = null;
      dropCache();
      $('holder').textContent = '';
      $('holder').hidden = true;
      $('empty').hidden = false;
      $('zip').disabled = $('saveOne').disabled = true;
      setStatus('Не удалось обработать картинку. Попробуйте сохранить её как JPG или PNG и загрузить снова.', 'error');
      return;
    }
    state.p = p;
    state.res = res;
    if (highlightIndex() < 0) state.highlightCode = null;
    dropCache();
    updateStats();
    drawCrop();
    renderColorList();
    showTab();
    if (!state.busy) $('zip').disabled = false;
    const got = res.colors.length, asked = Math.min(p.nColors, activePalette().items.length);
    setStatus('Готово за ' + ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',') + ' с' +
      (got < asked ? ' · цветов вышло ' + got + ' из ' + asked + ': остальные на этой картинке не понадобились' : ''));
  }

  function rerender() {
    if (!state.res) return;
    const gramBefore = state.p.gramPerStone;
    state.p = params();
    dropCache(['legend', 'layout']);
    updateStats();
    if (state.p.gramPerStone !== gramBefore) renderColorList();
    showTab();
  }

  // ---------- предпросмотр ----------
  function previewCell(kind) {
    const res = state.res, p = state.p;
    const cells = kind === 'layout' ? A.layoutCells(res, p.pitch) : res;
    const base = kind === 'scheme' ? 20 : 10;
    let c = clamp(Math.ceil(1400 / Math.max(cells.cols, cells.rows)), base, 48); // маленькие холсты рисуем крупнее, чтобы не мылились
    const maxArea = kind === 'scheme' ? 16e6 : 6e6;
    while (c > 2 && cells.cols * cells.rows * c * c > maxArea) c--;
    return c;
  }

  function getCanvas(kind) {
    if (state.cache[kind]) return state.cache[kind];
    const res = state.res, p = state.p, hi = highlightIndex();
    let cv;
    if (kind === 'original') {
      const iw = state.img.naturalWidth, ih = state.img.naturalHeight;
      const k = clamp(Math.floor(1600 / Math.max(p.cols, p.rows)), 2, 8);
      cv = A.downscale(state.img, A.cropRect(iw, ih, p.cols, p.rows, p.focusX, p.focusY), p.cols * k, p.rows * k);
    } else if (kind === 'mosaic') cv = A.renderMosaic(res, previewCell(kind), p.shape, hi);
    else if (kind === 'scheme') cv = A.renderScheme(res, previewCell(kind), p.shape, hi);
    else if (kind === 'legend') cv = A.renderLegend(res, p);
    else {
      const c = previewCell(kind);
      const tmp = A.renderScheme(res, c, p.shape);
      cv = A.renderLayout(res, p, state.img, c, tmp);
      release(tmp);
    }
    state.cache[kind] = cv;
    return cv;
  }

  function fitScale(cv) {
    const stage = $('stage');
    return Math.max(0.02, Math.min((stage.clientWidth - 40) / cv.width, (stage.clientHeight - 40) / cv.height));
  }

  function applyZoom() {
    const cv = $('holder').firstChild;
    if (!cv) return;
    const scale = fitScale(cv) * state.zoom;
    cv.style.width = Math.max(1, Math.round(cv.width * scale)) + 'px';
    cv.style.height = Math.max(1, Math.round(cv.height * scale)) + 'px';
    $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    $('stage').classList.toggle('pannable', state.zoom > 1.01);
  }

  /* Масштаб меняется вокруг точки под курсором (или центра окна просмотра). */
  function setZoom(z, clientX, clientY) {
    const cv = $('holder').firstChild, stage = $('stage');
    z = clamp(z, 0.25, 16);
    if (!cv) { state.zoom = z; return; }
    const sr = stage.getBoundingClientRect();
    const cx = clientX === undefined ? sr.left + sr.width / 2 : clientX;
    const cy = clientY === undefined ? sr.top + sr.height / 2 : clientY;
    const r0 = cv.getBoundingClientRect();
    const fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height;
    state.zoom = z;
    applyZoom();
    const r1 = cv.getBoundingClientRect();
    stage.scrollLeft += r1.left + fx * r1.width - cx;
    stage.scrollTop += r1.top + fy * r1.height - cy;
  }

  function showTab() {
    if (!state.res) return;
    const holder = $('holder');
    $('empty').hidden = true;
    holder.hidden = false;
    const cv = getCanvas(state.tab);
    if (holder.firstChild !== cv) {
      holder.textContent = '';
      holder.appendChild(cv);
    }
    $('saveOne').disabled = state.tab === 'original' || state.busy;
    applyZoom();
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    showTab();
  }

  // ---------- рамка кадрирования ----------
  let cropGeom = null;

  function drawCrop() {
    const box = $('cropBox');
    if (!state.img || !state.thumb) { box.hidden = true; return; }
    const p = state.p || params();
    const iw = state.img.naturalWidth, ih = state.img.naturalHeight;
    const r = A.cropRect(iw, ih, p.cols, p.rows, state.focusX, state.focusY);
    const slackX = iw - r.w, slackY = ih - r.h;
    if (slackX < 1 && slackY < 1) { box.hidden = true; cropGeom = null; return; }
    box.hidden = false;
    const cv = $('cropCanvas');
    const scale = Math.min((box.clientWidth || 300) / iw, 190 / ih);
    const w = Math.max(20, Math.round(iw * scale)), h = Math.max(20, Math.round(ih * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.drawImage(state.thumb, 0, 0, w, h);
    const rx = r.x * scale, ry = r.y * scale, rw = r.w * scale, rh = r.h * scale;
    x.fillStyle = 'rgba(0,0,0,0.6)';
    x.fillRect(0, 0, w, ry);
    x.fillRect(0, ry + rh, w, h - ry - rh);
    x.fillRect(0, ry, rx, rh);
    x.fillRect(rx + rw, ry, w - rx - rw, rh);
    x.strokeStyle = '#ffffff';
    x.lineWidth = 2;
    x.strokeRect(rx + 1, ry + 1, Math.max(1, rw - 2), Math.max(1, rh - 2));
    cropGeom = { scale: scale, slackX: slackX, slackY: slackY };
  }

  function initCropDrag() {
    const cv = $('cropCanvas');
    let last = null;
    cv.addEventListener('pointerdown', function (e) {
      if (!cropGeom) return;
      last = { x: e.clientX, y: e.clientY };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!last || !cropGeom) return;
      const dx = (e.clientX - last.x) / cropGeom.scale, dy = (e.clientY - last.y) / cropGeom.scale;
      last = { x: e.clientX, y: e.clientY };
      if (cropGeom.slackX >= 1) state.focusX = clamp(state.focusX + dx / cropGeom.slackX, 0, 1);
      if (cropGeom.slackY >= 1) state.focusY = clamp(state.focusY + dy / cropGeom.slackY, 0, 1);
      drawCrop();
      schedule(true);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      cv.addEventListener(ev, function () { last = null; });
    });
  }

  // ---------- список цветов ----------
  function renderColorList() {
    const res = state.res, p = state.p;
    if (!res) return;
    $('colorsPanel').hidden = false;
    document.body.classList.add('with-colors');
    const list = $('colorList');
    list.textContent = '';
    const hi = highlightIndex();
    const canExclude = res.colors.length > 2 && pal.items.length - state.excluded.size > 2;
    let total = 0, totalG = 0;
    res.colors.forEach(function (c, i) {
      const g = A.grams(c.count, p.gramPerStone);
      total += c.count;
      totalG += g;
      const li = el('li');
      const row = el('button', 'color-row');
      row.type = 'button';
      row.setAttribute('aria-pressed', i === hi ? 'true' : 'false');
      row.title = 'Подсветить цвет ' + c.code + ' на схеме';
      const sw = el('span', 'swatch', c.symbol);
      sw.style.backgroundColor = c.hex;
      sw.style.color = c.dark ? '#ffffff' : '#000000';
      row.appendChild(sw);
      row.appendChild(el('span', 'code', c.code));
      row.appendChild(el('span', '', fmt(c.count)));
      row.appendChild(el('span', 'muted', g + ' г'));
      row.addEventListener('click', function () { toggleHighlight(c.code); });
      const x = el('button', 'color-x', '×');
      x.type = 'button';
      x.title = 'Убрать цвет ' + c.code + ' из схемы';
      x.setAttribute('aria-label', x.title);
      x.disabled = !canExclude;
      x.addEventListener('click', function () { excludeColor(c.code); });
      li.appendChild(row);
      li.appendChild(x);
      list.appendChild(li);
    });
    $('sumColors').textContent = res.colors.length;
    $('sumStones').textContent = fmt(total);
    $('sumGrams').textContent = '≈ ' + fmt(totalG);

    const box = $('excludedBox');
    box.textContent = '';
    box.hidden = state.excluded.size === 0;
    if (state.excluded.size) {
      box.appendChild(el('span', '', 'Убраны:'));
      state.excluded.forEach(function (code) {
        const chip = el('button', 'chip', code + ' ↩');
        chip.type = 'button';
        chip.title = 'Вернуть цвет ' + code;
        chip.addEventListener('click', function () { state.excluded.delete(code); schedule(true); });
        box.appendChild(chip);
      });
    }
  }

  function toggleHighlight(code) {
    state.highlightCode = state.highlightCode === code ? null : code;
    dropCache(['mosaic', 'scheme']);
    const hi = highlightIndex();
    $('colorList').querySelectorAll('.color-row').forEach(function (row, i) {
      row.setAttribute('aria-pressed', i === hi ? 'true' : 'false');
    });
    if (state.tab !== 'mosaic' && state.tab !== 'scheme') selectTab('mosaic'); else showTab();
  }

  function excludeColor(code) {
    if (pal.items.length - state.excluded.size <= 2) return; // в таблице должно остаться хотя бы два цвета
    state.excluded.add(code);
    if (state.highlightCode === code) state.highlightCode = null;
    schedule(true);
  }

  // ---------- выгрузка ----------
  function canvasPng(cv, pxPerMm) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        if (!blob) { reject(new Error('браузеру не хватило памяти на такой размер')); return; }
        blob.arrayBuffer().then(function (buf) {
          const bytes = new Uint8Array(buf);
          resolve(pxPerMm ? A.pngSetDpi(bytes, pxPerMm) : bytes);
        }, reject);
      }, 'image/png');
    });
  }

  function release(cv) { if (cv) cv.width = cv.height = 0; }

  /* Некоторые устройства (iPad, iPhone) молча отдают пустой холст, если он слишком
   * большой. Проверяем, что на холсте такого размера реально можно рисовать. */
  function canvasWorks(sizes) {
    const made = [];
    try {
      return sizes.every(function (wh) {
        const c = A.makeCanvas(wh[0], wh[1]);
        made.push(c);
        const x = c.getContext('2d');
        if (!x) return false;
        x.fillStyle = '#000000';
        x.fillRect(wh[0] - 1, wh[1] - 1, 1, 1);
        return x.getImageData(wh[0] - 1, wh[1] - 1, 1, 1).data[3] === 255;
      });
    } catch (e) {
      return false;
    } finally {
      made.forEach(release);
    }
  }

  /* Размер клетки для печати, который устройство реально потянет. Проверяем те холсты,
   * что будут нужны одновременно: схему и, если просили макет, лист макета. */
  function safeExportCell(p, res, kinds) {
    const needScheme = kinds.indexOf('scheme') >= 0 || kinds.indexOf('layout') >= 0;
    let c = exportCell(p, res);
    if (!needScheme) return c;
    const lc = A.layoutCells(res, p.pitch);
    function sizes(cell) {
      const list = [[res.cols * cell, res.rows * cell]];
      if (kinds.indexOf('layout') >= 0) list.push([Math.ceil(lc.cols * cell) + 2, Math.ceil(lc.rows * cell) + 2]);
      return list;
    }
    while (c > 8 && !canvasWorks(sizes(c))) c = Math.max(8, c - 4);
    return c;
  }

  /* Собирает файлы в печатном разрешении. kinds: массив из mosaic|scheme|legend|layout|csv */
  async function buildFiles(kinds) {
    const res = state.res, p = state.p;
    const img = state.img; // снимок состояния: во время сборки пользователь может что-то поменять
    const cell = safeExportCell(p, res, kinds), pxmm = cell / p.pitch;
    const out = [];
    let scheme = null, cv = null;
    try {
      if (kinds.indexOf('scheme') >= 0 || kinds.indexOf('layout') >= 0) scheme = A.renderScheme(res, cell, p.shape);
      for (const kind of kinds) {
        await wait(20); // даём браузеру обновить надпись о ходе работы
        if (kind === 'csv') {
          out.push({ name: 'Расход страз.csv', data: new TextEncoder().encode(A.legendCsv(res, p)) });
        } else if (kind === 'scheme') {
          out.push({ name: FILE_NAMES.scheme, data: await canvasPng(scheme, pxmm) });
        } else if (kind === 'layout') {
          cv = A.renderLayout(res, p, img, cell, scheme);
          out.push({ name: FILE_NAMES.layout, data: await canvasPng(cv, pxmm) });
        } else if (kind === 'mosaic') {
          const mc = Math.min(cell, 16);
          cv = A.renderMosaic(res, mc, p.shape);
          out.push({ name: FILE_NAMES.mosaic, data: await canvasPng(cv, mc / p.pitch) });
        } else if (kind === 'legend') {
          cv = A.renderLegend(res, p);
          out.push({ name: FILE_NAMES.legend, data: await canvasPng(cv, 0) });
        }
        release(cv);
        cv = null;
      }
    } finally {
      release(cv);
      release(scheme);
    }
    out.dpi = scheme ? dpiOf(cell, p) : 0; // 0 — печатное разрешение для этих файлов не важно
    return out;
  }

  function baseName() {
    const p = state.p;
    const s = [p.article, p.title].filter(Boolean).join(' ')
      .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 80).trim();
    return s || 'Схема ' + p.wCm + 'x' + p.hCm;
  }

  function download(parts, name, type) {
    const url = URL.createObjectURL(new Blob(parts, { type: type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  async function runExport(button, label, job) {
    if (!state.res || state.busy) return;
    flush(); // если настройки только что меняли — сначала досчитать, чтобы файл совпал с экраном
    if (!state.res) return;
    state.busy = true;
    const old = button.textContent;
    $('zip').disabled = $('saveOne').disabled = true;
    button.textContent = label;
    setStatus('Готовлю файлы в печатном качестве, это займёт несколько секунд…');
    await wait(40);
    try {
      const wanted = dpiOf(exportCell(state.p, state.res), state.p);
      const dpi = await job();
      setStatus(dpi && dpi < wanted
        ? 'Сохранено, но с разрешением ' + dpi + ' dpi: это устройство не справляется с большим. Для печати лучше скачать с компьютера.'
        : 'Сохранено в папку загрузок', 'ok');
    } catch (e) {
      console.error(e);
      setStatus('Не получилось сохранить: браузеру не хватило памяти. Уменьшите размер холста или скачайте с компьютера.', 'error');
    }
    button.textContent = old;
    state.busy = false;
    $('zip').disabled = !state.res;
    $('saveOne').disabled = !state.res || state.tab === 'original';
  }

  function saveZip() {
    return runExport($('zip'), 'Собираю комплект…', async function () {
      const name = baseName();
      const files = await buildFiles(['layout', 'scheme', 'mosaic', 'legend', 'csv']);
      download(A.zipStore(files), name + '.zip', 'application/zip');
      return files.dpi;
    });
  }

  function saveOne() {
    if (state.tab === 'original') return Promise.resolve();
    return runExport($('saveOne'), 'Готовлю файл…', async function () {
      const name = baseName();
      const files = await buildFiles([state.tab]);
      download([files[0].data], name + ' — ' + files[0].name, 'image/png');
      return files.dpi;
    });
  }

  // ---------- загрузка картинок ----------
  function isImageFile(file) {
    return /^image\//.test(file.type) || IMAGE_EXT.test(file.name);
  }

  function loadImage(src, name, isBlob) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih || iw * ih > MAX_IMAGE_PIXELS) {
          if (isBlob) URL.revokeObjectURL(src);
          setStatus(iw && ih ? 'Картинка слишком большая. Уменьшите её до 10 000 точек по длинной стороне.' : 'В файле нет изображения.', 'error');
          reject(new Error('bad image size'));
          return;
        }
        let thumbCanvas, thumbUrl;
        try {
          const k = Math.min(1, 640 / Math.max(iw, ih));
          thumbCanvas = A.downscale(img, { x: 0, y: 0, w: iw, h: ih }, Math.max(1, Math.round(iw * k)), Math.max(1, Math.round(ih * k)));
          thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.8);
        } catch (e) {
          console.error(e);
          if (isBlob) URL.revokeObjectURL(src);
          setStatus('Не удалось прочитать эту картинку. Сохраните её как JPG или PNG и загрузите снова.', 'error');
          reject(e);
          return;
        }
        if (state.imgUrl) URL.revokeObjectURL(state.imgUrl); // прежняя картинка больше не нужна
        release(state.thumb);
        state.img = img;
        state.imgUrl = isBlob ? src : '';
        state.thumb = thumbCanvas;
        // холст разворачиваем под ориентацию картинки
        const w = +$('wCm').value, h = +$('hCm').value;
        if ((iw > ih * 1.05 && w < h) || (ih > iw * 1.05 && w > h)) { $('wCm').value = h; $('hCm').value = w; }
        state.focusX = state.focusY = 0.5;
        state.zoom = 1;
        state.excluded.clear(); // убранные цвета относятся к прежней картинке
        state.highlightCode = null;
        const thumb = $('dropThumb');
        thumb.textContent = '';
        thumb.style.backgroundImage = 'url("' + thumbUrl + '")';
        $('dropTitle').textContent = name || 'Картинка загружена';
        $('dropHint').textContent = fmt(iw) + ' × ' + fmt(ih) + ' точек · нажмите, чтобы заменить';
        syncOutputs();
        saveSettings();
        clearTimeout(timer);
        timer = null;
        pendingFull = false;
        recompute();
        resolve();
      };
      img.onerror = function () {
        if (isBlob) URL.revokeObjectURL(src);
        setStatus('Не удалось открыть файл. Подойдут JPG, PNG, WebP. Фото с iPhone в формате HEIC сначала сохраните как JPG.', 'error');
        reject(new Error('image load failed'));
      };
      img.src = src;
    });
  }

  function loadFile(file) {
    if (!file) return;
    if (/\.(csv|txt)$/i.test(file.name)) { loadPaletteFile(file); return; } // таблицу цветов тоже можно перетащить
    if (!isImageFile(file)) { setStatus('Это не картинка. Подойдут JPG, PNG, WebP.', 'error'); return; }
    setStatus('Открываю картинку…');
    loadImage(URL.createObjectURL(file), file.name, true).catch(function () {});
  }

  function setLogo(img, url, name) {
    if (state.logoUrl) URL.revokeObjectURL(state.logoUrl);
    state.logo = img;
    state.logoUrl = url || '';
    $('logoName').textContent = img ? name : 'Логотип и QR-коды';
    $('logoHint').textContent = img ? 'Стоит внизу макета' : 'Одна картинка PNG — встанет внизу макета';
    $('logoReset').hidden = !img;
    schedule(false);
  }

  function loadLogo(file) {
    if (!file) return;
    if (!isImageFile(file)) { setStatus('Логотип должен быть картинкой: PNG или JPG.', 'error'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () { setLogo(img, url, file.name); };
    img.onerror = function () { URL.revokeObjectURL(url); setStatus('Не удалось открыть логотип', 'error'); };
    img.src = url;
  }

  // ---------- своя таблица цветов ----------
  function showPalette() {
    const custom = pal !== defaultPal;
    const n = pal.items.length;
    $('palName').textContent = custom ? palName : 'Открытая таблица DMC';
    $('palHint').textContent = custom
      ? 'Ваша таблица, цветов: ' + n + palNote
      : n + ' цвета ниток — оттенки страз могут отличаться';
    $('palReset').hidden = !custom;
    const range = $('nColors');
    range.min = Math.min(5, n);
    range.max = Math.min(A.MAX_COLORS, n);
    range.value = clamp(wantColors, +range.min, +range.max); // маленькая таблица не должна навсегда сбивать выбранное число цветов
  }

  function paletteText() {
    return ['Номер;Цвет'].concat(pal.items.map(function (it) {
      return (/[";\r\n]/.test(it.code) ? '"' + it.code.replace(/"/g, '""') + '"' : it.code) + ';' + it.hex;
    })).join('\r\n') + '\r\n';
  }

  function storePalette() {
    try {
      if (pal === defaultPal) { localStorage.removeItem('almaz-palette'); return; }
      localStorage.setItem('almaz-palette', JSON.stringify({ name: palName, text: paletteText() }));
    } catch (e) { /* не сохранилось — таблица просто действует до закрытия страницы */ }
  }

  function setPalette(next, name, note) {
    pal = next;
    palName = name;
    palNote = note || '';
    state.excluded.clear();
    state.highlightCode = null;
    showPalette();
    storePalette();
  }

  /* Возвращает true, если таблица принята. */
  function loadPaletteText(text, name) {
    const parsed = A.parsePaletteText(text);
    if (parsed.items.length < 2) {
      setStatus('В файле не нашлось цветов. Нужна таблица: в каждой строке номер и цвет (#rrggbb или R;G;B).', 'error');
      return false;
    }
    const note = (parsed.skipped ? ' · не прочитано строк: ' + parsed.skipped : '') +
      (parsed.tooMany ? ' · взяты первые ' + A.MAX_PALETTE : '');
    setPalette(A.paletteFromItems(parsed.items), String(name || 'Своя таблица').slice(0, 60), note);
    schedule(true);
    if (!state.img) setStatus('Таблица загружена, цветов: ' + parsed.items.length, 'ok');
    return true;
  }

  /* Excel сохраняет таблицы в разных кодировках: UTF-8, UTF-16 («Текст Юникод»), Windows-1251. */
  function decodeText(bytes) {
    try {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('windows-1251').decode(bytes); } catch (e2) { return new TextDecoder().decode(bytes); }
    }
  }

  function loadPaletteFile(file) {
    if (!file) return;
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      setStatus('Файлы Excel напрямую не читаются. Сохраните таблицу как CSV и загрузите её.', 'error');
      return;
    }
    if (file.size > 2e6) { setStatus('Файл таблицы слишком большой — в нём должны быть только номера и цвета.', 'error'); return; }
    file.arrayBuffer().then(function (buf) { loadPaletteText(decodeText(new Uint8Array(buf)), file.name); }, function () {
      setStatus('Не удалось прочитать файл таблицы', 'error');
    });
  }

  function resetPalette() {
    setPalette(defaultPal, '');
    schedule(true);
    if (!state.img) setStatus('Возвращена открытая таблица DMC');
  }

  function restorePalette() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-palette') || 'null');
      if (o && typeof o.text === 'string') {
        const parsed = A.parsePaletteText(o.text);
        if (parsed.items.length >= 2) {
          pal = A.paletteFromItems(parsed.items);
          palName = String(o.name || 'Своя таблица').slice(0, 60);
          palNote = '';
        }
      }
    } catch (e) { /* игнорируем */ }
    showPalette();
  }

  function savePaletteSample() {
    download(['\ufeff' + paletteText()], 'Таблица цветов — образец.csv', 'text/csv');
    setStatus('Образец сохранён: замените в нём цвета на цвета своих страз и загрузите обратно', 'ok');
  }

  function resetAll() {
    wantColors = DEFAULTS.nColors;
    Object.keys(DEFAULTS).forEach(function (id) { $(id).value = DEFAULTS[id]; });
    document.querySelector('input[name=shape][value=square]').checked = true;
    if (state.img && state.img.naturalWidth > state.img.naturalHeight * 1.05) { $('wCm').value = DEFAULTS.hCm; $('hCm').value = DEFAULTS.wCm; }
    state.focusX = state.focusY = 0.5;
    state.excluded.clear();
    state.highlightCode = null;
    drawCrop();
    schedule(true);
    if (!state.img) setStatus('Настройки сброшены');
  }

  // ---------- события ----------
  function init() {
    $('version').textContent = VERSION;
    loadSettings();
    restorePalette();
    $('nColors').addEventListener('input', function () { wantColors = +$('nColors').value; });
    normalizeInputs();
    syncOutputs();
    state.p = params();
    updateStats();

    document.querySelectorAll('[data-kind]').forEach(function (node) {
      const full = node.dataset.kind === 'full';
      node.addEventListener('input', function () { schedule(full); });
      node.addEventListener('change', function () {
        const before = $('wCm').value + '|' + $('hCm').value + '|' + $('gram').value;
        normalizeInputs();
        // «input» уже запустил пересчёт; повторяем, только если поля пришлось поправить
        if (before !== $('wCm').value + '|' + $('hCm').value + '|' + $('gram').value) schedule(full);
      });
    });

    $('sizePreset').addEventListener('change', function (e) {
      if (e.target.value === 'custom') { $('wCm').focus(); return; }
      const wh = e.target.value.split('x');
      const landscape = +$('wCm').value > +$('hCm').value;
      $('wCm').value = landscape ? wh[1] : wh[0];
      $('hCm').value = landscape ? wh[0] : wh[1];
      schedule(true);
    });
    $('swap').addEventListener('click', function () {
      const w = $('wCm').value;
      $('wCm').value = $('hCm').value;
      $('hCm').value = w;
      state.focusX = state.focusY = 0.5;
      schedule(true);
    });
    $('resetAdjust').addEventListener('click', function () {
      ['smooth', 'dither', 'brightness', 'contrast', 'saturation'].forEach(function (id) { $(id).value = DEFAULTS[id]; });
      schedule(true);
    });
    $('resetAll').addEventListener('click', resetAll);

    // выбор файлов — обычными кнопками, чтобы работало и с клавиатуры
    [['drop', 'file'], ['emptyPick', 'file'], ['palPick', 'palFile'], ['logoPick', 'logoFile']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () { $(pair[1]).click(); });
    });
    $('file').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
    $('logoFile').addEventListener('change', function (e) { loadLogo(e.target.files[0]); e.target.value = ''; });
    $('logoReset').addEventListener('click', function () { setLogo(null, '', ''); });
    $('palFile').addEventListener('change', function (e) { loadPaletteFile(e.target.files[0]); e.target.value = ''; });
    $('palReset').addEventListener('click', resetPalette);
    $('palSample').addEventListener('click', savePaletteSample);

    // перетаскивание и вставка из буфера
    const zones = [$('drop'), $('empty')];
    let dragDepth = 0;
    function dragMark(on) { zones.forEach(function (z) { z.classList.toggle('over', on); }); }
    document.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; dragMark(true); });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dragMark(false); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      dragMark(false);
      if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });
    document.addEventListener('paste', function (e) {
      const t = e.target, cd = e.clipboardData;
      // вставка текста в поле (из Excel вместе с текстом приходит и картинка ячейки) — не наша
      if (!cd || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || Array.prototype.indexOf.call(cd.types || [], 'text/plain') >= 0) return;
      const files = Array.prototype.slice.call(cd.files);
      const file = files.filter(isImageFile)[0];
      if (file) { e.preventDefault(); loadFile(file); }
    });

    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { state.zoom = 1; selectTab(btn.dataset.tab); });
    });

    // масштаб: кнопки, Ctrl + колесо (или щипок на тачпаде), перетаскивание мышью
    $('zoomIn').addEventListener('click', function () { setZoom(state.zoom * 1.5); });
    $('zoomOut').addEventListener('click', function () { setZoom(state.zoom / 1.5); });
    $('zoomFit').addEventListener('click', function () { state.zoom = 1; applyZoom(); });
    const stage = $('stage');
    stage.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !state.res) return;
      e.preventDefault();
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    let pan = null;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.pointerType === 'touch' || state.zoom <= 1.01 || !state.res) return;
      pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.classList.add('panning');
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pan) return;
      stage.scrollLeft = pan.left - (e.clientX - pan.x);
      stage.scrollTop = pan.top - (e.clientY - pan.y);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function () { pan = null; stage.classList.remove('panning'); });
    });
    window.addEventListener('resize', function () { applyZoom(); drawCrop(); });

    initCropDrag();
    $('zip').addEventListener('click', saveZip);
    $('saveOne').addEventListener('click', saveOne);
  }

  A.app = {
    state: state, buildFiles: buildFiles, params: params, flush: flush, selectTab: selectTab,
    loadUrl: function (url, name) { return loadImage(url, name, false); },
    loadPaletteText: loadPaletteText, resetPalette: resetPalette,
    toggleHighlight: toggleHighlight, excludeColor: excludeColor
  };
  init();
})(window.ALMAZ = window.ALMAZ || {});
