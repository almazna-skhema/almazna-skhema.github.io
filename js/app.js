/* Интерфейс: настройки, предпросмотр, выгрузка файлов. */
(function (A) {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const defaultPal = A.parsePalette(A.DMC_RAW);
  let pal = defaultPal;
  const state = { img: null, imgName: '', logo: null, res: null, p: null, tab: 'mosaic', zoom: 1, cache: {} };
  const SAVED = ['wCm', 'hCm', 'nColors', 'cleanup', 'smooth', 'urls', 'gram'];
  const FILE_NAMES = { mosaic: 'Вид мозаики.png', scheme: 'Схема для печати.png', legend: 'Легенда.png', layout: 'Макет.png' };

  // ---------- настройки ----------
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function params() {
    const shape = document.querySelector('input[name=shape]:checked').value;
    const pitch = shape === 'round' ? 2.8 : 2.5;
    const wCm = clamp(parseFloat($('wCm').value) || 40, 5, 120);
    const hCm = clamp(parseFloat($('hCm').value) || 50, 5, 120);
    const gram = parseFloat(String($('gram').value).replace(',', '.'));
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
      focusX: +$('focusX').value / 100,
      focusY: +$('focusY').value / 100,
      article: $('article').value.trim(),
      title: $('title').value.trim(),
      urls: $('urls').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      gramPerStone: gram > 0 && gram < 1 ? gram : 0.0057,
      logo: state.logo
    };
  }

  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function saveSettings() {
    try {
      const o = {};
      SAVED.forEach(function (id) { o[id] = $(id).value; });
      o.shape = document.querySelector('input[name=shape]:checked').value;
      localStorage.setItem('almaz-settings', JSON.stringify(o));
    } catch (e) { /* хранилище недоступно — работаем без него */ }
  }

  function loadSettings() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-settings') || 'null');
      if (!o) return;
      SAVED.forEach(function (id) { if (o[id] !== undefined) $(id).value = o[id]; });
      const r = document.querySelector('input[name=shape][value="' + o.shape + '"]');
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

  function updateStats() {
    const p = state.p || params();
    let text = p.cols + ' × ' + p.rows + ' страз · ' + fmt(p.cols * p.rows) + ' шт';
    if (state.res) {
      const dpi = Math.round((exportCell(p, state.res) / p.pitch) * 25.4);
      text += ' · ' + state.res.colors.length + ' цветов · печать ' + dpi + ' dpi';
    }
    $('stats').textContent = text;
  }

  // ---------- расчёт ----------
  let timer = null;
  function schedule(full) {
    syncOutputs();
    saveSettings();
    if (!state.img) { state.p = params(); updateStats(); return; }
    clearTimeout(timer);
    if (full) setStatus('Считаю…');
    timer = setTimeout(full ? recompute : rerender, full ? 140 : 250);
  }

  function recompute() {
    if (!state.img) return;
    const p = (state.p = params());
    const t0 = performance.now();
    try {
      const grid = A.sampleGrid(state.img, p.cols, p.rows, p);
      state.res = A.quantize(grid, pal, p);
    } catch (e) {
      setStatus('Не удалось обработать картинку: ' + e.message, true);
      return;
    }
    const iw = state.img.naturalWidth, ih = state.img.naturalHeight;
    const r = A.cropRect(iw, ih, p.cols, p.rows, 0.5, 0.5);
    $('focusX').disabled = r.w > iw - 1;
    $('focusY').disabled = r.h > ih - 1;
    state.cache = {};
    updateStats();
    showTab();
    $('zip').disabled = false;
    $('saveOne').disabled = false;
    setStatus('Готово за ' + ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',') + ' с');
  }

  function rerender() {
    if (!state.res) return;
    state.p = Object.assign(params(), { cols: state.p.cols, rows: state.p.rows });
    delete state.cache.legend;
    delete state.cache.layout;
    updateStats();
    showTab();
  }

  // ---------- предпросмотр ----------
  function previewCell(kind) {
    const res = state.res, p = state.p;
    const cells = kind === 'layout' ? A.layoutCells(res, p.pitch) : res;
    let c = kind === 'scheme' ? 20 : 10;
    const maxArea = kind === 'scheme' ? 16e6 : 6e6;
    while (c > 2 && cells.cols * cells.rows * c * c > maxArea) c--;
    return c;
  }

  function getCanvas(kind) {
    if (state.cache[kind]) return state.cache[kind];
    const res = state.res, p = state.p;
    let cv;
    if (kind === 'mosaic') cv = A.renderMosaic(res, previewCell(kind), p.shape);
    else if (kind === 'scheme') cv = A.renderScheme(res, previewCell(kind), p.shape);
    else if (kind === 'legend') cv = A.renderLegend(res, p);
    else {
      const c = previewCell(kind);
      cv = A.renderLayout(res, p, state.img, c, A.renderScheme(res, c, p.shape));
    }
    state.cache[kind] = cv;
    return cv;
  }

  function applyZoom() {
    const cv = $('holder').firstChild;
    if (!cv) return;
    const stage = $('stage');
    const fit = Math.min((stage.clientWidth - 40) / cv.width, (stage.clientHeight - 40) / cv.height);
    const scale = Math.max(0.02, fit * state.zoom);
    cv.style.width = Math.round(cv.width * scale) + 'px';
    cv.style.height = Math.round(cv.height * scale) + 'px';
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
    applyZoom();
  }

  // ---------- выгрузка ----------
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

  function release(cv) { cv.width = cv.height = 0; }

  /* Собирает файлы в печатном разрешении. kinds: массив из mosaic|scheme|legend|layout|csv */
  async function buildFiles(kinds) {
    const res = state.res, p = state.p;
    const cell = exportCell(p, res), pxmm = cell / p.pitch;
    const out = [];
    let scheme = null;
    if (kinds.indexOf('scheme') >= 0 || kinds.indexOf('layout') >= 0) scheme = A.renderScheme(res, cell, p.shape);
    for (const kind of kinds) {
      await wait(20); // даём браузеру обновить надпись о ходе работы
      if (kind === 'csv') {
        out.push({ name: 'Расход страз.csv', data: new TextEncoder().encode(A.legendCsv(res, p)) });
      } else if (kind === 'scheme') {
        out.push({ name: FILE_NAMES.scheme, data: await canvasPng(scheme, pxmm) });
      } else if (kind === 'layout') {
        const cv = A.renderLayout(res, p, state.img, cell, scheme);
        out.push({ name: FILE_NAMES.layout, data: await canvasPng(cv, pxmm) });
        release(cv);
      } else if (kind === 'mosaic') {
        const mc = Math.min(cell, 16), cv = A.renderMosaic(res, mc, p.shape);
        out.push({ name: FILE_NAMES.mosaic, data: await canvasPng(cv, mc / p.pitch) });
        release(cv);
      } else if (kind === 'legend') {
        const cv = A.renderLegend(res, p);
        out.push({ name: FILE_NAMES.legend, data: await canvasPng(cv, 0) });
        release(cv);
      }
    }
    if (scheme) release(scheme);
    return out;
  }

  function baseName() {
    const p = state.p;
    const s = [p.article, p.title].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, ' ').trim();
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
    if (!state.res) return;
    const old = button.textContent;
    button.disabled = true;
    button.textContent = label;
    setStatus('Готовлю файлы в печатном качестве, это займёт несколько секунд…');
    await wait(40);
    try {
      await job();
      setStatus('Файл сохранён в папку загрузок');
    } catch (e) {
      setStatus('Не получилось сохранить: ' + e.message, true);
    }
    button.textContent = old;
    button.disabled = false;
  }

  function saveZip() {
    return runExport($('zip'), 'Собираю комплект…', async function () {
      const files = await buildFiles(['layout', 'scheme', 'mosaic', 'legend', 'csv']);
      download(A.zipStore(files), baseName() + '.zip', 'application/zip');
    });
  }

  function saveOne() {
    return runExport($('saveOne'), 'Готовлю файл…', async function () {
      const files = await buildFiles([state.tab]);
      download([files[0].data], baseName() + ' — ' + files[0].name, 'image/png');
    });
  }

  // ---------- загрузка картинок ----------
  function loadImage(src, name, revoke) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        state.img = img;
        state.imgName = name || '';
        // холст разворачиваем под ориентацию картинки
        const w = +$('wCm').value, h = +$('hCm').value;
        const landscape = img.naturalWidth > img.naturalHeight * 1.05;
        const portrait = img.naturalHeight > img.naturalWidth * 1.05;
        if ((landscape && w < h) || (portrait && w > h)) { $('wCm').value = h; $('hCm').value = w; }
        $('focusX').value = 50;
        $('focusY').value = 50;
        const thumb = $('dropThumb');
        thumb.style.backgroundImage = 'url("' + src + '")';
        thumb.classList.add('has');
        $('dropTitle').textContent = name || 'Картинка загружена';
        $('dropHint').textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' точек · нажмите, чтобы заменить';
        $('cropFields').hidden = false;
        state.zoom = 1;
        syncOutputs();
        recompute();
        resolve();
      };
      img.onerror = function () {
        if (revoke) URL.revokeObjectURL(src);
        setStatus('Не удалось открыть файл. Подойдут JPG, PNG, WebP.', true);
        reject(new Error('image load failed'));
      };
      img.src = src;
    });
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setStatus('Это не картинка. Подойдут JPG, PNG, WebP.', true); return; }
    setStatus('Открываю картинку…');
    loadImage(URL.createObjectURL(file), file.name, true).catch(function () {});
  }

  function loadLogo(file) {
    if (!file) { state.logo = null; schedule(false); return; }
    const img = new Image();
    img.onload = function () { state.logo = img; schedule(false); };
    img.onerror = function () { setStatus('Не удалось открыть логотип', true); };
    img.src = URL.createObjectURL(file);
  }

  // ---------- своя таблица цветов ----------
  function showPalette(name) {
    const custom = pal !== defaultPal;
    const n = pal.items.length;
    $('palName').textContent = custom ? name : 'Открытая таблица DMC';
    $('palHint').textContent = custom
      ? n + ' цветов из вашего файла'
      : n + ' цвета ниток — оттенки страз могут отличаться';
    $('palReset').hidden = !custom;
    const range = $('nColors');
    range.min = Math.min(5, n);
    range.max = Math.min(A.MAX_COLORS, n);
  }

  function storePalette(name) {
    try {
      if (pal === defaultPal) { localStorage.removeItem('almaz-palette'); return; }
      const raw = pal.items.map(function (it) { return it.code + ':' + it.hex.slice(1); }).join(' ');
      localStorage.setItem('almaz-palette', JSON.stringify({ name: name, raw: raw }));
    } catch (e) { /* не сохранилось — таблица просто действует до закрытия страницы */ }
  }

  /* Возвращает true, если таблица принята. */
  function loadPaletteText(text, name) {
    const parsed = A.parsePaletteText(text);
    if (parsed.items.length < 2) {
      setStatus('В файле не нашлось цветов. Нужна таблица: в каждой строке номер и цвет (#rrggbb или R;G;B).', true);
      return false;
    }
    pal = A.paletteFromItems(parsed.items);
    showPalette(name);
    storePalette(name);
    schedule(true);
    setStatus('Таблица загружена: ' + parsed.items.length + ' цветов' +
      (parsed.skipped ? ', пропущено строк: ' + parsed.skipped : ''));
    return true;
  }

  function loadPaletteFile(file) {
    if (!file) return;
    if (/\.(xlsx?|ods|numbers)$/i.test(file.name)) {
      setStatus('Файлы Excel напрямую не читаются. Сохраните таблицу как CSV и загрузите её.', true);
      return;
    }
    file.text().then(function (text) { loadPaletteText(text, file.name); }, function () {
      setStatus('Не удалось прочитать файл таблицы', true);
    });
  }

  function resetPalette() {
    pal = defaultPal;
    showPalette('');
    storePalette('');
    schedule(true);
    setStatus('Возвращена открытая таблица DMC');
  }

  function restorePalette() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-palette') || 'null');
      if (o && o.raw) {
        const p = A.parsePalette(o.raw);
        if (p.items.length >= 2) { pal = p; showPalette(o.name || 'Своя таблица'); return; }
      }
    } catch (e) { /* игнорируем */ }
    showPalette('');
  }

  function savePaletteSample() {
    const rows = ['Номер;Цвет'].concat(pal.items.map(function (it) { return it.code + ';' + it.hex; }));
    download(['﻿' + rows.join('\r\n') + '\r\n'], 'Таблица цветов — образец.csv', 'text/csv');
    setStatus('Образец сохранён: замените в нём цвета на цвета своих страз и загрузите обратно');
  }

  // ---------- события ----------
  function init() {
    restorePalette();
    loadSettings();
    syncOutputs();
    state.p = params();
    updateStats();

    document.querySelectorAll('[data-kind]').forEach(function (el) {
      const full = el.dataset.kind === 'full';
      el.addEventListener('input', function () { schedule(full); });
      el.addEventListener('change', function () { schedule(full); });
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
      schedule(true);
    });
    $('resetAdjust').addEventListener('click', function () {
      ['brightness', 'contrast', 'saturation'].forEach(function (id) { $(id).value = 0; });
      schedule(true);
    });

    $('file').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
    $('logoFile').addEventListener('change', function (e) { loadLogo(e.target.files[0]); });
    $('palFile').addEventListener('change', function (e) { loadPaletteFile(e.target.files[0]); e.target.value = ''; });
    $('palReset').addEventListener('click', resetPalette);
    $('palSample').addEventListener('click', savePaletteSample);
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    document.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    });

    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.tab = btn.dataset.tab;
        state.zoom = 1;
        document.querySelectorAll('[data-tab]').forEach(function (b) {
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        showTab();
      });
    });
    $('zoomIn').addEventListener('click', function () { state.zoom = Math.min(12, state.zoom * 1.5); applyZoom(); });
    $('zoomOut').addEventListener('click', function () { state.zoom = Math.max(0.3, state.zoom / 1.5); applyZoom(); });
    $('zoomFit').addEventListener('click', function () { state.zoom = 1; applyZoom(); });
    window.addEventListener('resize', applyZoom);

    $('zip').addEventListener('click', saveZip);
    $('saveOne').addEventListener('click', saveOne);
  }

  A.app = {
    state: state, buildFiles: buildFiles, params: params,
    loadUrl: function (url, name) { return loadImage(url, name, false); },
    loadPaletteText: loadPaletteText, resetPalette: resetPalette
  };
  init();
})(window.ALMAZ = window.ALMAZ || {});
