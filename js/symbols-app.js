/* Раздел «Готовые макеты»: загрузить готовый макет JPEG или PNG, заменить рисунки значков, сохранить в том же формате.
 * Цвета, количество и расположение клеток не меняются; блоки файла без изменений остаются байт в байт. */
(function (A) {
  'use strict';

  const T = A.T, J = A.jpegEdit, P = A.pngEdit, S = A.layoutScan;
  const VERSION = T('версия') + ' 31 · 17.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  // больше браузер не удержит вместе со всеми расчётами; на телефоне и планшете памяти меньше
  const PHONE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const MAX_PIXELS = PHONE ? 60e6 : 120e6;
  const PREVIEW_SIDE = 3200;
  const state = {
    bytes: null, name: '', scan: null, preview: null, base: null, k: 1, edits: new Map(), sel: -1, zoom: 1, busy: false,
    order: [], crops: [], rev: 0, saved: true, png: false
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), use = document.createElementNS(NS, 'use');
    svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-' + name); svg.appendChild(use);
    return svg;
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function setStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', kind === 'error');
    s.classList.toggle('ok', kind === 'ok');
  }

  // ---------- цвет для экрана ----------
  /* Значения составляющих → примерный RGB для показа. Для CMYK — простое приближение (в файле профиль не задан). */
  function toRgb(dec, v) {
    const n = v.length, inv = dec.adobe;
    if (n === 1) return [v[0], v[0], v[0]];
    if (n === 4) {
      let c = v[0], m = v[1], y = v[2];
      if (dec.adobe && dec.adobe.transform === 2) { const r = ycc(v[0], v[1], v[2]); c = r[0]; m = r[1]; y = r[2]; }
      const k = v[3];
      return [(c * k) / 255, (m * k) / 255, (y * k) / 255]; // Adobe хранит краски перевёрнутыми
    }
    if (inv && inv.transform === 0) return [v[0], v[1], v[2]];
    return ycc(v[0], v[1], v[2]);
  }
  function ycc(y, cb, cr) {
    return [clamp(y + 1.402 * (cr - 128), 0, 255), clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128), 0, 255), clamp(y + 1.772 * (cb - 128), 0, 255)];
  }

  function buildPreview(dec) {
    const f = dec.frame, k = Math.min(1, PREVIEW_SIDE / Math.max(f.width, f.height));
    const w = Math.max(1, Math.round(f.width * k)), h = Math.max(1, Math.round(f.height * k));
    const cv = A.makeCanvas(w, h), x = cv.getContext('2d'), im = x.createImageData(w, h), d = im.data;
    const cs = f.comps, v = new Array(cs.length);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(f.height - 1, Math.floor(y / k));
      for (let xx = 0; xx < w; xx++) {
        const fx = Math.min(f.width - 1, Math.floor(xx / k));
        for (let i = 0; i < cs.length; i++) {
          const c = cs[i];
          v[i] = c.plane[Math.floor((fy * c.v) / f.vmax) * c.pw + Math.floor((fx * c.h) / f.hmax)];
        }
        const rgb = toRgb(dec, v), o = (y * w + xx) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    x.putImageData(im, 0, 0);
    return { canvas: cv, k: k, data: im };
  }

  // ---------- рисунок значка ----------
  const maskFor = A.symbolPicker.maskFor; // рисунок значка — общий с разделом «Макет из схемы»

  /* Нарисовать новые значки на картинке для экрана (те же правила, что и в файле). */
  function repaintPreview() {
    const p = state.preview, sc = state.scan, x = p.canvas.getContext('2d');
    x.putImageData(p.data, 0, 0);
    if (state.edits.size) paintEdits(x, p, sc);
    // контрастная сетка — те же отрезки, что и в файле, в масштабе просмотра
    if ($('gridContrast').checked) {
      const k = p.k;
      S.gridSegments(sc).forEach(function (s) {
        x.fillStyle = s.white ? '#ffffff' : '#000000';
        x.fillRect(s.x0 * k, s.y0 * k, Math.max(1, (s.x1 - s.x0 + 1) * k), Math.max(1, (s.y1 - s.y0 + 1) * k));
      });
    }
    drawSelection();
  }

  function paintEdits(x, p, sc) {
    const im = x.getImageData(0, 0, p.canvas.width, p.canvas.height), d = im.data, W = p.canvas.width, k = p.k;
    const size = +$('size').value / 100, grid = sc.grid, nb = sc.dec.frame.comps.length, cache = new Map();
    const paint = function (box, bgRgb, inkRgb, sym, frac) {
      const x0 = Math.round(box.x0 * k), y0 = Math.round(box.y0 * k), x1 = Math.round((box.x1 + 1) * k) - 1, y1 = Math.round((box.y1 + 1) * k) - 1;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w < 2 || h < 2) return;
      const key = w + 'x' + h + sym + frac.toFixed(3);
      let m = cache.get(key);
      if (!m) { m = maskFor(w, h, sym, frac); cache.set(key, m); }
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const a = m[yy * w + xx], o = ((y0 + yy) * W + x0 + xx) * 4;
        d[o] = bgRgb[0] + a * (inkRgb[0] - bgRgb[0]); d[o + 1] = bgRgb[1] + a * (inkRgb[1] - bgRgb[1]); d[o + 2] = bgRgb[2] + a * (inkRgb[2] - bgRgb[2]);
      }
    };
    state.edits.forEach(function (sym, cls) {
      const c = sc.classes[cls], ink = toRgb(sc.dec, c.ink);
      for (let i = 0; i < sc.cells.length; i++) {
        if (sc.cells[i] !== cls) continue;
        const box = S.cellBox(grid, i % grid.cols, Math.floor(i / grid.cols)), bg = [];
        for (let j = 0; j < nb; j++) bg.push(sc.cellBg[i * nb + j]);
        const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
        paint(box, toRgb(sc.dec, bg), ink, sym, Math.min(grid.pitch * size, Math.min(bw, bh) - 2) / Math.max(bw, bh)); // как в файле: не шире клетки
      }
      if ($('inLegend').checked && c.legend >= 0) {
        const r = sc.legend.rows[c.legend], lf = sc.legendFeats[c.legend], inset = Math.max(2, Math.round((r.x1 - r.x0) * 0.14));
        const box = { x0: r.x0 + inset, y0: r.y0 + inset, x1: r.x1 - inset, y1: r.y1 - inset };
        const lw = box.x1 - box.x0 + 1, lh = box.y1 - box.y0 + 1;
        paint(box, toRgb(sc.dec, lf.bg), toRgb(sc.dec, lf.ink), sym, Math.min((r.x1 - r.x0 + 1) * size, Math.min(lw, lh) - 2) / Math.max(lw, lh));
      }
    });
    x.putImageData(im, 0, 0);
  }

  /* Подсветка клеток выбранного значка — отдельным слоем поверх макета. */
  function drawSelection() {
    const ov = state.overlay;
    if (!ov) return;
    const x = ov.getContext('2d');
    x.clearRect(0, 0, ov.width, ov.height);
    if (state.sel < 0) return;
    const sc = state.scan, grid = sc.grid, k = state.preview.k;
    x.fillStyle = 'rgba(10,14,24,0.55)';
    x.fillRect(Math.floor(grid.xs[0] * k), Math.floor(grid.ys[0] * k), Math.ceil((grid.xs[grid.cols] - grid.xs[0]) * k), Math.ceil((grid.ys[grid.rows] - grid.ys[0]) * k));
    for (let i = 0; i < sc.cells.length; i++) {
      if (sc.cells[i] !== state.sel) continue;
      const cx = i % grid.cols, cy = Math.floor(i / grid.cols);
      x.clearRect(Math.floor(grid.xs[cx] * k), Math.floor(grid.ys[cy] * k), Math.ceil(grid.pitch * k) + 1, Math.ceil(grid.pitch * k) + 1);
    }
    const c = sc.classes[state.sel];
    if (c.legend >= 0) {
      const r = sc.legend.rows[c.legend];
      x.strokeStyle = '#ff3d7f';
      x.lineWidth = Math.max(2, 4 * k);
      x.strokeRect((r.x0 - 6) * k, (r.y0 - 6) * k, (r.x1 - r.x0 + 12) * k, (r.y1 - r.y0 + 12) * k);
    }
  }

  // ---------- список значков ----------
  function cropOf(box, pad) {
    const p = state.preview, k = p.k, sx = Math.max(0, Math.floor((box.x0 - pad) * k)), sy = Math.max(0, Math.floor((box.y0 - pad) * k));
    const sw = Math.min(p.canvas.width - sx, Math.ceil((box.x1 - box.x0 + 2 * pad) * k)), sh = Math.min(p.canvas.height - sy, Math.ceil((box.y1 - box.y0 + 2 * pad) * k));
    const H = 34, W = Math.max(1, Math.round((sw * H) / sh)), cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(p.canvas, sx, sy, sw, sh, 0, 0, W, H);
    const img = new Image();
    img.src = cv.toDataURL('image/png');
    img.alt = '';
    cv.width = cv.height = 0;
    return img;
  }

  function buildCrops() {
    // картинка-подпись для каждого значка: строка легенды (квадратик и номер) или пример клетки
    const p = state.preview, x = p.canvas.getContext('2d');
    x.putImageData(p.data, 0, 0);
    const sc = state.scan, grid = sc.grid;
    state.crops = sc.classes.map(function (c) {
      if (c.legend >= 0) {
        const r = sc.legend.rows[c.legend], h = r.y1 - r.y0;
        return cropOf({ x0: r.x0, y0: r.y0, x1: Math.min(r.rowX1, r.x0 + h * 4.2), y1: r.y1 }, 2);
      }
      const i = c.sample, cx = i % grid.cols, cy = Math.floor(i / grid.cols);
      return cropOf({ x0: grid.xs[cx], y0: grid.ys[cy], x1: grid.xs[cx + 1], y1: grid.ys[cy + 1] }, 0);
    });
  }

  function renderRows() {
    const list = $('symRows');
    list.textContent = '';
    state.order.forEach(function (k) {
      const c = state.scan.classes[k], li = el('li'), row = el('button', 'sym-row');
      row.type = 'button';
      row.setAttribute('aria-pressed', state.sel === k ? 'true' : 'false');
      const th = el('span', 'row-thumb');
      th.appendChild(state.crops[k].cloneNode());
      row.appendChild(th);
      const info = el('span', 'row-info');
      info.appendChild(el('b', '', fmt(c.count) + ' ' + T('клеток')));
      if (c.legend < 0) info.appendChild(el('small', 'warn-text', T('нет в легенде')));
      row.appendChild(info);
      const sym = state.edits.get(k), target = el('span', 'row-target' + (sym ? ' set' : ''), sym ? '→ ' + sym.replace(/︎/g, '') : '→ …');
      row.appendChild(target);
      row.addEventListener('click', function () { select(k); A.symbolPicker.open(k); });
      li.appendChild(row);
      if (sym) {
        const x = el('button', 'color-x');
        x.type = 'button';
        x.title = T('Вернуть, как было');
        x.setAttribute('aria-label', x.title);
        x.appendChild(icon('x'));
        x.addEventListener('click', function () { state.edits.delete(k); afterEdit(); });
        li.appendChild(x);
      }
      list.appendChild(li);
    });
    $('save').disabled = !(state.edits.size || $('gridContrast').checked) || state.busy;
    $('resetAll').hidden = !state.edits.size;
  }

  function select(k) {
    state.sel = state.sel === k ? -1 : k;
    renderRows();
    drawSelection();
  }

  function changed() { state.rev++; state.saved = false; }

  function afterEdit() {
    changed();
    renderRows();
    repaintPreview();
    const n = state.edits.size;
    setStatus(n ? T('Заменено значков: ') + n + T('. Сохраните файл, когда всё готово.') : T('Выберите значок слева, чтобы заменить его.'));
  }

  // ---------- загрузка ----------
  async function load(file) {
    if (!file) return;
    if (state.busy) { setStatus(T('Подождите: предыдущий макет ещё обрабатывается.')); return; }
    if (!/\.(jpe?g|png)$/i.test(file.name) && file.type !== 'image/jpeg' && file.type !== 'image/png') { setStatus(T('Нужен макет в формате JPG или PNG.'), 'error'); return; }
    state.busy = true;
    $('save').disabled = true;
    setStatus(T('Читаю макет…'));
    await wait(30);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()), png = P.isPng(bytes);
      // PNG читаем сразу в точки; JPEG — до коэффициентов, потом в точки
      const dec = png ? await P.decode(bytes, { maxPixels: MAX_PIXELS, onStep: function () { return wait(0); } }) : J.decode(bytes, { maxPixels: MAX_PIXELS }), f = dec.frame;
      if (!png) await J.toPlanes(dec, function () { return wait(0); }, true);
      setStatus(T('Ищу сетку и легенду…'));
      await wait(20);
      const g = S.grayPlane(dec), grid = S.findGrid(g, f.width, f.height);
      // клетка меньше 8 точек или сетка не нашлась — это не макет для печати (фото, картинка)
      if (grid.cols < 4 || grid.rows < 4 || !(grid.pitch >= 8)) throw Object.assign(new Error('grid'), { code: 'grid' });
      let legend = S.findLegend(g, f.width, f.height, grid);
      if (!legend && A.schemeImport) { // схема прямо из программы: легенда строками справа, без белой плашки
        const rows = A.schemeImport.findLegend(g, f.width, f.height, grid);
        if (rows.length >= 2) legend = { box: null, rows: rows.map(function (r) { return { x0: r.sq.x0, y0: r.sq.y0, x1: r.sq.x1, y1: r.sq.y1, rowX1: r.code.x1 }; }) };
      }
      setStatus(T('Раскладываю клетки по значкам…'));
      await wait(20);
      const cl = await S.classify(dec, g, f.width, grid, legend, function () { return wait(0); });
      const preview = buildPreview(dec);
      // дальше нужны только найденные клетки; сам файл перечитаем при сохранении
      f.comps.forEach(function (c) { c.plane = null; c.coefs = null; });
      dec.alpha = null;
      state.bytes = bytes; state.name = file.name; state.png = png;
      state.scan = Object.assign({ grid: grid, legend: legend, dec: { frame: f, adobe: dec.adobe } }, cl);
      state.preview = preview;
      state.edits = new Map();
      state.saved = true;
      state.sel = -1;
      // порядок: как в легенде, затем значки, которых в легенде нет
      state.order = cl.classes.map(function (c, k) { return k; }).sort(function (a, b) {
        const la = cl.classes[a].legend, lb = cl.classes[b].legend;
        return (la < 0 ? 1e6 + a : la) - (lb < 0 ? 1e6 + b : lb);
      });
      buildCrops();
      showLayout();
      const missing = cl.classes.filter(function (c) { return c.legend < 0; }).length;
      const mode = (png ? 'PNG · ' : 'JPG · ') + (f.comps.length === 4 ? 'CMYK' : f.comps.length === 3 ? 'RGB' : T('оттенки серого'));
      $('fileInfo').hidden = false;
      $('fileInfo').textContent = fmt(f.width) + ' × ' + fmt(f.height) + ' ' + T('точек') + ' · ' + mode + ' · ' + grid.cols + ' × ' + grid.rows + ' ' + T('клеток') + ' · ' + cl.classes.length + ' ' + T('значков');
      $('dropTitle').textContent = file.name;
      $('dropHint').textContent = T('нажмите, чтобы открыть другой макет');
      $('symbolsStep').hidden = false;
      renderRows();
      setStatus(!legend ? T('Легенда не найдена — значки заменятся только в схеме.') :
        missing ? T('Значков без строки в легенде: ') + missing + T('. Они в конце списка — замените их, если нужно.') :
          cl.doubtful ? T('Найдено значков: ') + cl.classes.length + T('. Есть клетки, похожие сразу на два значка: ') + cl.doubtful + T('. Проверьте подсветкой.') :
            T('Найдено значков: ') + cl.classes.length + T('. Выберите, какой заменить.'), legend ? '' : 'error');
    } catch (e) {
      console.error(e);
      const msg = {
        progressive: T('Этот JPG сохранён как «прогрессивный» — такие пока не поддерживаются. Пересохраните его как обычный JPG.'),
        big: T('Макет слишком большой для браузера.'),
        grid: T('Не удалось найти сетку схемы. Это точно готовый макет для печати?'),
        notjpeg: T('Это не JPG и не PNG.'),
        notpng: T('Это не JPG и не PNG.'),
        unsupported: T('Этот вид JPG не поддерживается. Пересохраните макет как обычный JPG.'),
        bits: T('Этот вид JPG не поддерживается. Пересохраните макет как обычный JPG.'),
        broken: T('Файл повреждён или скачан не полностью. Скачайте макет заново.')
      }[e.code] || T('Не удалось прочитать макет.');
      setStatus(msg, 'error');
    }
    state.busy = false;
    renderRowsSafe();
  }
  function renderRowsSafe() { if (state.scan) renderRows(); }

  function showLayout() {
    const holder = $('holder'), p = state.preview;
    holder.textContent = '';
    p.canvas.className = '';
    const ov = A.makeCanvas(p.canvas.width, p.canvas.height);
    ov.className = 'overlay';
    state.overlay = ov;
    holder.appendChild(p.canvas);
    holder.appendChild(ov);
    holder.hidden = false;
    $('empty').hidden = true;
    state.zoom = 1;
    applyZoom();
    repaintPreview(); // контрастная сетка, если включена
  }

  // ---------- сохранение ----------
  async function save() {
    const contrast = $('gridContrast').checked;
    if (!state.bytes || !(state.edits.size || contrast) || state.busy) return;
    state.busy = true;
    $('save').disabled = true;
    setStatus(T('Меняю значки в файле…'));
    await wait(30);
    const rev = state.rev; // правки берём сейчас; если поменяют во время сохранения, файл уже не последний
    const edits = [], opt = { size: +$('size').value / 100, legend: $('inLegend').checked };
    state.edits.forEach(function (sym, k) { edits.push({ k: k, symbol: sym }); });
    try {
      const sc = state.scan, png = state.png, step = function () { return wait(0); };
      const dec = png ? await P.decode(state.bytes, { onStep: step }) : J.decode(state.bytes);
      const scan = { grid: sc.grid, legend: sc.legend, classes: sc.classes, cells: sc.cells, cellBg: sc.cellBg, legendFeats: sc.legendFeats };
      if (contrast) S.recolorGrid(dec, scan); // сетка: чёрная на светлых клетках, белая на тёмных
      const r = edits.length ? S.applyEdits(dec, scan, edits, maskFor, opt) : { cells: 0 };
      await wait(20);
      const parts = png ? await P.encode(dec, state.bytes, step) : J.encode(dec);
      const url = URL.createObjectURL(new Blob(parts, { type: png ? 'image/png' : 'image/jpeg' }));
      const a = document.createElement('a');
      a.href = url; a.download = state.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      state.saved = state.rev === rev;
      setStatus(T('Сохранено: ') + state.name + (contrast ? T('. Сетка перекрашена') + (r.cells ? T(', перерисовано клеток: ') + fmt(r.cells) : '') + T('; цвета и значки клеток не менялись.') : T('. Перерисовано клеток: ') + fmt(r.cells) + T(', остальной файл не изменился.')), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти.'), 'error');
    }
    state.busy = false;
    renderRows();
  }

  // ---------- просмотр ----------
  function applyZoom() {
    const cv = $('holder').firstChild, stage = $('stage');
    if (!cv) return;
    const fit = Math.max(0.02, Math.min((stage.clientWidth - 40) / cv.width, (stage.clientHeight - 40) / cv.height)), s = fit * state.zoom;
    Array.prototype.forEach.call($('holder').children, function (n) {
      n.style.width = Math.round(cv.width * s) + 'px';
      n.style.height = Math.round(cv.height * s) + 'px';
    });
    $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
  }

  function setZoom(z, cx, cy) {
    const cv = $('holder').firstChild, stage = $('stage');
    if (!cv) return;
    z = clamp(z, 0.5, 24);
    const sr = stage.getBoundingClientRect(), px = cx === undefined ? sr.left + sr.width / 2 : cx, py = cy === undefined ? sr.top + sr.height / 2 : cy;
    const r0 = cv.getBoundingClientRect(), fx = (px - r0.left) / r0.width, fy = (py - r0.top) / r0.height;
    state.zoom = z;
    applyZoom();
    const r1 = cv.getBoundingClientRect();
    stage.scrollLeft += r1.left + fx * r1.width - px;
    stage.scrollTop += r1.top + fy * r1.height - py;
  }

  function cellAt(e) {
    const cv = $('holder').firstChild, sc = state.scan;
    if (!cv || !sc) return -1;
    const r = cv.getBoundingClientRect(), k = state.preview.k;
    const x = ((e.clientX - r.left) / r.width) * cv.width / k, y = ((e.clientY - r.top) / r.height) * cv.height / k, g = sc.grid;
    if (x < g.xs[0] || y < g.ys[0] || x >= g.xs[g.cols] || y >= g.ys[g.rows]) {
      // нажали на строку легенды?
      if (sc.legend) {
        const j = sc.legend.rows.findIndex(function (rr) { return y >= rr.y0 - 6 && y <= rr.y1 + 6 && x >= rr.x0 - 6 && x <= rr.rowX1; });
        if (j >= 0) return sc.classes.findIndex(function (c) { return c.legend === j; });
      }
      return -1;
    }
    const cx = Math.min(g.cols - 1, Math.floor((x - g.xs[0]) / g.pitch)), cy = Math.min(g.rows - 1, Math.floor((y - g.ys[0]) / g.pitch));
    return sc.cells[cy * g.cols + cx];
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
      const text = p.textContent.trim(), b = el('button', 'info', '!');
      b.type = 'button';
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
          const wrap = el('span', 'with-info');
          wrap.appendChild(document.createTextNode(node.nodeValue.trim()));
          wrap.appendChild(b);
          target.replaceChild(wrap, node);
        } else target.appendChild(b);
      } else if (target && /^H[23]$/.test(target.tagName)) target.appendChild(b);
      else p.parentElement.insertBefore(b, p);
      p.remove();
    });
    window.addEventListener('scroll', hide, true);
    document.addEventListener('click', function (e) { if (shown && !e.target.closest('.info')) hide(); });
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
    ['drop', 'emptyPick'].forEach(function (id) { $(id).addEventListener('click', function () { $('file').click(); }); });
    $('file').addEventListener('change', function (e) { load(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) load(e.dataTransfer.files[0]); });
    // ползунок шлёт десятки событий в секунду — перерисовываем не чаще кадра экрана
    let repaintQueued = false;
    function queueRepaint() {
      if (!state.scan) return;
      if (state.edits.size) changed();
      if (repaintQueued) return;
      repaintQueued = true;
      requestAnimationFrame(function () { repaintQueued = false; if (state.scan) repaintPreview(); });
    }
    $('size').addEventListener('input', function () { $('sizeOut').textContent = $('size').value + '%'; queueRepaint(); });
    $('inLegend').addEventListener('change', queueRepaint);
    $('gridContrast').addEventListener('change', function () { if (!state.scan) return; changed(); renderRows(); queueRepaint(); });
    $('resetAll').addEventListener('click', function () { state.edits.clear(); afterEdit(); });
    $('save').addEventListener('click', save);
    A.symbolPicker.init(function () { return { scan: state.scan, edits: state.edits, crops: state.crops, size: +$('size').value / 100 }; },
      function (k, sym) { if (sym) state.edits.set(k, sym); else state.edits.delete(k); afterEdit(); });
    $('panelToggle').addEventListener('click', function () {
      const hidden = document.body.classList.toggle('hide-panel');
      $('panelToggle').setAttribute('aria-pressed', hidden ? 'false' : 'true');
      applyZoom();
    });
    $('zoomIn').addEventListener('click', function () { setZoom(state.zoom * 1.5); });
    $('zoomOut').addEventListener('click', function () { setZoom(state.zoom / 1.5); });
    $('zoomFit').addEventListener('click', function () { state.zoom = 1; applyZoom(); });
    const stage = $('stage');
    stage.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !state.scan) return;
      e.preventDefault();
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    // перетаскивание двигает макет, короткое нажатие на клетку выбирает её значок
    let drag = null;
    stage.addEventListener('pointerdown', function (e) {
      if (!state.scan || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop, moved: false };
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 5) drag.moved = true;
      if (drag.moved) { stage.scrollLeft = drag.l - (e.clientX - drag.x); stage.scrollTop = drag.t - (e.clientY - drag.y); }
    });
    stage.addEventListener('pointerup', function (e) {
      if (drag && !drag.moved) {
        const k = cellAt(e);
        if (k >= 0) { state.sel = -1; select(k); const li = $('symRows').children[state.order.indexOf(k)]; if (li) li.scrollIntoView({ block: 'nearest' }); }
      }
      drag = null;
    });
    stage.addEventListener('pointercancel', function () { drag = null; });
    window.addEventListener('resize', applyZoom);
    window.addEventListener('beforeunload', function (e) { if (state.edits.size && !state.saved) { e.preventDefault(); e.returnValue = ''; } });
  }

  A.symbolsApp = { state: state, load: load, save: save, maskFor: maskFor, setEdit: function (k, s) { state.edits.set(k, s); afterEdit(); }, select: select };
  init();
})(window.ALMAZ = window.ALMAZ || {});
