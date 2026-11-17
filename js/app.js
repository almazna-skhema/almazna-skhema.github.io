/* Интерфейс: настройки, предпросмотр, список цветов, выгрузка файлов. */
(function (A) {
  'use strict';

  const T = A.T; // перевод надписи на выбранный язык

  const ASSET_VERSION = 28; // тот же номер, что в адресах скриптов в index.html
  const VERSION = T('версия') + ' 28 · 17.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  const defaultPal = A.parsePalette(A.DMC_RAW);
  let pal = defaultPal;      // действующая таблица цветов
  let palName = '';
  let palNote = '';          // что не удалось прочитать в загруженной таблице
  let wantColors = 26;       // сколько цветов просил пользователь (таблица может вместить меньше)
  const state = {
    img: null, raw: null, imgUrl: '', imgName: '', imgBlob: null, imgId: '', thumb: null, logos: [], prevTab: 'mosaic',
    tf: { rot: 0, flipX: false, flipY: false, tone: 'color' }, // подготовка картинки: поворот, отражение, тон
    res: null, core: null, p: null, tab: 'mosaic', zoom: 1, cache: {},
    focusX: 0.5, focusY: 0.5, highlightCode: null, excluded: new Set(), replaced: new Map(), busy: false,
    paint: { cols: 0, rows: 0, cells: new Map() }, // прорисовка кистью: номер клетки → номер цвета
    undo: [], redo: [],                            // отменяемые мазки: Map «клетка → что было»
    symbols: new Map(),                            // номер цвета → значок, выбранный вручную
    print: new Map(),                              // номер цвета → цвет клетки на схеме (#rrggbb)
    brush: { on: false, code: null, size: 1, tool: 'brush', under: false }
  };
  const SAVED = ['wCm', 'hCm', 'nColors', 'cleanup', 'smooth', 'urls', 'gram', 'minCount', 'stock', 'lines', 'autoLight', 'withPdf', 'withJpg', 'withLabels', 'reserve', 'symSize', 'insertStyle', 'withDocx'];
  // что входит в проект (настройки одной картинки)
  const PROJECT_FIELDS = ['wCm', 'hCm', 'cleanup', 'smooth', 'dither', 'brightness', 'contrast', 'saturation', 'article', 'title', 'urls', 'gram', 'minCount', 'lines', 'autoLight', 'reserve', 'symSize', 'insertStyle'];
  const DEFAULTS = { wCm: 40, hCm: 50, nColors: 26, cleanup: 1, smooth: 20, dither: 0, brightness: 0, contrast: 0, saturation: 0, gram: '0,0057', minCount: 0, lines: '0', autoLight: '0', reserve: 0 };
  const FILE_NAMES = { mosaic: T('Вид мозаики.png'), scheme: T('Схема для печати.png'), legend: T('Легенда.png'), layout: T('Макет.png'), insert: T('Вкладыш в набор.png') };
  const MAX_CM = 200; // самый большой холст по одной стороне
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i;
  const MAX_IMAGE_PIXELS = 150e6;
  const JPEG_MAX_PIXELS = 170e6; // файл для типографии: 300 dpi до холста 100 × 100 см с полями
  const PICK_LIMIT = 120; // сколько цветов показывать в окне замены
  const MAX_LOGOS = 4, LOGO_SIDE = 800, UNDO_LIMIT = 60, UNDO_CELLS = 2e6, MAX_BATCH = 20;

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

  /* Значение поля настроек строкой: галочки — «1» или «0». */
  function fieldGet(id) {
    const e = $(id);
    return e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value;
  }
  function fieldSet(id, v) {
    const e = $(id);
    if (e.type === 'checkbox') e.checked = String(v) === '1'; else e.value = v;
  }

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'), use = document.createElementNS(NS, 'use');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
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

  function readReserve() { return clamp(parseInt($('reserve').value, 10) || 0, 0, 50); }

  function applySymbolSize() { A.setSymbolScale(+$('symSize').value / 100); }

  function params() {
    applySymbolSize();
    const shape = document.querySelector('input[name=shape]:checked').value;
    const pitch = shape === 'round' ? 2.8 : 2.5;
    const wCm = clamp(parseFloat($('wCm').value) || DEFAULTS.wCm, 5, MAX_CM);
    const hCm = clamp(parseFloat($('hCm').value) || DEFAULTS.hCm, 5, MAX_CM);
    return {
      shape: shape, pitch: pitch, wCm: wCm, hCm: hCm,
      cols: Math.max(4, Math.round((wCm * 10) / pitch)),
      rows: Math.max(4, Math.round((hCm * 10) / pitch)),
      nColors: +$('nColors').value,
      cleanup: +$('cleanup').value,
      lines: $('lines').checked,
      minCount: clamp(parseInt($('minCount').value, 10) || 0, 0, 9999),
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
      gramPerStone: readGram() * (1 + readReserve() / 100), // вес считаем сразу с запасом
      gramBase: readGram(),
      reserve: readReserve(),
      insertStyle: $('insertStyle').value === 'table' ? 'table' : 'list',
      logos: state.logos.map(function (l) { return l.img; })
    };
  }

  /* Приводит поля к допустимым значениям, чтобы на экране было то, что реально считается. */
  function normalizeInputs() {
    ['wCm', 'hCm'].forEach(function (id) {
      const v = clamp(parseFloat($(id).value) || DEFAULTS[id], 5, MAX_CM);
      if (String(v) !== $(id).value) $(id).value = v;
    });
    $('gram').value = String(readGram()).replace('.', ',');
    $('minCount').value = String(clamp(parseInt($('minCount').value, 10) || 0, 0, 9999));
    $('reserve').value = String(readReserve());
  }

  function saveSettings() {
    try {
      const o = {};
      SAVED.forEach(function (id) { o[id] = fieldGet(id); });
      o.nColors = String(wantColors); // запоминаем желаемое число, а не урезанное маленькой таблицей
      o.shape = document.querySelector('input[name=shape]:checked').value;
      localStorage.setItem('almaz-settings', JSON.stringify(o));
    } catch (e) { /* хранилище недоступно — работаем без него */ }
  }

  function loadSettings() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-settings') || 'null');
      if (!o || typeof o !== 'object') return;
      SAVED.forEach(function (id) { if (typeof o[id] === 'string') fieldSet(id, o[id]); });
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
    let text = p.cols + ' × ' + p.rows + T(' страз · ') + fmt(p.cols * p.rows) + T(' шт');
    if (state.res) text += T(' · печать ') + dpiOf(exportCell(p, state.res), p) + ' dpi';
    $('stats').textContent = text;
  }

  // ---------- расчёт ----------
  let timer = null, pendingFull = false;

  /* typing — правка в поле ввода: ждём, пока допечатают, а не пересчитываем на каждую цифру */
  function schedule(full, typing) {
    syncOutputs();
    saveSettings();
    if (!state.img) { state.p = params(); updateStats(); return; }
    touch();
    pendingFull = pendingFull || full; // пересчёт не должен теряться, если следом поменяли текстовое поле
    clearTimeout(timer);
    if (pendingFull) setStatus(T('Считаю…'));
    timer = setTimeout(flush, typing ? 600 : pendingFull ? 140 : 250);
  }

  function flush() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const full = pendingFull;
    pendingFull = false;
    if (full) recompute(); else rerender();
  }

  /* Цвета, которых нет в наличии: список из поля, действует на все схемы. */
  function stockInfo() {
    const by = new Map();
    pal.items.forEach(function (it) { by.set(it.code.toLowerCase(), it.code); });
    const found = new Set(), unknown = [];
    $('stock').value.split(/[,;\n]+/).forEach(function (chunk) {
      chunk = chunk.trim();
      if (!chunk) return;
      const whole = by.get(chunk.toLowerCase());
      if (whole) { found.add(whole); return; }
      chunk.split(/\s+/).forEach(function (t) { // «310 3865» без запятой
        const c = by.get(t.toLowerCase());
        if (c) found.add(c); else if (unknown.indexOf(t) < 0) unknown.push(t);
      });
    });
    return { found: found, unknown: unknown };
  }

  function showStockNote() {
    const info = stockInfo(), n = info.found.size;
    $('stockNote').textContent = (n ? T('Не предлагаю цветов: ') + n + '. ' : T('Эти цвета сервис не будет предлагать ни в одной схеме. ')) +
      (info.unknown.length ? T('Нет в таблице: ') + info.unknown.slice(0, 8).join(', ') + (info.unknown.length > 8 ? '…' : '') + '.' : '');
  }

  function activePalette() {
    const stock = stockInfo().found;
    if (!state.excluded.size && !stock.size) return pal;
    const all = new Set(state.excluded);
    stock.forEach(function (c) { all.add(c); });
    return A.paletteWithout(pal, all);
  }

  let codeIndex = null, codeIndexFor = null;
  function palByCode() {
    if (codeIndexFor !== pal) {
      codeIndex = new Map();
      pal.items.forEach(function (it, i) { codeIndex.set(it.code, i); });
      codeIndexFor = pal;
    }
    return codeIndex;
  }

  /* Ручные замены для расчёта: номер, выбранный программой → цвет из таблицы. */
  function replaceMap() {
    if (!state.replaced.size) return null;
    const by = palByCode(), m = new Map();
    state.replaced.forEach(function (to, from) {
      const i = by.get(to);
      if (i !== undefined) m.set(from, pal.items[i]);
    });
    return m;
  }

  /* Все ручные правки поверх автоматического подбора — в том виде, как их ждёт A.compose. */
  function overlays() {
    const core = state.core, pt = state.paint, by = palByCode();
    const print = new Map();
    state.print.forEach(function (hex, code) {
      const v = parseInt(hex.slice(1), 16);
      print.set(code, { r: v >> 16, g: (v >> 8) & 255, b: v & 255, hex: hex });
    });
    return {
      replace: replaceMap(),
      paint: paintFits() ? pt.cells : null,
      itemOf: function (code) { const i = by.get(code); return i === undefined ? undefined : pal.items[i]; },
      symbols: state.symbols,
      print: print,
      autoLight: $('autoLight').checked
    };
  }

  /* Прорисовка привязана к клеткам, поэтому действует только на холсте того же размера. */
  function paintFits() {
    const core = state.core, pt = state.paint;
    return !!core && pt.cells.size > 0 && pt.cols === core.cols && pt.rows === core.rows;
  }

  function colorByCode(code) {
    const cs = state.res ? state.res.colors : [];
    for (let i = 0; i < cs.length; i++) if (cs[i].code === code) return cs[i];
    return null;
  }

  /* Убирает холсты предпросмотра из памяти (на планшетах она быстро кончается). */
  /* Холст, который ещё на экране или нужен идущей выгрузке, освобождаем позже: иначе на миг
   * пустеет просмотр, а выгрузка падает на пустом холсте, если во время неё тронули настройки. */
  let retired = [], exporting = 0;
  function dropCache(kinds) {
    (kinds || Object.keys(state.cache)).forEach(function (k) {
      const cv = state.cache[k];
      if (cv && (cv.isConnected || exporting)) retired.push(cv); else release(cv);
      delete state.cache[k];
    });
  }

  function releaseRetired() {
    if (exporting) return;
    retired = retired.filter(function (cv) {
      if (cv.isConnected) return true;
      for (const k in state.cache) if (state.cache[k] === cv) return false; // снова в работе
      release(cv);
      return false;
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
      state.core = A.quantizeCore(grid, activePalette(), p);
      res = A.compose(state.core, overlays());
    } catch (e) {
      // старую схему не оставляем: иначе скачается результат от прежней картинки или настроек
      console.error(e);
      state.res = null;
      state.core = null;
      updateBrushBar();
      dropCache();
      $('holder').textContent = '';
      releaseRetired();
      $('holder').hidden = true;
      $('empty').hidden = false;
      $('zip').disabled = $('saveOne').disabled = true;
      setStatus(T('Не удалось обработать картинку. Попробуйте сохранить её как JPG или PNG и загрузить снова.'), 'error');
      return;
    }
    state.p = p;
    state.res = res;
    lastCell = null;
    drawCrop();
    dropCache(['original']);
    afterResult();
    const got = res.picked, asked = Math.min(p.nColors, activePalette().items.length);
    const pt = state.paint;
    setStatus(T('Готово за ') + ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',') + T(' с') +
      (got < asked ? T(' · цветов вышло ') + got + T(' из ') + asked + T(': остальные на этой картинке не понадобились') : '') +
      (pt.cells.size && !paintFits() ? T(' · прорисовка кистью сделана для холста ') + pt.cols + ' × ' + pt.rows + T(' страз и на этом размере не показана') : ''));
  }

  function afterResult() {
    if (highlightIndex() < 0) state.highlightCode = null;
    dropCache(['mosaic', 'scheme', 'legend', 'layout', 'insert']); // исходник от правок не меняется
    updateStats();
    renderColorList();
    updateBrushBar();
    showTab();
    if (!state.busy) $('zip').disabled = false;
    $('projSave').disabled = false;
    touch();
  }

  /* Ручные правки изменились — пересобираем схему без повторной обработки картинки. */
  function applyOverlays() {
    if (timer !== null && pendingFull) { flush(); return; } // полный пересчёт и так на подходе
    if (!state.core) return;
    state.res = A.compose(state.core, overlays());
    afterResult();
  }

  function rerender() {
    if (!state.res) return;
    const gramBefore = state.p.gramPerStone;
    state.p = params();
    dropCache(['legend', 'layout', 'insert']);
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
    } else if (kind === 'mosaic') cv = A.renderMosaic(res, previewCell(kind), p.shape, hi, underlay());
    else if (kind === 'scheme') cv = A.renderScheme(res, previewCell(kind), p.shape, hi, underlay());
    else if (kind === 'legend') cv = A.renderLegend(res, p);
    else if (kind === 'insert') cv = A.renderInsert(res, p, state.img, 0.5);
    else {
      const c = previewCell(kind);
      const tmp = A.renderScheme(res, c, p.shape, -1, underlay());
      cv = A.renderLayout(res, p, state.img, c, tmp);
      release(tmp);
    }
    state.cache[kind] = cv;
    return cv;
  }

  /* Картинка для зон «без страз» — та же, что на вкладке «Оригинал». */
  function underlay() {
    return state.res && state.res.empty ? getCanvas('original') : null;
  }

  function fitScale(cv) {
    const stage = $('stage');
    return Math.max(0.02, Math.min((stage.clientWidth - 40) / cv.width, (stage.clientHeight - 40) / cv.height));
  }

  function applyZoom() {
    const cv = $('holder').firstChild;
    if (!cv) return;
    const scale = fitScale(cv) * state.zoom;
    const w = Math.max(1, Math.round(cv.width * scale)) + 'px', h = Math.max(1, Math.round(cv.height * scale)) + 'px';
    Array.prototype.forEach.call($('holder').children, function (node) { // исходник поверх схемы — того же размера
      node.style.width = w;
      node.style.height = h;
    });
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
    // в режиме кисти поверх схемы можно положить полупрозрачный исходник — обводить по нему контур
    const ghost = paintActive() && state.brush.under ? getCanvas('original') : null;
    const stage = $('stage'), sl = stage.scrollLeft, st = stage.scrollTop, old = holder.firstChild;
    if (old !== cv || holder.children.length !== (ghost ? 2 : 1) || (ghost && holder.lastChild !== ghost)) {
      // новая картинка того же вида встаёт на место старой сразу в её размере — иначе область
      // просмотра на миг пустеет, прокрутка сбрасывается и увеличенная схема «уезжает» после каждого мазка
      const same = old && old.width === cv.width && old.height === cv.height;
      cv.className = '';
      if (same) { cv.style.width = old.style.width; cv.style.height = old.style.height; }
      if (ghost) ghost.className = 'ghost';
      if (holder.replaceChildren) holder.replaceChildren.apply(holder, ghost ? [cv, ghost] : [cv]);
      else { holder.textContent = ''; holder.appendChild(cv); if (ghost) holder.appendChild(ghost); }
      if (same) { stage.scrollLeft = sl; stage.scrollTop = st; }
    }
    $('saveOne').disabled = state.tab === 'original' || state.busy;
    applyZoom();
    if (old && old !== cv && old.width === cv.width && old.height === cv.height) { stage.scrollLeft = sl; stage.scrollTop = st; }
    releaseRetired();
  }

  function selectTab(tab) {
    if (tab === 'original' && state.tab !== 'original') state.prevTab = state.tab;
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    updateBrushBar();
    showTab();
  }

  /* Клавиша V: исходник ↔ схема, чтобы быстро сравнить (масштаб и место сохраняются). */
  function toggleOriginal() {
    if (!state.res) return;
    selectTab(state.tab === 'original' ? (state.prevTab || 'mosaic') : 'original');
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
    applyUi();
    const list = $('colorList');
    list.textContent = '';
    const hi = highlightIndex(), hiLook = hi >= 0 ? A.highlightColor(res.colors) : null;
    const canExclude = res.colors.length > 2 && pal.items.length - state.excluded.size > 2;
    const brushOn = state.brush.on;
    let total = 0, totalG = 0;
    res.colors.forEach(function (c, i) {
      const g = A.grams(c.count, p.gramPerStone);
      total += c.count;
      totalG += g;
      const li = el('li');
      // образец: так клетка напечатана на схеме; нажатие меняет значок и цвет клетки
      const look = c.print || c;
      const sw = el('button', 'swatch swatch-btn' + (c.print || state.symbols.has(c.code) ? ' custom' : ''), c.symbol);
      sw.type = 'button';
      sw.style.backgroundColor = look.hex;
      sw.style.color = look.dark ? '#ffffff' : '#000000';
      sw.title = T('Значок и цвет клетки для ') + c.code + T(' на схеме');
      sw.setAttribute('aria-label', sw.title);
      sw.addEventListener('click', function () { openSymbols(c.code); });
      const row = el('button', 'color-row');
      row.type = 'button';
      row.setAttribute('aria-pressed', (brushOn ? c.code === state.brush.code : i === hi) ? 'true' : 'false');
      row.title = brushOn ? T('Взять цвет ') + c.code + T(' на кисть') : T('Подсветить цвет ') + c.code + T(' на схеме');
      if (i === hi) { row.classList.add('lit'); row.style.boxShadow = 'inset 5px 0 0 ' + hiLook.hex; } // подсвеченный цвет видно и в режиме кисти
      row.appendChild(el('span', 'code', c.code));
      row.appendChild(el('span', '', fmt(c.count)));
      row.appendChild(el('span', 'muted', g + T(' г')));
      row.addEventListener('click', function () { if (state.brush.on) setBrushCode(c.code); else toggleHighlight(c.code); });
      const ed = el('button', 'color-x color-edit' + (c.from.length ? ' changed' : ''));
      ed.appendChild(icon('pencil'));
      ed.type = 'button';
      ed.title = T('Заменить цвет ') + c.code + T(' на другой номер') + (c.from.length ? T(' (сейчас стоит вместо ') + c.from.join(', ') + ')' : '');
      ed.setAttribute('aria-label', ed.title);
      ed.addEventListener('click', function () { openPicker(c.code); });
      const x = el('button', 'color-x');
      x.appendChild(icon('x'));
      x.type = 'button';
      x.title = T('Убрать цвет ') + c.code + T(' из схемы');
      x.setAttribute('aria-label', x.title);
      x.disabled = !canExclude;
      x.addEventListener('click', function () { excludeColor(c.code); });
      li.appendChild(sw);
      li.appendChild(row);
      li.appendChild(ed);
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
      box.appendChild(el('span', '', T('Убраны:')));
      state.excluded.forEach(function (code) {
        const chip = el('button', 'chip', code + ' ↩');
        chip.type = 'button';
        chip.title = T('Вернуть цвет ') + code;
        chip.addEventListener('click', function () { state.excluded.delete(code); schedule(true); });
        box.appendChild(chip);
      });
    }

    const rbox = $('replacedBox');
    rbox.textContent = '';
    rbox.hidden = state.replaced.size === 0;
    if (state.replaced.size) {
      rbox.appendChild(el('span', '', T('Заменены:')));
      state.replaced.forEach(function (to, from) {
        const chip = el('button', 'chip', from + ' → ' + to + ' ↩');
        chip.type = 'button';
        chip.title = T('Отменить замену: вернуть цвет ') + from;
        chip.addEventListener('click', function () { undoReplace(from); });
        rbox.appendChild(chip);
      });
    }
  }

  function toggleHighlight(code) {
    if (!state.res || code === null || code === A.EMPTY) return;
    state.highlightCode = state.highlightCode === code ? null : code;
    dropCache(['mosaic', 'scheme']);
    renderColorList();
    const hi = highlightIndex();
    if (hi >= 0) {
      const c = state.res.colors[hi], look = A.highlightColor(state.res.colors);
      setStatus(T('Цвет ') + c.code + T(' подсвечен ') + T(look.name) + ': ' + fmt(c.count) + T(' страз. Нажмите ещё раз или клавишу Q, чтобы снять подсветку.'));
    } else setStatus(T('Подсветка снята.'));
    if (!paintTab()) selectTab('mosaic'); else { updateBrushBar(); showTab(); }
  }

  function excludeColor(code) {
    if (pal.items.length - state.excluded.size <= 2) return; // в таблице должно остаться хотя бы два цвета
    // если цвет стоит вместо других — убираем и их: от них уже отказались, когда заменяли
    const c = colorByCode(code);
    (c ? c.from : []).forEach(function (from) {
      state.replaced.delete(from);
      if (pal.items.length - state.excluded.size > 3) state.excluded.add(from);
    });
    state.excluded.add(code);
    // стразы этого цвета, поставленные кистью, тоже уходят
    state.paint.cells.forEach(function (v, i) { if (v === code) state.paint.cells.delete(i); });
    state.undo = []; state.redo = [];
    if (state.highlightCode === code) state.highlightCode = null;
    schedule(true);
  }

  // ---------- ручная замена цвета ----------
  /* Все стразы, которые сейчас идут под номером code, получают номер to. */
  function replaceColor(code, to) {
    const c = colorByCode(code);
    if (!c || code === to || !palByCode().has(to)) return;
    const sources = c.from.slice();
    if (c.own) sources.push(code);
    sources.forEach(function (from) {
      if (from === to) state.replaced.delete(from); else state.replaced.set(from, to);
    });
    // стразы, поставленные кистью этим цветом, тоже меняют номер
    state.paint.cells.forEach(function (v, i) { if (v === code) state.paint.cells.set(i, to); });
    if (c.painted) state.undo = []; state.redo = [];
    if (state.highlightCode === code) state.highlightCode = to;
    if (state.brush.code === code) state.brush.code = to;
    applyOverlays();
  }

  function undoReplace(from) {
    state.replaced.delete(from);
    applyOverlays();
  }

  let pickFor = null, pickMode = 'replace'; // replace — замена цвета в схеме, brush — выбор цвета кисти

  function closePicker() {
    const d = $('pickDialog');
    if (d.close) d.close(); else d.removeAttribute('open');
    pickFor = null;
  }

  function fillPicker() {
    const list = $('pickList');
    list.textContent = '';
    if (pickFor === null || !state.res) return;
    const q = $('pickSearch').value.trim().toLowerCase();
    const brush = pickMode === 'brush';
    const base = palByCode().get(pickFor), L = pal.lab;
    const inScheme = new Set(state.res.colors.map(function (c) { return c.code; }));
    const found = [];
    pal.items.forEach(function (it, i) {
      if (!brush && it.code === pickFor) return;
      const low = it.code.toLowerCase();
      if (q && low.indexOf(q) < 0) return;
      let d = 0;
      if (base !== undefined) {
        const dl = L[i * 3] - L[base * 3], da = L[i * 3 + 1] - L[base * 3 + 1], db = L[i * 3 + 2] - L[base * 3 + 2];
        d = dl * dl + da * da + db * db;
      }
      found.push({ it: it, d: d, head: q && low.indexOf(q) === 0 ? 0 : 1 });
    });
    // без поиска — самые похожие сверху (для кисти сначала цвета схемы);
    // при поиске — сначала номера, начинающиеся с набранного
    found.sort(function (a, b) {
      if (q) return a.head - b.head || a.d - b.d;
      if (brush) return (inScheme.has(a.it.code) ? 0 : 1) - (inScheme.has(b.it.code) ? 0 : 1) || a.d - b.d;
      return a.d - b.d;
    });
    found.slice(0, PICK_LIMIT).forEach(function (o) {
      const it = o.it, same = inScheme.has(it.code);
      const b = el('button', 'pick-item' + (same ? ' in-scheme' : ''));
      b.type = 'button';
      b.title = brush ? T('Взять на кисть ') + it.code + (same ? '' : T(' — цвет добавится в схему, когда вы им нарисуете'))
        : T('Заменить на ') + it.code + (same ? T(' — этот номер уже есть в схеме, цвета сольются') : '');
      const sw = el('span', 'swatch');
      sw.style.backgroundColor = it.hex;
      b.appendChild(sw);
      b.appendChild(el('span', '', it.code));
      b.addEventListener('click', function () {
        const from = pickFor, mode = pickMode;
        closePicker();
        if (mode === 'brush') setBrushCode(it.code); else replaceColor(from, it.code);
      });
      list.appendChild(b);
    });
    $('pickNote').textContent = !found.length ? T('Такого номера в таблице нет.')
      : found.length > PICK_LIMIT ? T('Показаны ') + PICK_LIMIT + T(' из ') + found.length + T('. Чтобы найти остальные, введите номер.')
      : '';
  }

  function showPicker() {
    $('pickSearch').value = '';
    fillPicker();
    const d = $('pickDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('pickList').scrollTop = 0;
    // на сенсорных экранах поле не трогаем, чтобы клавиатура не закрывала список
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) $('pickSearch').focus();
  }

  function openPicker(code) {
    const c = colorByCode(code);
    if (!c) return;
    pickFor = code;
    pickMode = 'replace';
    $('pickTitle').textContent = T('Заменить цвет ') + code;
    $('pickSub').textContent = fmt(c.count) + T(' страз получат новый номер');
    $('pickHint').textContent = T('Сверху — самые похожие оттенки. Обведённые номера уже есть в схеме: при выборе цвета сольются в один.');
    const sw = $('pickSwatch');
    sw.textContent = c.symbol;
    sw.style.backgroundColor = c.hex;
    sw.style.color = c.dark ? '#ffffff' : '#000000';
    showPicker();
  }

  function openBrushPicker() {
    if (state.brush.code === A.EMPTY) state.brush.code = defaultBrushCode(); // из режима «без страз» — к обычному цвету
    const it = brushItem();
    if (!it || !state.res) return;
    pickFor = it.code;
    pickMode = 'brush';
    $('pickTitle').textContent = T('Цвет кисти');
    $('pickSub').textContent = T('Сейчас ') + it.code + T('. Можно взять любой номер из таблицы');
    $('pickHint').textContent = T('Обведённые номера уже есть в схеме, они стоят первыми. Остальные добавятся в схему, когда вы ими нарисуете.');
    const sw = $('pickSwatch');
    sw.textContent = '';
    sw.style.backgroundColor = it.hex;
    showPicker();
  }

  // ---------- кисть: прорисовка отдельных страз ----------
  let stroke = null, lastCell = null;

  function paintTab() { return state.tab === 'mosaic' || state.tab === 'scheme'; }
  function paintActive() { return state.brush.on && paintTab() && !!state.res && !!state.core; }

  function brushItem() {
    const i = palByCode().get(state.brush.code);
    return i === undefined ? null : pal.items[i];
  }

  /* Кисть по умолчанию — чёрная (310): ею обычно обводят контур. Нет такой — самый тёмный цвет схемы. */
  function defaultBrushCode() {
    if (palByCode().has('310')) return '310';
    let best = null;
    (state.res ? state.res.colors : []).forEach(function (c) {
      if (!best || c.r + c.g + c.b < best.r + best.g + best.b) best = c;
    });
    return best ? best.code : pal.items[0].code;
  }

  function setBrushCode(code) {
    state.brush.code = code;
    if (state.brush.tool === 'erase' || state.brush.tool === 'pipette') state.brush.tool = 'brush';
    updateBrushBar();
    $('colorList').querySelectorAll('.color-row').forEach(function (row, i) {
      row.setAttribute('aria-pressed', state.res.colors[i] && state.res.colors[i].code === code ? 'true' : 'false');
    });
  }

  function updateBrushBar() {
    const b = state.brush, toggle = $('brushToggle');
    toggle.disabled = !state.res;
    toggle.setAttribute('aria-pressed', b.on ? 'true' : 'false');
    $('stepBrush').textContent = b.on ? T('✎ Выключить кисть') : T('✎ Включить кисть');
    const on = paintActive();
    $('brushBar').hidden = !on;
    $('stage').classList.toggle('brush', on);
    document.body.classList.toggle('painting', on); // на телефоне в режиме кисти панель сворачивается до кнопок
    if (!on) return;
    const none = b.code === A.EMPTY;
    if (!none && (b.code === null || !palByCode().has(b.code))) b.code = defaultBrushCode();
    const it = brushItem();
    $('brushSwatch').style.backgroundColor = none ? '#ffffff' : it.hex;
    $('brushCode').textContent = none ? T('без страз') : it.code;
    $('brushEmpty').setAttribute('aria-pressed', none ? 'true' : 'false');
    $('brushUndo').disabled = !state.undo.length;
    $('brushRedo').disabled = !state.redo.length;
    $('brushUnder').checked = b.under;
    const lit = !none && state.highlightCode === it.code && highlightIndex() >= 0;
    $('brushHi').setAttribute('aria-pressed', lit ? 'true' : 'false');
    $('brushHi').disabled = none;
    $('brushClear').hidden = !paintFits();
    $('brushSize').value = String(b.size);
    document.querySelectorAll('input[name=tool]').forEach(function (r) { r.checked = r.value === b.tool; });
  }

  function toggleBrush() {
    if (!state.res) return;
    state.brush.on = !state.brush.on;
    renderColorList(); // подсказки и отметка в списке зависят от режима
    if (state.brush.on && ui.step !== 4) { setStep(4); return; } // кисть — часть этапа «Правка»
    if (state.brush.on && !paintTab()) selectTab('mosaic'); else { updateBrushBar(); showTab(); }
  }

  function cellAt(e, clampToGrid) {
    const cv = $('holder').firstChild, res = state.res;
    if (!cv || !res) return null;
    const r = cv.getBoundingClientRect();
    let x = Math.floor(((e.clientX - r.left) / r.width) * res.cols);
    let y = Math.floor(((e.clientY - r.top) / r.height) * res.rows);
    if (clampToGrid) { x = clamp(x, 0, res.cols - 1); y = clamp(y, 0, res.rows - 1); }
    return x < 0 || y < 0 || x >= res.cols || y >= res.rows ? null : { x: x, y: y };
  }

  /* Прорисовка хранится для холста одного размера; на новом размере начинаем заново. */
  function ensurePaintGrid() {
    const pt = state.paint, res = state.res;
    if (pt.cols === res.cols && pt.rows === res.rows) return;
    pt.cols = res.cols;
    pt.rows = res.rows;
    pt.cells = new Map();
    state.undo = []; state.redo = [];
  }

  function beginStroke() {
    const cv = $('holder').firstChild, it = brushItem();
    // подсвеченный цвет и во время мазка рисуем контрастной краской, как он выглядит на схеме
    const lit = state.highlightCode !== null && highlightIndex() >= 0 ? A.highlightColor(state.res.colors).hex : null;
    stroke = {
      changes: new Map(), ctx: cv.getContext('2d'), cell: cv.width / state.res.cols,
      hex: it ? (lit && it.code === state.highlightCode ? lit : it.hex) : '#ffffff', lit: lit, replace: replaceMap(), drag: false
    };
  }

  function setCell(i, code) {
    const cells = state.paint.cells, prev = cells.get(i), cols = state.res.cols;
    if (prev === code) return;
    if (!stroke.changes.has(i)) stroke.changes.set(i, prev);
    let hex = stroke.hex;
    if (code === undefined) {
      cells.delete(i);
      const core = state.core, own = core.pal.items[core.sel[core.idx[i]]];
      const back = (stroke.replace && stroke.replace.get(own.code)) || own;
      hex = stroke.lit && back.code === state.highlightCode ? stroke.lit : back.hex;
    } else cells.set(i, code);
    // сразу показываем мазок плоским цветом; точный вид появится, когда кнопку отпустят
    const s = stroke.cell;
    stroke.ctx.fillStyle = hex;
    stroke.ctx.fillRect((i % cols) * s, ((i / cols) | 0) * s, s, s);
  }

  function dab(cx, cy) {
    const res = state.res, b = state.brush, size = b.size;
    const code = b.tool === 'erase' ? undefined : b.code;
    const x0 = cx - ((size - 1) >> 1), y0 = cy - ((size - 1) >> 1);
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        if (x >= 0 && y >= 0 && x < res.cols && y < res.rows) setCell(y * res.cols + x, code);
      }
    }
  }

  function strokeLine(a, b) {
    let x = a.x, y = a.y;
    const dx = Math.abs(b.x - x), dy = Math.abs(b.y - y), sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      dab(x, y);
      if (x === b.x && y === b.y) break;
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /* Заливка: все соседние стразы того же цвета, что и под курсором. */
  function flood(cx, cy) {
    const res = state.res, cols = res.cols, rows = res.rows, cells = res.cells;
    const start = cy * cols + cx, target = cells[start];
    if (target === A.EMPTY_CELL ? state.brush.code === A.EMPTY : res.colors[target].code === state.brush.code) return;
    const seen = new Uint8Array(cells.length), stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % cols, y = (i / cols) | 0;
      setCell(i, state.brush.code);
      if (x > 0 && !seen[i - 1] && cells[i - 1] === target) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < cols - 1 && !seen[i + 1] && cells[i + 1] === target) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - cols] && cells[i - cols] === target) { seen[i - cols] = 1; stack.push(i - cols); }
      if (y < rows - 1 && !seen[i + cols] && cells[i + cols] === target) { seen[i + cols] = 1; stack.push(i + cols); }
    }
  }

  function endStroke() {
    const st = stroke;
    stroke = null;
    if (!st) return;
    if (st.changes.size) {
      state.redo = [];
      pushUndo(st.changes);
      applyOverlays();
    } else updateBrushBar();
  }

  /* Шаги «Отменить» храним в пределах разумной памяти: заливка большого холста — это сотни тысяч клеток. */
  function pushUndo(ch) {
    state.undo.push(ch);
    let total = 0;
    state.undo.forEach(function (m) { total += m.size; });
    while (state.undo.length > 1 && (state.undo.length > UNDO_LIMIT || total > UNDO_CELLS)) total -= state.undo.shift().size;
  }

  /* Возвращает клеткам прежние значения и отдаёт обратную правку — для «Вернуть». */
  function applyChanges(ch) {
    const cells = state.paint.cells, back = new Map();
    ch.forEach(function (prev, i) {
      back.set(i, cells.get(i));
      if (prev === undefined) cells.delete(i); else cells.set(i, prev);
    });
    return back;
  }

  function undoStroke() {
    const ch = state.undo.pop();
    if (!ch) return;
    state.redo.push(applyChanges(ch));
    applyOverlays();
  }

  function redoStroke() {
    const ch = state.redo.pop();
    if (!ch) return;
    state.undo.push(applyChanges(ch));
    applyOverlays();
  }

  function clearPaint() {
    if (!paintFits()) return;
    const cells = state.paint.cells;
    state.redo = [];
    pushUndo(new Map(cells)); // стирание тоже можно отменить
    cells.clear();
    applyOverlays();
    setStatus(T('Прорисовка стёрта. Кнопка «Отменить» вернёт её.'));
  }

  function paintDown(e) {
    if (!paintActive() || e.button !== 0 || e.target !== $('holder').firstChild) return false; // правая и средняя кнопки двигают схему
    if (e.pointerType === 'touch' && !e.isPrimary) return true; // второй палец — это жест масштаба, а не мазок
    const c = cellAt(e), res = state.res, b = state.brush;
    if (!c) return false;
    e.preventDefault();
    if (e.altKey || b.tool === 'pipette') { // взять цвет со схемы
      const picked = res.cells[c.y * res.cols + c.x];
      setBrushCode(picked === A.EMPTY_CELL ? A.EMPTY : res.colors[picked].code);
      return true;
    }
    if (b.tool !== 'erase' && b.code !== A.EMPTY && !colorByCode(b.code) && res.colors.length >= A.ALL_SYMBOLS.length) {
      setStatus(T('В схеме уже ') + res.colors.length + T(' цветов — для нового не осталось значка. Возьмите на кисть цвет из списка.'), 'error');
      return true;
    }
    ensurePaintGrid();
    beginStroke();
    if (b.tool === 'fill') { flood(c.x, c.y); endStroke(); lastCell = c; return true; }
    if (e.shiftKey && lastCell) strokeLine(lastCell, c); else dab(c.x, c.y);
    lastCell = c;
    stroke.drag = true;
    try { $('stage').setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    return true;
  }

  function paintMove(e) {
    if (!stroke || !stroke.drag) return;
    const c = cellAt(e, true);
    if (!c || (c.x === lastCell.x && c.y === lastCell.y)) return;
    strokeLine(lastCell, c);
    lastCell = c;
  }

  // ---------- значок и цвет клетки на схеме ----------
  let symFor = null;

  function storeMarks() {
    try {
      localStorage.setItem('almaz-marks', JSON.stringify({ symbols: Array.from(state.symbols), print: Array.from(state.print) }));
    } catch (e) { /* не сохранилось — действует до закрытия страницы */ }
  }

  function readMarks(o) {
    if (!o || typeof o !== 'object') return;
    (Array.isArray(o.symbols) ? o.symbols : []).slice(0, 200).forEach(function (pair) {
      if (Array.isArray(pair) && okCode(pair[0]) && A.LIBRARY.indexOf(pair[1]) >= 0) state.symbols.set(pair[0], pair[1]);
    });
    (Array.isArray(o.print) ? o.print : []).slice(0, 200).forEach(function (pair) {
      if (Array.isArray(pair) && okCode(pair[0]) && /^#[0-9a-f]{6}$/i.test(pair[1])) state.print.set(pair[0], pair[1].toLowerCase());
    });
  }

  function restoreMarks() {
    try { readMarks(JSON.parse(localStorage.getItem('almaz-marks') || 'null')); } catch (e) { /* игнорируем */ }
  }

  function setSymbol(code, sym) {
    if (sym === null) state.symbols.delete(code);
    else {
      // значок один на цвет: у прежнего владельца он снимается, тот получит свободный
      state.symbols.forEach(function (s, k) { if (s === sym && k !== code) state.symbols.delete(k); });
      state.symbols.set(code, sym);
    }
    storeMarks();
    applyOverlays();
    fillSymbols();
  }

  function setPrint(code, hex) {
    const c = colorByCode(code);
    if (!hex || (c && hex.toLowerCase() === lighten(c, 0))) state.print.delete(code);
    else state.print.set(code, hex.toLowerCase());
    storeMarks();
    applyOverlays();
    fillSymbols();
  }

  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
  function lighten(c, t) {
    return '#' + hex2(Math.round(c.r + (255 - c.r) * t)) + hex2(Math.round(c.g + (255 - c.g) * t)) + hex2(Math.round(c.b + (255 - c.b) * t));
  }
  function hexDark(hex) {
    const v = parseInt(hex.slice(1), 16);
    return 0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) < 140;
  }

  function closeSymbols() {
    const d = $('symDialog');
    if (d.close) d.close(); else d.removeAttribute('open');
    symFor = null;
  }

  function fillSymbols() {
    const c = symFor === null ? null : colorByCode(symFor);
    if (!c) { if (symFor !== null) closeSymbols(); return; }
    const look = c.print || c;
    $('symTitle').textContent = T('Цвет ') + c.code + T(' на схеме');
    const head = $('symSwatch');
    head.textContent = c.symbol;
    head.style.backgroundColor = look.hex;
    head.style.color = look.dark ? '#ffffff' : '#000000';

    const list = $('symList');
    list.textContent = '';
    const owner = new Map();
    state.res.colors.forEach(function (o) { if (o.code !== c.code) owner.set(o.symbol, o.code); });
    A.SHAPES.concat(A.MORE_SHAPES, A.SYMBOLS, A.MORE_LETTERS, A.MORE_GLYPHS).forEach(function (sym) {
      const taken = owner.get(sym);
      const b = el('button', 'sym-item' + (sym === c.symbol ? ' current' : '') + (taken ? ' used' : ''), sym);
      b.type = 'button';
      b.title = sym === c.symbol ? T('Этот значок стоит сейчас')
        : taken ? T('Сейчас у цвета ') + taken + T(' — он получит другой значок') : T('Поставить этот значок');
      b.addEventListener('click', function () { setSymbol(c.code, sym); });
      list.appendChild(b);
    });
    $('symReset').hidden = !state.symbols.has(c.code);

    const plist = $('printList');
    plist.textContent = '';
    const current = state.print.get(c.code) || null;
    [[T('Как у стразы'), null], [T('Светлее'), lighten(c, 0.45)], [T('Ещё светлее'), lighten(c, 0.72)],
      [T('Светло-серый'), '#d9d9d9'], [T('Серый'), '#a6a6a6'], [T('Белый'), '#ffffff']].forEach(function (o) {
      const hex = o[1], shown = hex || c.hex;
      const b = el('button', 'print-item' + (hex === current ? ' current' : ''));
      b.type = 'button';
      const sw = el('span', 'swatch', c.symbol);
      sw.style.backgroundColor = shown;
      sw.style.color = hexDark(hex ? hex : lighten(c, 0)) ? '#ffffff' : '#000000';
      b.appendChild(sw);
      b.appendChild(el('span', '', o[0]));
      b.addEventListener('click', function () { setPrint(c.code, hex); });
      plist.appendChild(b);
    });
    $('printCustom').value = current || lighten(c, 0);
  }

  function openSymbols(code) {
    if (!colorByCode(code)) return;
    symFor = code;
    fillSymbols();
    const d = $('symDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  // ---------- выгрузка ----------
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

  function joinBytes(parts) {
    let n = 0;
    parts.forEach(function (b) { n += b.length; });
    const out = new Uint8Array(n);
    let o = 0;
    parts.forEach(function (b) { out.set(b, o); o += b.length; });
    return out;
  }

  /* Холст → PDF: страница точно по размеру листа в миллиметрах. */
  function canvasJpegBytes(cv) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        if (!blob) { reject(new Error('JPEG')); return; }
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, 'image/jpeg', 0.95);
    });
  }

  function canvasPdf(cv, pxPerMm) {
    return canvasJpegBytes(cv).then(function (jpg) {
      return joinBytes(A.pdfFromJpeg(jpg, cv.width, cv.height, cv.width / pxPerMm, cv.height / pxPerMm));
    });
  }

  /* Таблица перевода цвета в CMYK большая, поэтому подгружается только когда нужна. */
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

  /* JPEG для типографии — в том виде, в каком его делают сейчас: CMYK (мелованная бумага,
   * FOGRA39) и ровно 300 dpi. Макет пересчитывается с рабочего разрешения в 300 dpi и кодируется
   * полосами по 8 строк, чтобы страница не замирала. Не вышло — отдаём обычный JPEG в RGB. */
  async function canvasJpeg(cv, pxPerMm) {
    let small = null;
    try {
      const lut = await loadCmykLut();
      // 300 dpi; огромные холсты (больше ~120 × 120 см) — с меньшим, иначе файл на сотни мегабайт
      let dpi = 300, k = (dpi / 25.4) / pxPerMm;
      const area = cv.width * cv.height * k * k;
      if (area > JPEG_MAX_PIXELS) { dpi = Math.floor(dpi * Math.sqrt(JPEG_MAX_PIXELS / area)); k = (dpi / 25.4) / pxPerMm; }
      const w = Math.max(8, Math.round(cv.width * k)), h = Math.max(8, Math.round(cv.height * k));
      // пересчитываем полосами по 256 строк: целый холст в 300 dpi мог не влезть в память браузера
      const BAND = 256;
      small = A.makeCanvas(w, BAND);
      const x = small.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      const enc = A.jpegCmyk(w, h, lut, 80, dpi);
      for (let y0 = 0; y0 < h; y0 += BAND) {
        const bh = Math.min(BAND, h - y0);
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, w, BAND);
        x.drawImage(cv, 0, -y0, w, h);
        const data = x.getImageData(0, 0, w, bh).data;
        for (let y = 0; y < bh; y += 8) enc.band(data.subarray(y * w * 4, (y + 8) * w * 4), Math.min(8, bh - y));
        await wait(0);
      }
      return joinBytes(enc.finish());
    } catch (e) {
      console.error(e);
      return canvasJpegBytes(cv).then(function (jpg) { return A.jpegSetDpi(jpg, pxPerMm * 25.4); });
    } finally {
      release(small);
    }
  }

  function exportKinds() {
    return ['layout', 'scheme', 'mosaic', 'legend', 'insert', 'csv']
      .concat($('withDocx').checked ? ['docx'] : [], // наклейки листом A4 убраны: этикетки печатают лентой на термопринтере
         $('withJpg').checked ? ['jpg'] : [], $('withPdf').checked ? ['pdf'] : []);
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
    const pdf = kinds.indexOf('pdf') >= 0; // к схеме и макету добавить PDF с точным размером листа
    const jpg = kinds.indexOf('jpg') >= 0; // макет ещё и в JPEG — так его берёт типография
    let scheme = null, cv = null;
    exporting++;
    try {
      const under = underlay();
      if (kinds.indexOf('scheme') >= 0 || kinds.indexOf('layout') >= 0) scheme = A.renderScheme(res, cell, p.shape, -1, under);
      for (const kind of kinds) {
        await wait(20); // даём браузеру обновить надпись о ходе работы
        if (kind === 'csv') {
          out.push({ name: T('Расход страз.csv'), data: new TextEncoder().encode(A.legendCsv(res, p)) });
        } else if (kind === 'scheme') {
          out.push({ name: FILE_NAMES.scheme, data: await canvasPng(scheme, pxmm) });
          if (pdf) out.push({ name: T('Схема для печати.pdf'), data: await canvasPdf(scheme, pxmm) });
        } else if (kind === 'layout') {
          cv = A.renderLayout(res, p, img, cell, scheme);
          out.push({ name: FILE_NAMES.layout, data: await canvasPng(cv, pxmm) });
          if (jpg) out.push({ name: printName() + '.jpg', data: await canvasJpeg(cv, pxmm) });
          if (pdf) out.push({ name: T('Макет.pdf'), data: await canvasPdf(cv, pxmm) });
        } else if (kind === 'mosaic') {
          const mc = Math.min(cell, 16);
          cv = A.renderMosaic(res, mc, p.shape, -1, under);
          out.push({ name: FILE_NAMES.mosaic, data: await canvasPng(cv, mc / p.pitch) });
        } else if (kind === 'legend') {
          cv = A.renderLegend(res, p);
          out.push({ name: FILE_NAMES.legend, data: await canvasPng(cv, 0) });
        } else if (kind === 'insert') {
          cv = A.renderInsert(res, p, img, 1);
          out.push({ name: FILE_NAMES.insert, data: await canvasPng(cv, A.INSERT_PX_PER_MM) });
        } else if (kind === 'docx') {
          // этикетки для ленточного принтера — тот же файл Word, что раньше набирали вручную
          const k = 1 + (p.reserve || 0) / 100;
          const parts = A.labelsDocx({
            article: p.article, title: p.title, unit: T('шт'),
            rows: res.colors.map(function (c) { return { symbol: c.symbol, code: c.code, count: Math.ceil(c.count * k) }; })
          });
          out.push({ name: T('Этикетки') + ' ' + baseName() + '.docx', data: joinBytes(parts) });
        } else if (kind === 'labels') {
          const pages = A.renderLabels(res, p);
          for (let i = 0; i < pages.length; i++) {
            out.push({ name: T('Наклейки на пакетики') + (pages.length > 1 ? ' ' + (i + 1) : '') + '.png', data: await canvasPng(pages[i], A.INSERT_PX_PER_MM) });
            release(pages[i]);
          }
        }
        release(cv);
        cv = null;
      }
    } finally {
      release(cv);
      release(scheme);
      exporting--;
      releaseRetired();
    }
    out.dpi = scheme ? dpiOf(cell, p) : 0; // 0 — печатное разрешение для этих файлов не важно
    return out;
  }

  function baseName() {
    const p = state.p;
    const s = [p.article, p.title].filter(Boolean).join(' ')
      .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 80).trim();
    return s || T('Схема ') + p.wCm + 'x' + p.hCm;
  }

  /* Имя файла для типографии — как принято у заказчика: один артикул без «AS» (44179.jpg).
   * Артикул не задан — обычное имя по названию. */
  function printName() {
    const a = String(state.p.article || '').replace(/^\s*AS\b\s*/i, '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 60);
    return a || baseName();
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
    const lab = button.querySelector('span') || button; // у кнопок со значком меняем только подпись
    const old = lab.textContent;
    $('zip').disabled = $('saveOne').disabled = true;
    lab.textContent = label;
    setStatus(T('Готовлю файлы в печатном качестве, это займёт несколько секунд…'));
    await wait(40);
    try {
      const wanted = dpiOf(exportCell(state.p, state.res), state.p);
      const dpi = await job();
      setStatus(dpi && dpi < wanted
        ? T('Сохранено, но с разрешением ') + dpi + T(' dpi: это устройство не справляется с большим. Для печати лучше скачать с компьютера.')
        : T('Сохранено в папку загрузок'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти. Уменьшите размер холста или скачайте с компьютера.'), 'error');
    }
    lab.textContent = old;
    state.busy = false;
    $('zip').disabled = !state.res;
    $('saveOne').disabled = !state.res || state.tab === 'original';
  }

  function saveZip() {
    return runExport($('zip'), T('Собираю комплект…'), async function () {
      const name = baseName();
      const files = await buildFiles(exportKinds());
      download(A.zipStore(files), name + '.zip', 'application/zip');
      return files.dpi;
    });
  }

  /* Макет одним файлом JPEG — без архива: его сразу можно положить на диск для типографии. */
  function saveJpg() {
    return runExport($('jpgSave'), T('Готовлю файл…'), async function () {
      const files = await buildFiles(['layout', 'jpg']);
      const jpg = files.filter(function (f) { return /\.jpg$/.test(f.name); })[0];
      download([jpg.data], jpg.name, 'image/jpeg');
      return files.dpi;
    });
  }

  function saveOne() {
    if (state.tab === 'original') return Promise.resolve();
    return runExport($('saveOne'), T('Готовлю файл…'), async function () {
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

  /* Рабочая копия картинки: повёрнутая, отражённая, в нужном тоне. Всё остальное
   * (схема, макет, миниатюры) берётся с неё, оригинал остаётся нетронутым. */
  function rebuildSource() {
    const raw = state.raw, tf = state.tf;
    const iw = raw.naturalWidth, ih = raw.naturalHeight;
    const k = Math.min(1, 4000 / Math.max(iw, ih)); // больше для схемы не нужно, а память экономит
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    const turned = tf.rot % 180 !== 0;
    const cv = A.makeCanvas(turned ? h : w, turned ? w : h), x = cv.getContext('2d', { willReadFrequently: tf.tone !== 'color' });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#ffffff'; // прозрачные места считаем белыми
    x.fillRect(0, 0, cv.width, cv.height);
    x.translate(cv.width / 2, cv.height / 2);
    x.rotate((tf.rot * Math.PI) / 180);
    x.scale(tf.flipX ? -1 : 1, tf.flipY ? -1 : 1);
    x.drawImage(raw, -w / 2, -h / 2, w, h);
    if (tf.tone !== 'color') {
      const im = x.getImageData(0, 0, cv.width, cv.height), d = im.data, sepia = tf.tone === 'sepia';
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (sepia) {
          d[i] = Math.min(255, 0.393 * r + 0.769 * g + 0.189 * b);
          d[i + 1] = Math.min(255, 0.349 * r + 0.686 * g + 0.168 * b);
          d[i + 2] = Math.min(255, 0.272 * r + 0.534 * g + 0.131 * b);
        } else d[i] = d[i + 1] = d[i + 2] = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      x.putImageData(im, 0, 0);
    }
    cv.naturalWidth = cv.width;
    cv.naturalHeight = cv.height;
    if (state.img && state.img !== raw && state.img.getContext) release(state.img);
    state.img = cv;
    release(state.thumb);
    const tk = Math.min(1, 640 / Math.max(cv.width, cv.height));
    state.thumb = A.downscale(cv, { x: 0, y: 0, w: cv.width, h: cv.height }, Math.max(1, Math.round(cv.width * tk)), Math.max(1, Math.round(cv.height * tk)));
    $('tone').value = tf.tone;
    $('imageTools').hidden = false;
  }

  /* Поворот, отражение или смена тона: схема пересчитывается, прорисовка кистью привязана
   * к прежнему положению картинки, поэтому при повороте и отражении её приходится стирать. */
  function transformImage(change) {
    if (!state.raw || state.busy) return;
    const moves = change.rot !== undefined || change.flipX !== undefined || change.flipY !== undefined;
    if (moves && state.paint.cells.size && !window.confirm(T('Картинка повернётся, и прорисовка кистью будет стёрта. Продолжить?'))) return;
    const tf = state.tf;
    if (change.rot !== undefined) {
      tf.rot = (tf.rot + change.rot + 360) % 360;
      const w = $('wCm').value;      // холст поворачивается вместе с картинкой
      $('wCm').value = $('hCm').value;
      $('hCm').value = w;
    }
    if (change.flipX) tf.flipX = !tf.flipX;
    if (change.flipY) tf.flipY = !tf.flipY;
    if (change.tone !== undefined) tf.tone = change.tone === 'bw' || change.tone === 'sepia' ? change.tone : 'color';
    if (moves) {
      state.paint = { cols: 0, rows: 0, cells: new Map() };
      state.undo = []; state.redo = [];
      state.focusX = state.focusY = 0.5;
    }
    rebuildSource();
    const thumb = $('dropThumb');
    thumb.style.backgroundImage = 'url("' + state.thumb.toDataURL('image/jpeg', 0.8) + '")';
    syncOutputs();
    saveSettings();
    clearTimeout(timer);
    timer = null;
    pendingFull = false;
    recompute();
  }

  /* Чистый холст: схема рисуется кистью с нуля, без картинки. */
  function startBlank() {
    if (state.busy) return;
    const p = params();
    const cv = A.makeCanvas(Math.round(p.wCm * 20), Math.round(p.hCm * 20)), x = cv.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cv.width, cv.height);
    loadImage(cv.toDataURL('image/png'), T('Чистый холст'), false).then(function () {
      release(cv);
      setStep(4);
      if (!state.brush.on) toggleBrush();
      setStatus(T('Чистый холст готов. Выберите цвет в списке или кнопкой «сменить» и рисуйте.'));
    }, function () {});
  }

  /* opt.keep — картинка открывается вместе с сохранённой работой: правки и кадр не сбрасываем;
   * opt.blob — исходный файл (для сохранения проекта); opt.id, opt.stored — картинка уже лежит в хранилище. */
  let loadSeq = 0; // открывается только последняя выбранная картинка, даже если прежняя догрузится позже
  function staleLoad() { const e = new Error('stale'); e.stale = true; return e; }

  function loadImage(src, name, isBlob, opt) {
    opt = opt || {};
    const seq = ++loadSeq;
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        if (seq !== loadSeq) { if (isBlob) URL.revokeObjectURL(src); reject(staleLoad()); return; }
        const iw = img.naturalWidth, ih = img.naturalHeight;
        if (!iw || !ih || iw * ih > MAX_IMAGE_PIXELS) {
          if (isBlob) URL.revokeObjectURL(src);
          setStatus(iw && ih ? T('Картинка слишком большая. Уменьшите её до 10 000 точек по длинной стороне.') : T('В файле нет изображения.'), 'error');
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
          setStatus(T('Не удалось прочитать эту картинку. Сохраните её как JPG или PNG и загрузите снова.'), 'error');
          reject(e);
          return;
        }
        release(thumbCanvas);
        try {
        if (state.imgUrl && state.imgUrl !== src) URL.revokeObjectURL(state.imgUrl); // прежняя картинка больше не нужна
        state.raw = img;
        if (!opt.keep) state.tf = { rot: 0, flipX: false, flipY: false, tone: 'color' };
        if (state.brush.code === A.EMPTY) state.brush.code = null; // новая картинка — кисть снова красит цветом
        state.brush.tool = 'brush';
        state.imgUrl = isBlob ? src : '';
        rebuildSource();
        thumbUrl = state.thumb.toDataURL('image/jpeg', 0.8);
        state.imgName = String(name || '').slice(0, 120);
        state.imgBlob = opt.blob || null;
        state.imgId = opt.id || String(Date.now()) + Math.random().toString(36).slice(2, 8);
        imageDirty = !opt.stored;
        state.zoom = 1;
        state.undo = []; state.redo = [];
        lastCell = null;
        state.highlightCode = null;
        if (!opt.keep) {
          // холст разворачиваем под ориентацию картинки
          const w = +$('wCm').value, h = +$('hCm').value;
          if ((iw > ih * 1.05 && w < h) || (ih > iw * 1.05 && w > h)) { $('wCm').value = h; $('hCm').value = w; }
          state.focusX = state.focusY = 0.5;
          state.excluded.clear(); // убранные и заменённые цвета, прорисовка относятся к прежней картинке
          state.replaced.clear();
          state.paint = { cols: 0, rows: 0, cells: new Map() };
        }
        const thumb = $('dropThumb');
        thumb.textContent = '';
        thumb.style.backgroundImage = 'url("' + thumbUrl + '")';
        $('dropTitle').textContent = name || T('Картинка загружена');
        $('dropHint').textContent = fmt(iw) + ' × ' + fmt(ih) + T(' точек · нажмите, чтобы заменить');
        syncOutputs();
        saveSettings();
        clearTimeout(timer);
        timer = null;
        pendingFull = false;
        recompute();
        if (!batchRunning) setStep(opt.keep ? 4 : 2); // новая картинка — к размеру холста; сохранённая работа — сразу к правке
        resolve();
        } catch (e) { // например, браузеру (iPad) не хватило памяти на холст — не оставляем страницу «занятой»
          console.error(e);
          setStatus(T('Не удалось прочитать эту картинку. Сохраните её как JPG или PNG и загрузите снова.'), 'error');
          reject(e);
        }
      };
      img.onerror = function () {
        if (seq !== loadSeq) { if (isBlob) URL.revokeObjectURL(src); reject(staleLoad()); return; }
        if (isBlob) URL.revokeObjectURL(src);
        setStatus(T('Не удалось открыть файл. Подойдут JPG, PNG, WebP. Фото с iPhone в формате HEIC сначала сохраните как JPG.'), 'error');
        reject(new Error('image load failed'));
      };
      img.src = src;
    });
  }

  function loadFile(file) {
    if (!file) return;
    if (state.busy) return;
    if (/\.(csv|txt)$/i.test(file.name)) { loadPaletteFile(file); return; } // таблицу цветов тоже можно перетащить
    if (/\.(almaz|json)$/i.test(file.name)) { openProjectFile(file); return; }
    if (!isImageFile(file)) { setStatus(T('Это не картинка. Подойдут JPG, PNG, WebP.'), 'error'); return; }
    setStatus(T('Открываю картинку…'));
    loadImage(URL.createObjectURL(file), file.name, true, { blob: file }).catch(function () {});
  }

  /* Несколько картинок сразу — делаем комплект для каждой. */
  function loadFiles(list) {
    const files = Array.prototype.slice.call(list || []);
    const images = files.filter(isImageFile);
    if (images.length > 1) runBatch(images); else loadFile(files[0]);
  }

  // ---------- пачка картинок ----------
  let batchRunning = false;

  async function runBatch(files) {
    if (state.busy) return;
    const extra = Math.max(0, files.length - MAX_BATCH);
    files = files.slice(0, MAX_BATCH);
    state.busy = batchRunning = true;
    $('zip').disabled = $('saveOne').disabled = true;
    const out = [], failed = [], used = new Set(), kinds = exportKinds();
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus(T('Картинка ') + (i + 1) + T(' из ') + files.length + ': ' + f.name + T(' — готовлю комплект…'));
        await wait(40);
        try {
          await loadImage(URL.createObjectURL(f), f.name, true, { blob: f });
          if (!state.res) throw new Error('нет результата');
          setStatus(T('Картинка ') + (i + 1) + T(' из ') + files.length + ': ' + f.name + T(' — готовлю комплект…'));
          const built = await buildFiles(kinds);
          const base = f.name.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 60) || T('Картинка');
          let folder = base, k = 2;
          while (used.has(folder.toLowerCase())) folder = base + ' (' + (k++) + ')';
          used.add(folder.toLowerCase());
          built.forEach(function (b) { out.push({ name: folder + '/' + b.name, data: b.data }); });
        } catch (e) {
          console.error(e);
          failed.push(f.name);
        }
      }
      const done = files.length - failed.length;
      if (done) download(A.zipStore(out), T('Макеты — ') + done + T(' шт.zip'), 'application/zip');
      setStatus((done ? T('Готово: комплектов ') + done + T(', архив в папке загрузок. ') : '') +
        (failed.length ? T('Не получилось: ') + failed.join(', ') + '. ' : '') +
        (extra ? T('За один раз обрабатываю до ') + MAX_BATCH + T(' картинок — остальные загрузите следующей пачкой.') : ''), failed.length || !done ? 'error' : 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось собрать архив: браузеру не хватило памяти. Загрузите меньше картинок за раз.'), 'error');
    }
    state.busy = batchRunning = false;
    touch(); // последняя картинка пачки остаётся открытой — её и запоминаем
    $('zip').disabled = !state.res;
    $('saveOne').disabled = !state.res || state.tab === 'original';
  }

  // ---------- сохранение работы ----------
  let saveTimer = null, imageDirty = false, dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        try {
          const rq = indexedDB.open('almaz-schema', 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { reject(rq.error); };
        } catch (e) { reject(e); }
      });
    }
    return dbPromise;
  }

  function dbPut(key, value) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function dbGet(key) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        const rq = d.transaction('kv', 'readonly').objectStore('kv').get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  /* Всё, что нужно, чтобы продолжить работу над этой картинкой (без самой картинки). */
  function projectData() {
    const fields = {};
    PROJECT_FIELDS.forEach(function (id) { fields[id] = fieldGet(id); });
    const cells = {};
    state.paint.cells.forEach(function (code, i) { (cells[code] = cells[code] || []).push(i); });
    return {
      app: 'almaz-schema', v: 1, name: state.imgName, imageId: state.imgId,
      fields: fields, nColors: wantColors,
      shape: document.querySelector('input[name=shape]:checked').value,
      focus: [state.focusX, state.focusY],
      tf: { rot: state.tf.rot, flipX: state.tf.flipX, flipY: state.tf.flipY, tone: state.tf.tone },
      excluded: Array.from(state.excluded),
      replaced: Array.from(state.replaced),
      paint: { cols: state.paint.cols, rows: state.paint.rows, cells: cells },
      marks: { symbols: Array.from(state.symbols), print: Array.from(state.print) },
      palette: pal === defaultPal ? null : { name: palName, text: paletteText() }
    };
  }

  function okCode(c) { return typeof c === 'string' && c.length > 0 && c.length <= 16; }

  /* Переносит сохранённую работу в поля и состояние. Чужому файлу не доверяем: всё проверяется. */
  function applyProjectData(o) {
    const f = o.fields && typeof o.fields === 'object' ? o.fields : {};
    PROJECT_FIELDS.forEach(function (id) { if (typeof f[id] === 'string' && f[id].length <= 400) fieldSet(id, f[id]); });
    const n = parseInt(o.nColors, 10);
    if (n >= 2 && n <= A.MAX_COLORS) wantColors = n;
    if (o.shape === 'round' || o.shape === 'square') document.querySelector('input[name=shape][value=' + o.shape + ']').checked = true;
    if (o.palette && typeof o.palette.text === 'string' && o.palette.text.length < 400000) {
      const parsed = A.parsePaletteText(o.palette.text);
      if (parsed.items.length >= 2) { pal = A.paletteFromItems(parsed.items); palName = String(o.palette.name || T('Своя таблица')).slice(0, 60); palNote = ''; }
    } else if (o.palette === null) { pal = defaultPal; palName = ''; palNote = ''; }
    showPalette();
    storePalette();
    const fx = Array.isArray(o.focus) ? o.focus : [];
    state.focusX = clamp(+fx[0] || 0, 0, 1);
    state.focusY = clamp(+fx[1] || 0, 0, 1);
    if (!Array.isArray(o.focus)) state.focusX = state.focusY = 0.5;
    const tf = o.tf && typeof o.tf === 'object' ? o.tf : {};
    state.tf = {
      rot: [0, 90, 180, 270].indexOf(tf.rot) >= 0 ? tf.rot : 0, flipX: tf.flipX === true, flipY: tf.flipY === true,
      tone: tf.tone === 'bw' || tf.tone === 'sepia' ? tf.tone : 'color'
    };
    state.excluded = new Set((Array.isArray(o.excluded) ? o.excluded : []).filter(okCode).slice(0, A.MAX_PALETTE));
    state.replaced = new Map();
    (Array.isArray(o.replaced) ? o.replaced : []).slice(0, 500).forEach(function (pair) {
      if (Array.isArray(pair) && okCode(pair[0]) && okCode(pair[1])) state.replaced.set(pair[0], pair[1]);
    });
    const paint = { cols: 0, rows: 0, cells: new Map() };
    const pt = o.paint && typeof o.paint === 'object' ? o.paint : null;
    if (pt && pt.cols > 0 && pt.rows > 0 && pt.cols <= 2000 && pt.rows <= 2000 && pt.cells && typeof pt.cells === 'object') {
      paint.cols = pt.cols | 0;
      paint.rows = pt.rows | 0;
      const total = paint.cols * paint.rows;
      Object.keys(pt.cells).slice(0, 200).forEach(function (code) {
        if (!okCode(code) || !Array.isArray(pt.cells[code])) return; // «без страз» хранится под своим служебным номером
        pt.cells[code].forEach(function (i) { if (Number.isInteger(i) && i >= 0 && i < total) paint.cells.set(i, code); });
      });
    }
    state.paint = paint;
    if (o.marks && typeof o.marks === 'object') { state.symbols.clear(); state.print.clear(); } // значки этой работы, а не общие
    readMarks(o.marks);
    storeMarks();
    normalizeInputs();
    syncOutputs();
    showStockNote();
    saveSettings();
  }

  function imageBlob() {
    if (state.imgBlob) return Promise.resolve(state.imgBlob);
    return new Promise(function (resolve, reject) {
      const img = state.raw, cv = A.makeCanvas(img.naturalWidth, img.naturalHeight);
      cv.getContext('2d').drawImage(img, 0, 0);
      cv.toBlob(function (b) { release(cv); if (b) resolve(b); else reject(new Error('нет картинки')); }, 'image/png');
    });
  }

  /* Работа сохраняется в браузере сама, чуть погодя после каждого изменения. */
  function touch() {
    if (!state.img || batchRunning) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(autosave, 1200);
  }

  function autosave() {
    saveTimer = null;
    if (!state.img || batchRunning) return;
    const jobs = [];
    if (imageDirty) {
      imageDirty = false;
      const id = state.imgId, name = state.imgName;
      jobs.push(imageBlob().then(function (blob) { return dbPut('image', { blob: blob, name: name, id: id }); }));
    }
    jobs.push(dbPut('state', projectData()));
    jobs.push(saveRecent());
    return Promise.all(jobs).catch(function () { /* хранилище недоступно — остаётся файл проекта */ });
  }

  // ---------- недавние работы ----------
  const RECENT_MAX = 8;

  function dbDel(key) {
    return db().then(function (d) {
      return new Promise(function (resolve) {
        const tx = d.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = tx.onerror = tx.onabort = function () { resolve(); };
      });
    });
  }

  /* Каждая работа хранится целиком (картинка + правки), в списке — имя и миниатюра.
   * Самые старые сверх лимита удаляются, чтобы не занимать место в браузере. */
  function saveRecent() {
    if (!state.img || !state.raw || !state.thumb) return Promise.resolve();
    const id = state.imgId, data = projectData(), name = state.imgName;
    const small = A.downscale(state.thumb, { x: 0, y: 0, w: state.thumb.width, h: state.thumb.height },
      Math.max(1, Math.round(state.thumb.width * 0.25)), Math.max(1, Math.round(state.thumb.height * 0.25)));
    const thumb = small.toDataURL('image/jpeg', 0.7);
    release(small);
    return dbGet('recent').then(function (list) {
      list = (Array.isArray(list) ? list : []).filter(function (r) { return r && r.id !== id; });
      const known = recentIds.has(id);
      list.unshift({ id: id, name: name, time: Date.now(), thumb: thumb });
      const drop = list.slice(RECENT_MAX);
      list = list.slice(0, RECENT_MAX);
      const jobs = [dbPut('recent', list), dbPut('work:' + id, data)];
      if (!known) jobs.push(imageBlob().then(function (blob) { return dbPut('img:' + id, blob); }));
      drop.forEach(function (r) { jobs.push(dbDel('work:' + r.id), dbDel('img:' + r.id)); recentIds.delete(r.id); });
      recentIds.add(id);
      return Promise.all(jobs).then(function () { showRecent(list); });
    });
  }
  const recentIds = new Set();

  function showRecent(list) {
    const box = $('recentBox'), el2 = $('recentList');
    el2.textContent = '';
    list = Array.isArray(list) ? list : [];
    box.hidden = list.length === 0;
    list.forEach(function (r) {
      if (!r || typeof r.id !== 'string') return;
      recentIds.add(r.id);
      const b = el('button', 'recent-item');
      b.type = 'button';
      b.title = T('Открыть: ') + String(r.name || '');
      if (typeof r.thumb === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(r.thumb)) b.style.backgroundImage = 'url("' + r.thumb + '")';
      b.appendChild(el('span', '', String(r.name || '').replace(/\.[^.]+$/, '')));
      b.addEventListener('click', function () { openRecent(r.id); });
      el2.appendChild(b);
    });
  }

  function openRecent(id) {
    if (state.busy) return;
    Promise.all([dbGet('work:' + id), dbGet('img:' + id)]).then(function (got) {
      const st = got[0], blob = got[1];
      if (!st || !(blob instanceof Blob)) throw new Error('нет работы');
      applyProjectData(st);
      return loadImage(URL.createObjectURL(blob), st.name, true, { keep: true, blob: blob, id: id });
    }).catch(function (e) { if (!(e && e.stale)) setStatus(T('Не удалось открыть эту работу: её нет в памяти браузера.'), 'error'); });
  }

  function restoreWork() {
    return Promise.all([dbGet('state'), dbGet('image')]).then(function (got) {
      const st = got[0], im = got[1];
      if (state.img || !im || !(im.blob instanceof Blob)) return;
      const same = !!st && typeof st === 'object' && st.imageId === im.id;
      if (same) applyProjectData(st);
      return loadImage(URL.createObjectURL(im.blob), im.name, true, { keep: same, blob: im.blob, id: im.id, stored: true }).then(function () {
        setStatus(T('Открыта прошлая работа') + (im.name ? ' — ' + im.name : '') + T('. Чтобы начать новую, загрузите другую картинку.'));
      });
    }).catch(function () { /* нет сохранённой работы или хранилище недоступно */ });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function saveProject() {
    if (!state.img || state.busy) return;
    flush();
    setStatus(T('Сохраняю проект…'));
    imageBlob().then(blobToDataUrl).then(function (dataUrl) {
      const o = projectData();
      o.image = dataUrl;
      o.logos = state.logos.map(function (l) { return { name: l.name, data: l.data }; });
      download([JSON.stringify(o)], baseName() + '.almaz', 'application/json');
      setStatus(T('Проект сохранён в папку загрузок. Откройте его кнопкой «Открыть проект» — и продолжите с того же места.'), 'ok');
    }).catch(function (e) {
      console.error(e);
      setStatus(T('Не удалось сохранить проект.'), 'error');
    });
  }

  function openProjectFile(file) {
    if (!file || state.busy) return;
    if (file.size > 120e6) { setStatus(T('Файл проекта слишком большой.'), 'error'); return; }
    setStatus(T('Открываю проект…'));
    file.text().then(function (text) {
      const o = JSON.parse(text);
      if (!o || o.app !== 'almaz-schema' || typeof o.image !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(o.image)) throw new Error('не проект');
      applyProjectData(o);
      const logos = (Array.isArray(o.logos) ? o.logos : []).filter(function (l) {
        return l && typeof l.data === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(l.data);
      }).slice(0, MAX_LOGOS);
      const ready = logos.length ? Promise.all(logos.map(loadLogoData)).then(function (items) {
        state.logos = items.filter(Boolean);
        showLogos();
        storeLogos();
      }) : Promise.resolve();
      return ready.then(function () {
        return loadImage(o.image, String(o.name || file.name), false, { keep: true });
      }).then(function () {
        setStatus(T('Проект открыт') + (o.name ? ' — ' + String(o.name).slice(0, 80) : '') + '.', 'ok');
      });
    }).catch(function (e) {
      if (e && e.stale) return; // пока открывался проект, выбрали другую картинку
      console.error(e);
      setStatus(T('Не удалось открыть проект: файл повреждён или это не проект «Алмазной схемы».'), 'error');
    });
  }

  // ---------- QR-коды и логотип для макета ----------
  function showLogos() {
    const n = state.logos.length, list = $('logoList');
    list.textContent = '';
    list.hidden = n === 0;
    state.logos.forEach(function (l, i) {
      const item = el('div', 'logo-item');
      const im = el('img');
      im.src = l.data;
      im.alt = l.name;
      im.title = l.name;
      const x = el('button', 'color-x', '×');
      x.type = 'button';
      x.title = T('Убрать картинку «') + l.name + '»';
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', function () {
        state.logos.splice(i, 1);
        showLogos();
        storeLogos();
        schedule(false);
      });
      item.appendChild(im);
      item.appendChild(x);
      list.appendChild(item);
    });
    $('logoHint').textContent = n ? T('Стоят внизу макета в ряд, в этом порядке. Сохранены для следующих макетов.')
      : T('До четырёх картинок — встанут в ряд внизу макета. Запоминаются для следующих макетов.');
    $('logoPick').textContent = n ? T('Добавить ещё') : T('Добавить картинки');
    $('logoPick').disabled = n >= MAX_LOGOS;
  }

  function storeLogos() {
    try {
      localStorage.setItem('almaz-logos', JSON.stringify(state.logos.map(function (l) { return { name: l.name, data: l.data }; })));
    } catch (e) {
      setStatus(T('Картинки стоят на макете, но запомнить их для следующего раза не удалось: в браузере мало места.'));
    }
  }

  function readLogo(file) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        let item = null;
        try {
          const iw = img.naturalWidth, ih = img.naturalHeight;
          if (iw > 0 && ih > 0 && iw * ih <= MAX_IMAGE_PIXELS) {
            const k = Math.min(1, LOGO_SIDE / Math.max(iw, ih));
            const cv = A.makeCanvas(Math.max(1, Math.round(iw * k)), Math.max(1, Math.round(ih * k)));
            const x = cv.getContext('2d');
            x.imageSmoothingEnabled = k < 1; // мелкие QR-коды не размываем
            x.imageSmoothingQuality = 'high';
            x.drawImage(img, 0, 0, cv.width, cv.height);
            item = { img: cv, name: String(file.name || T('картинка')).slice(0, 60), data: cv.toDataURL('image/png') };
          }
        } catch (e) { console.error(e); }
        URL.revokeObjectURL(url);
        resolve(item);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function addLogoFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []).filter(isImageFile);
    const room = MAX_LOGOS - state.logos.length;
    if (!files.length) { setStatus(T('Нужны картинки: PNG или JPG.'), 'error'); return Promise.resolve(); }
    return Promise.all(files.slice(0, room).map(readLogo)).then(function (items) {
      const ok = items.filter(Boolean);
      ok.forEach(function (it) { state.logos.push(it); });
      showLogos();
      storeLogos();
      schedule(false);
      const lost = items.length - ok.length, extra = files.length - items.length;
      if (lost || extra) {
        setStatus((lost ? T('Не удалось открыть картинок: ') + lost + '. ' : '') + (extra ? T('Помещается не больше ') + MAX_LOGOS + T(' картинок.') : ''), 'error');
      }
    });
  }

  function loadLogoData(o) {
    return new Promise(function (resolve) {
      const img = new Image();
      img.onload = function () { resolve({ img: img, name: String(o.name || T('картинка')).slice(0, 60), data: o.data }); };
      img.onerror = function () { resolve(null); };
      img.src = o.data;
    });
  }

  function restoreLogos() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('almaz-logos') || '[]'); } catch (e) { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    saved = saved.filter(function (o) {
      return o && typeof o.data === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.data);
    }).slice(0, MAX_LOGOS);
    return Promise.all(saved.map(loadLogoData)).then(function (items) {
      state.logos = items.filter(Boolean).concat(state.logos).slice(0, MAX_LOGOS);
      showLogos();
      if (state.logos.length) schedule(false);
    });
  }

  // ---------- своя таблица цветов ----------
  function showPalette() {
    const custom = pal !== defaultPal;
    const n = pal.items.length;
    $('palName').textContent = custom ? palName : T('Открытая таблица DMC');
    $('palHint').textContent = custom
      ? T('Ваша таблица, цветов: ') + n + palNote
      : n + T(' цвета ниток — оттенки страз могут отличаться');
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
    state.replaced.clear();
    state.highlightCode = null;
    showPalette();
    storePalette();
  }

  /* Возвращает true, если таблица принята. */
  function loadPaletteText(text, name) {
    const parsed = A.parsePaletteText(text);
    if (parsed.items.length < 2) {
      setStatus(T('В файле не нашлось цветов. Нужна таблица: в каждой строке номер и цвет (#rrggbb или R;G;B).'), 'error');
      return false;
    }
    const note = (parsed.skipped ? T(' · не прочитано строк: ') + parsed.skipped : '') +
      (parsed.tooMany ? T(' · взяты первые ') + A.MAX_PALETTE : '');
    setPalette(A.paletteFromItems(parsed.items), String(name || T('Своя таблица')).slice(0, 60), note);
    schedule(true);
    if (!state.img) setStatus(T('Таблица загружена, цветов: ') + parsed.items.length, 'ok');
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
      setStatus(T('Файлы Excel напрямую не читаются. Сохраните таблицу как CSV и загрузите её.'), 'error');
      return;
    }
    if (file.size > 2e6) { setStatus(T('Файл таблицы слишком большой — в нём должны быть только номера и цвета.'), 'error'); return; }
    file.arrayBuffer().then(function (buf) { loadPaletteText(decodeText(new Uint8Array(buf)), file.name); }, function () {
      setStatus(T('Не удалось прочитать файл таблицы'), 'error');
    });
  }

  function resetPalette() {
    setPalette(defaultPal, '');
    schedule(true);
    if (!state.img) setStatus(T('Возвращена открытая таблица DMC'));
  }

  function restorePalette() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-palette') || 'null');
      if (o && typeof o.text === 'string') {
        const parsed = A.parsePaletteText(o.text);
        if (parsed.items.length >= 2) {
          pal = A.paletteFromItems(parsed.items);
          palName = String(o.name || T('Своя таблица')).slice(0, 60);
          palNote = '';
        }
      }
    } catch (e) { /* игнорируем */ }
    showPalette();
  }

  function savePaletteSample() {
    download(['\ufeff' + paletteText()], T('Таблица цветов — образец.csv'), 'text/csv');
    setStatus(T('Образец сохранён: замените в нём цвета на цвета своих страз и загрузите обратно'), 'ok');
  }

  function resetAll() {
    wantColors = DEFAULTS.nColors;
    Object.keys(DEFAULTS).forEach(function (id) { fieldSet(id, String(DEFAULTS[id])); });
    document.querySelector('input[name=shape][value=square]').checked = true;
    if (state.img && state.img.naturalWidth > state.img.naturalHeight * 1.05) { $('wCm').value = DEFAULTS.hCm; $('hCm').value = DEFAULTS.wCm; }
    state.focusX = state.focusY = 0.5;
    state.excluded.clear();
    state.replaced.clear();
    state.symbols.clear();
    state.print.clear();
    storeMarks();
    state.highlightCode = null;
    drawCrop();
    schedule(true);
    if (!state.img) setStatus(T('Настройки сброшены'));
  }

  // ---------- этапы и панели ----------
  const ui = { step: 1, panel: true, colors: true, hints: true };
  const STEP_NAMES = { 1: 'Картинка', 2: 'Холст', 3: 'Цвета', 4: 'Правка', 5: 'Макет' };

  function isNarrow() { return !!window.matchMedia && window.matchMedia('(max-width: 820px)').matches; }

  function loadUi() {
    try {
      const o = JSON.parse(localStorage.getItem('almaz-ui') || 'null');
      if (o && typeof o === 'object') ['panel', 'colors', 'hints'].forEach(function (k) { if (typeof o[k] === 'boolean') ui[k] = o[k]; });
    } catch (e) { /* игнорируем */ }
    if (isNarrow()) { ui.colors = false; ui.panel = true; } // на телефоне список цветов закрывает экран — он открывается кнопкой
  }

  function saveUi() {
    try { localStorage.setItem('almaz-ui', JSON.stringify({ panel: ui.panel, colors: ui.colors, hints: ui.hints })); } catch (e) { /* не запомнится */ }
  }

  /* Какие панели видны. Список цветов появляется только когда есть схема. */
  function applyUi() {
    const showColors = !!state.res && ui.colors;
    document.body.classList.toggle('hide-panel', !ui.panel);
    document.body.classList.toggle('with-colors', showColors);
    $('colorsPanel').hidden = !showColors;
    $('panelToggle').setAttribute('aria-pressed', ui.panel ? 'true' : 'false');
    $('colorsToggle').setAttribute('aria-pressed', showColors ? 'true' : 'false');
    $('colorsToggle').disabled = !state.res;
    applyZoom(); // область просмотра изменила размер
  }

  function setPanels(patch) {
    Object.keys(patch).forEach(function (k) { ui[k] = patch[k]; });
    saveUi();
    applyUi();
    if (ui.step === 2) drawCrop();
  }

  /* Переход на этап: в панели остаются только его настройки, а справа открывается подходящий вид. */
  function setStep(n) {
    n = clamp(n | 0, 1, 5);
    if (!state.img) n = 1;
    ui.step = n;
    document.querySelectorAll('[data-step]').forEach(function (sec) { sec.hidden = +sec.dataset.step !== n; });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      const k = +b.dataset.go;
      b.disabled = k > 1 && !state.img;
      if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', k < n);
    });
    $('stepBack').hidden = n === 1;
    $('stepNext').hidden = n === 5;
    $('stepNext').disabled = !state.img;
    $('stepNext').textContent = n < 5 ? T('Далее: ') + T(STEP_NAMES[n + 1]) + ' →' : '';
    $('zip').hidden = n !== 5;
    $('panel').scrollTop = 0;
    if (n === 2) drawCrop(); // рамка рисуется по ширине видимой панели
    if (!state.res) return;
    if (n !== 4 && state.brush.on) { // рисование остаётся на этапе «Правка»
      state.brush.on = false;
      renderColorList();
    }
    if (n === 4 && !ui.colors && !isNarrow()) setPanels({ colors: true }); // здесь без списка цветов не обойтись (на телефоне он открывается кнопкой)
    const want = n === 1 ? 'original' : n === 5 ? 'layout' : paintTab() ? state.tab : 'mosaic';
    if (state.tab !== want) { state.zoom = 1; selectTab(want); } else { updateBrushBar(); showTab(); }
  }

  // ---------- подсказки по наведению ----------
  /* Пояснения из разметки (.hint, .lead) превращаются в значок «!» рядом с названием:
   * экран остаётся чистым, а текст появляется при наведении, нажатии или с клавиатуры. */
  function setupHints() {
    const tip = $('tip');
    let shown = null;
    function hide() {
      if (shown) shown.setAttribute('aria-expanded', 'false');
      shown = null;
      tip.hidden = true;
    }
    function show(btn) {
      if (shown === btn) return;
      hide();
      shown = btn;
      btn.setAttribute('aria-expanded', 'true');
      tip.textContent = btn.dataset.tip;
      tip.hidden = false;
      const r = btn.getBoundingClientRect(), w = tip.offsetWidth, hgt = tip.offsetHeight;
      let left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
      let top = r.bottom + 8;
      if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 8);
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
    }
    function make(text) {
      const b = el('button', 'info', '!');
      b.type = 'button';
      b.dataset.tip = text;
      b.setAttribute('aria-label', text);
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('mouseenter', function () { show(b); });
      b.addEventListener('mouseleave', hide);
      b.addEventListener('focus', function () { show(b); });
      b.addEventListener('blur', hide);
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (shown === b && e.detail === 0) hide(); else show(b); });
      return b;
    }
    document.querySelectorAll('.hint:not(.keep), .lead').forEach(function (p) {
      if (p.id) return; // динамические сообщения остаются текстом
      const text = p.textContent.trim();
      if (!text) return;
      const btn = make(text);
      let target = p.previousElementSibling;
      while (target && target.classList.contains('info-row')) target = target.previousElementSibling;
      const scope = p.parentElement;
      if (target && target.tagName === 'LABEL' && !target.classList.contains('check')) {
        // название поля — первый текстовый узел подписи: ставим значок сразу за ним
        const node = Array.prototype.find.call(target.childNodes, function (n) { return n.nodeType === 3 && n.nodeValue.trim(); });
        if (node) {
          const wrap = el('span', 'with-info');
          wrap.appendChild(document.createTextNode(node.nodeValue.trim()));
          wrap.appendChild(btn);
          target.replaceChild(wrap, node);
        } else target.appendChild(btn);
      } else if (target && (target.tagName === 'LABEL' || /^H[23]$/.test(target.tagName))) target.appendChild(btn);
      else {
        const head = scope.classList.contains('brushbar') ? null : scope.querySelector('h2, h3');
        if (head && !head.querySelector('.info')) head.appendChild(btn); else { p.parentElement.insertBefore(btn, p); }
      }
      p.remove();
    });
    window.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    document.addEventListener('click', function (e) { if (shown && !e.target.closest('.info')) hide(); });
  }

  // ---------- события ----------
  function init() {
    A.translateDom(document.body);
    setupHints();
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === A.lang ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (b.dataset.lang === A.lang) return;
        A.setLang(b.dataset.lang);
        // страница перезагружается на новом языке; работа перед этим сохраняется и откроется снова
        clearTimeout(saveTimer);
        Promise.resolve(autosave()).then(function () { location.reload(); }, function () { location.reload(); });
      });
    });
    $('version').textContent = VERSION;
    loadSettings();
    restorePalette();
    restoreMarks();
    loadUi();
    applyUi();
    setStep(1);
    showLogos();
    restoreLogos();
    showStockNote();
    restoreWork();
    dbGet('recent').then(showRecent, function () {});
    $('nColors').addEventListener('input', function () { wantColors = +$('nColors').value; });
    normalizeInputs();
    syncOutputs();
    state.p = params();
    updateStats();

    document.querySelectorAll('[data-kind]').forEach(function (node) {
      const full = node.dataset.kind === 'full';
      const typing = node.tagName === 'TEXTAREA' || node.type === 'number' || node.type === 'text';
      node.addEventListener('input', function () { schedule(full, typing); });
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
    $('file').addEventListener('change', function (e) { loadFiles(e.target.files); e.target.value = ''; });
    $('logoFile').addEventListener('change', function (e) { addLogoFiles(e.target.files); e.target.value = ''; });
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
      if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
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
    // два пальца: сдвиг и масштаб схемы (в том числе в режиме кисти)
    const touches = new Map();
    let pinch = null;
    function pinchState() {
      const pts = Array.from(touches.values());
      return { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
    }
    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2 && state.res) {
        if (stroke) { // первый палец успел поставить точку — убираем её, это был жест, а не мазок
          const st = stroke;
          stroke = null;
          applyChanges(st.changes);
          applyOverlays();
        }
        pinch = Object.assign(pinchState(), { zoom: state.zoom });
      }
    }, true);
    stage.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size !== 2) return;
      e.preventDefault();
      const now = pinchState();
      stage.scrollLeft -= now.cx - pinch.cx;
      stage.scrollTop -= now.cy - pinch.cy;
      if (pinch.d > 10) setZoom(pinch.zoom * (now.d / pinch.d), now.cx, now.cy);
      pinch.cx = now.cx;
      pinch.cy = now.cy;
    }, true);
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function (e) { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; }, true);
    });

    let pan = null;
    stage.addEventListener('pointerdown', function (e) {
      if (paintDown(e)) return; // в режиме кисти нажатие по схеме рисует, а не двигает её
      const sidePan = paintActive() && (e.button === 1 || e.button === 2); // в режиме кисти двигаем правой или средней кнопкой
      if ((e.button !== 0 && !sidePan) || !state.res || touches.size > 1) return; // пальцем схему тоже можно двигать
      if (!sidePan && state.zoom <= 1.01) return;
      if (sidePan) e.preventDefault();
      pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    });
    stage.addEventListener('pointermove', function (e) {
      if (pinch) { pan = null; return; }
      paintMove(e);
      if (!pan) return;
      stage.scrollLeft = pan.left - (e.clientX - pan.x);
      stage.scrollTop = pan.top - (e.clientY - pan.y);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      stage.addEventListener(ev, function () { endStroke(); pan = null; stage.classList.remove('panning'); });
    });
    stage.addEventListener('contextmenu', function (e) { if (paintActive()) e.preventDefault(); });
    stage.addEventListener('mousedown', function (e) { if (paintActive() && e.button === 1) e.preventDefault(); }); // без автопрокрутки колесом
    window.addEventListener('resize', function () { applyZoom(); drawCrop(); });

    initCropDrag();
    $('pickClose').addEventListener('click', closePicker);
    $('pickSearch').addEventListener('input', fillPicker);
    $('pickSearch').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = $('pickList').querySelector('.pick-item');
      if (first) first.click();
    });
    $('pickDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closePicker(); }); // щелчок мимо окна
    $('pickDialog').addEventListener('close', function () { pickFor = null; });

    // кисть
    $('brushToggle').addEventListener('click', toggleBrush);
    $('brushColor').addEventListener('click', openBrushPicker);
    $('brushUndo').addEventListener('click', undoStroke);
    $('brushClear').addEventListener('click', clearPaint);
    $('brushSize').addEventListener('change', function (e) { state.brush.size = clamp(+e.target.value || 1, 1, 3); });
    document.querySelectorAll('input[name=tool]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) state.brush.tool = r.value; });
    });
    $('brushRedo').addEventListener('click', redoStroke);
    $('brushHi').addEventListener('click', function () {
      const code = state.brush.code;
      if (code === null || code === A.EMPTY) return;
      if (state.highlightCode !== code) state.highlightCode = null;
      toggleHighlight(code);
    });
    $('brushUnder').addEventListener('change', function (e) { state.brush.under = e.target.checked; showTab(); });
    document.addEventListener('keydown', function (e) {
      const t = e.target;
      if ((t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || document.querySelector('dialog[open]') || e.altKey) return;
      const key = String(e.key).toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (!mod && !e.shiftKey && (key === 'q' || key === 'й')) { // подсветить цвет: в режиме кисти — цвет кисти
        if (!state.res) return;
        e.preventDefault();
        if (state.brush.on && state.brush.code !== A.EMPTY) {
          const code = state.brush.code;
          if (state.highlightCode === code) toggleHighlight(code);
          else { state.highlightCode = null; toggleHighlight(code); }
        } else if (state.highlightCode !== null) toggleHighlight(state.highlightCode);
        else setStatus(T('Чтобы подсветить цвет, нажмите на его номер в списке цветов.'));
        return;
      }
      if (!mod && !e.shiftKey && (key === 'v' || key === 'м')) { // сравнить с исходником
        if (!state.res) return;
        e.preventDefault();
        toggleOriginal();
        return;
      }
      if (!mod || !state.brush.on) return;
      const z = key === 'z' || key === 'я', y = key === 'y' || key === 'н';
      if (z && !e.shiftKey && state.undo.length) { e.preventDefault(); undoStroke(); }
      else if (((z && e.shiftKey) || (y && !e.shiftKey)) && state.redo.length) { e.preventDefault(); redoStroke(); }
    });

    // настройки, которые меняют вид без нового подбора цветов
    $('autoLight').addEventListener('change', function () { saveSettings(); applyOverlays(); });
    $('withPdf').addEventListener('change', saveSettings);
    $('withJpg').addEventListener('change', saveSettings);
    $('jpgSave').addEventListener('click', saveJpg);
    // кнопка JPEG доступна тогда же, когда и скачивание комплекта
    new MutationObserver(function () { $('jpgSave').disabled = $('zip').disabled; }).observe($('zip'), { attributes: true, attributeFilter: ['disabled'] });
    $('withLabels').addEventListener('change', saveSettings);
    $('withDocx').addEventListener('change', saveSettings);
    $('symSize').addEventListener('change', function () {
      saveSettings();
      applySymbolSize();
      dropCache(['scheme', 'layout']);
      showTab();
      touch();
    });
    $('stock').addEventListener('input', showStockNote);

    // этапы и панели
    document.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { setStep(+b.dataset.go); });
    });
    $('stepBack').addEventListener('click', function () { setStep(ui.step - 1); });
    $('stepNext').addEventListener('click', function () { setStep(ui.step + 1); });
    $('stepBrush').addEventListener('click', toggleBrush);
    $('panelToggle').addEventListener('click', function () { setPanels({ panel: !ui.panel }); });
    $('colorsToggle').addEventListener('click', function () { setPanels({ colors: !ui.colors }); });
    $('colorsClose').addEventListener('click', function () { setPanels({ colors: false }); });

    // подготовка картинки, чистый холст, зоны без страз
    $('rotL').addEventListener('click', function () { transformImage({ rot: -90 }); });
    $('rotR').addEventListener('click', function () { transformImage({ rot: 90 }); });
    $('flipH').addEventListener('click', function () { transformImage({ flipX: true }); });
    $('flipV').addEventListener('click', function () { transformImage({ flipY: true }); });
    $('tone').addEventListener('change', function (e) { transformImage({ tone: e.target.value }); });
    $('blankStart').addEventListener('click', startBlank);
    $('brushEmpty').addEventListener('click', function () {
      state.brush.code = state.brush.code === A.EMPTY ? defaultBrushCode() : A.EMPTY;
      if (state.brush.tool === 'erase' || state.brush.tool === 'pipette') state.brush.tool = 'brush';
      renderColorList();
      updateBrushBar();
    });

    // проект
    $('projSave').addEventListener('click', saveProject);
    $('projOpen').addEventListener('click', function () { $('projFile').click(); });
    $('projFile').addEventListener('change', function (e) { openProjectFile(e.target.files[0]); e.target.value = ''; });

    // значок и цвет клетки
    $('symClose').addEventListener('click', closeSymbols);
    $('symDone').addEventListener('click', closeSymbols);
    $('symReset').addEventListener('click', function () { if (symFor !== null) setSymbol(symFor, null); });
    $('printCustom').addEventListener('change', function (e) { if (symFor !== null) setPrint(symFor, e.target.value); });
    $('symDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeSymbols(); });
    $('symDialog').addEventListener('close', function () { symFor = null; });
    $('zip').addEventListener('click', saveZip);
    $('saveOne').addEventListener('click', saveOne);
  }

  A.app = {
    state: state, buildFiles: buildFiles, params: params, flush: flush, selectTab: selectTab,
    loadUrl: function (url, name) { return loadImage(url, name, false); },
    loadPaletteText: loadPaletteText, resetPalette: resetPalette,
    toggleHighlight: toggleHighlight, excludeColor: excludeColor,
    replaceColor: replaceColor, undoReplace: undoReplace, openPicker: openPicker,
    toggleBrush: toggleBrush, setBrushCode: setBrushCode, undoStroke: undoStroke, clearPaint: clearPaint,
    setSymbol: setSymbol, setPrint: setPrint, openSymbols: openSymbols, addLogoFiles: addLogoFiles,
    redoStroke: redoStroke, runBatch: runBatch, saveProject: saveProject, openProjectFile: openProjectFile,
    setStep: setStep, setPanels: setPanels, ui: ui, transformImage: transformImage, startBlank: startBlank,
    projectData: projectData, autosave: autosave, restoreWork: restoreWork, toggleOriginal: toggleOriginal, exportKinds: exportKinds
  };
  init();
})(window.ALMAZ = window.ALMAZ || {});
