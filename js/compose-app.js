/* Раздел «Макет из схемы»: схема из программы «Алмазная мозаика 2.0» («Схема для печати.png»)
 * → лист для типографии по нашему шаблону (как делает раздел «Алмазная схема»): размытая картинка
 * фоном, шапка, легенда DMC, QR-коды и логотип. Схема и строки легенды переносятся картинкой
 * точка в точку; сохраняется JPEG в CMYK, 300 dpi, имя — артикул. */
(function (A) {
  'use strict';

  const T = A.T, P = A.pngEdit, S = A.layoutScan, SI = A.schemeImport, OCR = A.schemeOcr;
  const ASSET_VERSION = 31; // тот же номер, что в адресах скриптов в compose.html
  const VERSION = T('версия') + ' 31 · 17.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  const MAX_PIXELS = 120e6, MAX_LOGOS = 4, LOGO_SIDE = 800, JPEG_MAX_PIXELS = 170e6;
  const PREVIEW_SIDE = 2400;
  const state = { scheme: null, photo: null, photoName: '', logos: [], busy: false, zoom: 1, preview: null, timer: null, edits: new Map(), crops: [], order: [],
    tab: 'sheet', sel: -1, insert: null, overlay: null };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function release(cv) { if (cv && cv.getContext) cv.width = cv.height = 0; }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), use = document.createElementNS(NS, 'use');
    svg.setAttribute('class', 'ic'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#i-' + name); svg.appendChild(use);
    return svg;
  }
  function setStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', kind === 'error');
    s.classList.toggle('ok', kind === 'ok');
  }

  // ---------- общие с «Алмазной схемой» настройки: сайты и картинки внизу макета ----------
  function readSettings() {
    try { const o = JSON.parse(localStorage.getItem('almaz-settings') || 'null'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }
  function saveUrls() {
    try { const o = readSettings(); o.urls = $('urls').value; localStorage.setItem('almaz-settings', JSON.stringify(o)); } catch (e) { /* не запомнится */ }
  }
  function urls() { return $('urls').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3); }

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
    saved = saved.filter(function (o) { return o && typeof o.data === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(o.data); }).slice(0, MAX_LOGOS);
    return Promise.all(saved.map(loadLogoData)).then(function (items) {
      state.logos = items.filter(Boolean);
      showLogos();
    });
  }
  function storeLogos() {
    try { localStorage.setItem('almaz-logos', JSON.stringify(state.logos.map(function (l) { return { name: l.name, data: l.data }; }))); }
    catch (e) { setStatus(T('Картинки стоят на макете, но запомнить их для следующего раза не удалось: в браузере мало места.')); }
  }
  function readLogo(file) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        let item = null;
        try {
          const iw = img.naturalWidth, ih = img.naturalHeight;
          if (iw > 0 && ih > 0 && iw * ih <= MAX_PIXELS) {
            const k = Math.min(1, LOGO_SIDE / Math.max(iw, ih));
            const cv = A.makeCanvas(Math.max(1, Math.round(iw * k)), Math.max(1, Math.round(ih * k))), x = cv.getContext('2d');
            x.imageSmoothingEnabled = k < 1; // мелкие QR-коды не размываем
            x.imageSmoothingQuality = 'high';
            x.drawImage(img, 0, 0, cv.width, cv.height);
            item = { img: cv, name: String(file.name || T('картинка')).slice(0, 60), data: cv.toDataURL('image/png') };
          }
        } catch (e) { item = null; }
        URL.revokeObjectURL(url);
        resolve(item);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  function showLogos() {
    const n = state.logos.length, list = $('logoList');
    list.textContent = '';
    list.hidden = n === 0;
    state.logos.forEach(function (l, i) {
      const item = el('div', 'logo-item'), im = el('img'), x = el('button', 'color-x', '×');
      im.src = l.data; im.alt = l.name; im.title = l.name;
      x.type = 'button';
      x.title = T('Убрать картинку «') + l.name + '»';
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', function () { state.logos.splice(i, 1); showLogos(); storeLogos(); schedule(); });
      item.appendChild(im);
      item.appendChild(x);
      list.appendChild(item);
    });
    $('logoHint').textContent = n ? T('Стоят внизу макета в ряд, в этом порядке. Сохранены для следующих макетов.')
      : T('До четырёх картинок — встанут в ряд внизу макета. Запоминаются для следующих макетов.');
    $('logoPick').textContent = n ? T('Добавить ещё') : T('Добавить картинки');
    $('logoPick').disabled = n >= MAX_LOGOS;
  }

  // ---------- файлы ----------
  const SCHEME_NAME = /схем|scheme|schema/i, PHOTO_NAME = /исходн|вихідн|оригин|оригін|source|original/i, SKIP_NAME = /легенд|legend|вид вышив|вигляд|вид мозаик/i;

  async function loadFiles(list) {
    const files = Array.prototype.filter.call(list || [], function (f) { return /\.(png|jpe?g)$/i.test(f.name) || /^image\/(png|jpeg)$/.test(f.type); });
    if (!files.length) { setStatus(T('Нужны файлы PNG или JPG из папки программы.'), 'error'); return; }
    if (state.busy) { setStatus(T('Подождите: предыдущие файлы ещё обрабатываются.')); return; }
    // какой файл схема, какой — картинка
    let scheme = files.filter(function (f) { return SCHEME_NAME.test(f.name) && !SKIP_NAME.test(f.name); })[0] || null;
    let photo = files.filter(function (f) { return f !== scheme && PHOTO_NAME.test(f.name); })[0] || null;
    const rest = files.filter(function (f) { return f !== scheme && f !== photo && !SKIP_NAME.test(f.name); });
    if (!scheme && rest.length) {
      // без подходящего имени: самый большой PNG — схема (если схема ещё не открыта или PNG один)
      const pngs = rest.filter(function (f) { return /\.png$/i.test(f.name) || f.type === 'image/png'; }).sort(function (a, b) { return b.size - a.size; });
      if (pngs.length && (!state.scheme || files.length > 1)) scheme = pngs[0];
    }
    if (!photo) photo = rest.filter(function (f) { return f !== scheme; })[0] || null;
    if (!scheme && !photo) { setStatus(T('Среди файлов нет схемы: нужен «Схема для печати.png» из программы.'), 'error'); return; }
    state.busy = true;
    $('save').disabled = true;
    try {
      if (scheme) await openScheme(scheme);
      if (photo) await openPhoto(photo);
      if (!state.scheme) { setStatus(T('Картинку взяли. Теперь добавьте схему из программы: «Схема для печати.png».')); return; }
      $('metaStep').hidden = false;
      render();
      setStatus(T('Готово: проверьте лист справа, впишите артикул и название и сохраните JPEG для типографии.') +
        (state.photo ? '' : ' ' + T('Без исходной картинки фон и миниатюра собраны из самой схемы — добавьте «Исходное изображение.jpg», будет красивее.')));
    } catch (e) {
      console.error(e);
      const msg = {
        grid: T('Не удалось найти сетку схемы. Нужен файл «Схема для печати.png» из программы.'),
        legend: T('Сетку нашли, а строки легенды справа от схемы — нет. Нужен файл «Схема для печати.png» из программы, где легенда стоит рядом со схемой.'),
        big: T('Файл слишком большой для браузера.'),
        broken: T('Файл повреждён или скачан не полностью. Скачайте его заново.')
      }[e.code] || T('Не удалось прочитать файл.');
      setStatus(msg, 'error');
    } finally {
      state.busy = false;
      $('save').disabled = !state.scheme;
    }
  }

  async function bitmapOf(file) {
    try { return await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
    catch (e) { const err = new Error('broken'); err.code = 'broken'; throw err; }
  }

  async function openScheme(file) {
    setStatus(T('Ищу сетку и легенду в схеме…'));
    await wait(30);
    const bmp = await bitmapOf(file);
    try {
      if (bmp.width * bmp.height > MAX_PIXELS) throw Object.assign(new Error('big'), { code: 'big' });
      const dec = await P.fromBitmap(bmp, { onStep: function () { return wait(0); } });
      const f = dec.frame, g = S.grayPlane(dec), grid = S.findGrid(g, f.width, f.height);
      if (grid.cols < 4 || grid.rows < 4 || !(grid.pitch >= 8)) throw Object.assign(new Error('grid'), { code: 'grid' });
      const rows = SI.findLegend(g, f.width, f.height, grid);
      if (rows.length < 2) throw Object.assign(new Error('legend'), { code: 'legend' });
      // позначки по клеткам — для замены значков (общий разбор с разделом «Готовые макеты»)
      setStatus(T('Раскладываю клетки по значкам…'));
      await wait(20);
      const legendObj = { box: null, rows: rows.map(function (r) { return { x0: r.sq.x0, y0: r.sq.y0, x1: r.sq.x1, y1: r.sq.y1, rowX1: r.code.x1 }; }) };
      const cl = await S.classify(dec, g, f.width, grid, legendObj, function () { return wait(0); });
      // dpi файла (по умолчанию 300) — чтобы узнать шаг клетки в миллиметрах
      let dpi = 300;
      if (/\.png$/i.test(file.name) || file.type === 'image/png') dpi = P.dpiOf(new Uint8Array(await file.slice(0, 4096).arrayBuffer())) || 300;
      const pitchMm = (grid.pitch / dpi) * 25.4;
      // схема без легенды: от внешней линии сетки до внешней
      const half = Math.ceil((grid.thin || 2) / 2);
      const box = { x0: Math.max(0, Math.round(grid.xs[0]) - half), y0: Math.max(0, Math.round(grid.ys[0]) - half),
        x1: Math.min(f.width - 1, Math.round(grid.xs[grid.cols]) + half), y1: Math.min(f.height - 1, Math.round(grid.ys[grid.rows]) + half) };
      const legend = rows.map(function (r) { return { sq: SI.crop(bmp, r.sq, 1), code: SI.crop(bmp, r.code, 1) }; });
      const image = SI.crop(bmp, box, 0);
      const scheme = {
        name: file.name, cols: grid.cols, rows: grid.rows, pitchMm: pitchMm, dpi: dpi,
        pristine: { image: image, legend: legend }, image: image, legend: legend, cells: SI.cellColors(dec, grid),
        dec: dec, work: null, box: box, sqBoxes: rows.map(function (r) { return r.sq; }),
        scan: Object.assign({ grid: grid, legend: legendObj }, cl)
      };
      if (state.scheme) dropScheme();
      state.scheme = scheme;
      state.edits = new Map();
      applyEdits(); // контрастная сетка — сразу, если включена
      // подписи в списке: строка легенды (квадратик и номер) или пример клетки
      state.crops = cl.classes.map(function (c) {
        if (c.legend >= 0) return legendThumb(bmp, rows[c.legend]);
        const i = c.sample, cx = i % grid.cols, cy = Math.floor(i / grid.cols);
        return thumb(bmp, { x0: Math.round(grid.xs[cx]), y0: Math.round(grid.ys[cy]), x1: Math.round(grid.xs[cx + 1]), y1: Math.round(grid.ys[cy + 1]) }, 0);
      });
      // номера и значки текстом — для вкладыша и этикеток (проверяет пользователь)
      scheme.ocr = OCR ? OCR.read(bmp, rows) : rows.map(function () { return { code: '', symbol: '', sure: false, symSure: false }; });
      scheme.rowThumbs = rows.map(function (r) { return legendThumb(bmp, r); });
      scheme.classOf = rows.map(function () { return -1; });
      cl.classes.forEach(function (c, k) { if (c.legend >= 0) scheme.classOf[c.legend] = k; });
      state.sel = -1;
      state.order = cl.classes.map(function (c, k) { return k; }).sort(function (a, b) {
        const la = cl.classes[a].legend, lb = cl.classes[b].legend;
        return (la < 0 ? 1e6 + a : la) - (lb < 0 ? 1e6 + b : lb);
      });
      $('symbolsStep').hidden = false;
      $('kitStep').hidden = false;
      renderRows();
      renderKit();
      const wCm = Math.round((grid.cols * pitchMm) / 10), hCm = Math.round((grid.rows * pitchMm) / 10);
      $('fileInfo').hidden = false;
      $('fileInfo').textContent = file.name + ' · ' + grid.cols + ' × ' + grid.rows + ' ' + T('страз') + ' · ' + wCm + ' × ' + hCm + ' ' + T('см') + ' · ' + legend.length + ' ' + T('цветов');
      $('dropTitle').textContent = file.name;
      $('dropHint').textContent = T('нажмите, чтобы выбрать другие файлы');
      const dropThumb = $('dropThumb');
      dropThumb.textContent = '';
      dropThumb.style.backgroundImage = 'url("' + scheme.cells.toDataURL('image/png') + '")';
    } finally { bmp.close(); }
  }

  function dropScheme() {
    const sc = state.scheme;
    release(sc.pristine.image); release(sc.cells);
    if (sc.image !== sc.pristine.image) release(sc.image);
    state.scheme = null;
  }

  /* Подпись строки для списка значков: кусок картинки высотой 34 точки. */
  function thumb(src, r, pad) {
    const sx = Math.max(0, r.x0 - pad), sy = Math.max(0, r.y0 - pad), sw = r.x1 - r.x0 + 1 + 2 * pad, sh = r.y1 - r.y0 + 1 + 2 * pad;
    const H = 34, W = Math.max(1, Math.round((sw * H) / sh)), cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
    const img = new Image();
    img.src = cv.toDataURL('image/png');
    img.alt = '';
    cv.width = cv.height = 0;
    return img;
  }

  /* Подпись строки легенды: квадратик и номер рядом (в программе между ними широкий пробел). */
  function legendThumb(src, r) {
    const H = 34, k = H / (r.sq.y1 - r.sq.y0 + 7), sw = (r.sq.x1 - r.sq.x0 + 7) * k, cw = (r.code.x1 - r.code.x0 + 7) * k, ch = (r.code.y1 - r.code.y0 + 7) * k;
    const cv = A.makeCanvas(Math.round(sw + H * 0.25 + cw), H), x = cv.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cv.width, H);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, r.sq.x0 - 3, r.sq.y0 - 3, r.sq.x1 - r.sq.x0 + 7, r.sq.y1 - r.sq.y0 + 7, 0, 0, sw, H);
    x.drawImage(src, r.code.x0 - 3, r.code.y0 - 3, r.code.x1 - r.code.x0 + 7, r.code.y1 - r.code.y0 + 7, sw + H * 0.25, (H - ch) / 2, cw, ch);
    const img = new Image();
    img.src = cv.toDataURL('image/png');
    img.alt = '';
    cv.width = cv.height = 0;
    return img;
  }

  // ---------- замена значков ----------
  function renderRows() {
    const list = $('symRows'), sc = state.scheme;
    list.textContent = '';
    if (!sc) return;
    state.order.forEach(function (k) {
      const c = sc.scan.classes[k], li = el('li'), row = el('button', 'sym-row');
      row.type = 'button';
      row.setAttribute('aria-pressed', state.sel === k ? 'true' : 'false');
      const th = el('span', 'row-thumb');
      th.appendChild(state.crops[k].cloneNode());
      row.appendChild(th);
      const info = el('span', 'row-info');
      info.appendChild(el('b', '', fmt(c.count) + ' ' + T('клеток')));
      if (c.legend < 0) info.appendChild(el('small', 'warn-text', T('нет в легенде')));
      row.appendChild(info);
      const sym = state.edits.get(k);
      row.appendChild(el('span', 'row-target' + (sym ? ' set' : ''), sym ? '→ ' + sym.replace(/︎/g, '') : '→ …'));
      row.addEventListener('click', function () { select(k, true); A.symbolPicker.open(k); });
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
    $('resetAll').hidden = !state.edits.size;
  }

  /* Кусок плоскостей R, G, B → холст. */
  function planesCanvas(dec, r) {
    const f = dec.frame, W = f.width, c = f.comps, w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1, cv = A.makeCanvas(w, h), x = cv.getContext('2d');
    for (let y0 = 0; y0 < h; y0 += 512) {
      const bh = Math.min(512, h - y0), im = x.createImageData(w, bh), d = im.data;
      for (let y = 0; y < bh; y++) {
        let p = (r.y0 + y0 + y) * W + r.x0, o = y * w * 4;
        for (let i = 0; i < w; i++, p++, o += 4) { d[o] = c[0].plane[p]; d[o + 1] = c[1].plane[p]; d[o + 2] = c[2].plane[p]; d[o + 3] = 255; }
      }
      x.putImageData(im, 0, y0);
    }
    return cv;
  }

  /* Схема и квадратики легенды с новыми значками: перерисовываем копию исходных точек. */
  function applyEdits() {
    const sc = state.scheme;
    if (sc.image !== sc.pristine.image) { release(sc.image); sc.legend.forEach(function (r, i) { if (r.sq !== sc.pristine.legend[i].sq) release(r.sq); }); }
    const contrast = $('gridContrast').checked;
    if (!state.edits.size && !contrast) { sc.image = sc.pristine.image; sc.legend = sc.pristine.legend; return; }
    const f = sc.dec.frame;
    if (!sc.work) sc.work = { frame: { width: f.width, height: f.height, hmax: 1, vmax: 1, comps: f.comps.map(function (c) { return Object.assign({}, c, { plane: new Uint8Array(c.plane.length) }); }) }, png: true, adobe: sc.dec.adobe };
    sc.work.frame.comps.forEach(function (c, i) { c.plane.set(f.comps[i].plane); });
    const edits = [];
    state.edits.forEach(function (sym, k) { edits.push({ k: k, symbol: sym }); });
    if (contrast) S.recolorGrid(sc.work, sc.scan); // сетка: чёрная на светлых клетках, белая на тёмных
    if (edits.length) S.applyEdits(sc.work, sc.scan, edits, A.symbolPicker.maskFor, { size: +$('size').value / 100, legend: true });
    sc.image = planesCanvas(sc.work, sc.box);
    sc.legend = sc.pristine.legend.map(function (r, i) {
      const b = sc.sqBoxes[i];
      return { sq: planesCanvas(sc.work, { x0: Math.max(0, b.x0 - 1), y0: Math.max(0, b.y0 - 1), x1: Math.min(f.width - 1, b.x1 + 1), y1: Math.min(f.height - 1, b.y1 + 1) }), code: r.code };
    });
  }

  function afterEdit() {
    renderRows();
    applyEdits();
    renderKit();
    schedule();
    const n = state.edits.size;
    setStatus(n ? T('Заменено значков: ') + n + T('. Сохраните JPEG для типографии, когда всё готово.') : T('Значки как в программе. Нажмите на значок в списке, чтобы заменить его.'));
  }

  function openPhoto(file) {
    return new Promise(function (resolve) {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > MAX_PIXELS) { URL.revokeObjectURL(url); resolve(); return; }
        if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
        state.photo = img; state.photoUrl = url; state.photoName = file.name;
        $('photoInfo').hidden = false;
        $('photoInfo').textContent = T('Картинка для фона и миниатюры: ') + file.name;
        resolve();
      };
      img.onerror = function () { URL.revokeObjectURL(url); setStatus(T('Не удалось открыть картинку ') + file.name + '.', 'error'); resolve(); };
      img.src = url;
    });
  }

  // ---------- лист ----------
  function meta() {
    const sc = state.scheme;
    return {
      pitch: sc.pitchMm, wCm: Math.round((sc.cols * sc.pitchMm) / 10), hCm: Math.round((sc.rows * sc.pitchMm) / 10),
      article: $('article').value.trim(), title: $('title').value.trim(), urls: urls(),
      logos: state.logos.map(function (l) { return l.img; }), focusX: 0.5, focusY: 0.5,
      legendImages: sc.legend, light: true
    };
  }

  /* Лист в масштабе k (1 — печатное разрешение файла схемы). */
  function sheet(k) {
    const sc = state.scheme, cell = (sc.image.width / sc.cols) * k;
    let img = sc.image;
    if (k < 1) {
      img = A.makeCanvas(Math.max(1, Math.round(sc.image.width * k)), Math.max(1, Math.round(sc.image.height * k)));
      const x = img.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(sc.image, 0, 0, img.width, img.height);
    }
    try {
      return { canvas: A.renderLayout({ cols: sc.cols, rows: sc.rows, colors: [] }, meta(), state.photo || sc.cells, cell, img), pxPerMm: cell / sc.pitchMm };
    } finally { if (img !== sc.image) release(img); }
  }

  /* Лист, вкладыш — пересобираем; схема показывается как есть, в полном размере. */
  function render() {
    if (!state.scheme) return;
    const sc = state.scheme, k = Math.min(1, PREVIEW_SIDE / ((sc.image.height / sc.rows) * (sc.rows + 2 * 50 / sc.pitchMm)));
    const old = state.preview;
    state.preview = sheet(k).canvas;
    const oldIns = state.insert;
    state.insert = insertCanvas(0.5);
    showView();
    if (old !== state.preview) release(old);
    if (oldIns !== state.insert) release(oldIns);
  }

  function showView() {
    const sc = state.scheme, holder = $('holder'), stage = $('stage');
    if (!sc) return;
    const cv = state.tab === 'scheme' ? sc.image : state.tab === 'insert' ? state.insert : state.preview;
    const old = holder.firstChild, sl = stage.scrollLeft, st = stage.scrollTop;
    const same = old && old.width === cv.width && old.height === cv.height && old.dataset.tab === state.tab;
    cv.className = '';
    cv.dataset.tab = state.tab;
    if (same) { cv.style.width = old.style.width; cv.style.height = old.style.height; }
    const kids = [cv];
    if (state.tab === 'scheme') { drawSelection(); kids.push(state.overlay); }
    if (old !== cv || holder.children.length !== kids.length) {
      if (holder.replaceChildren) holder.replaceChildren.apply(holder, kids);
      else { holder.textContent = ''; kids.forEach(function (n) { holder.appendChild(n); }); }
    }
    holder.hidden = false;
    $('empty').hidden = true;
    applyZoom();
    if (same) { stage.scrollLeft = sl; stage.scrollTop = st; }
  }

  function selectTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    state.zoom = 1;
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
    showView();
  }

  /* Клетки выбранного значка обводим рамкой — соседние клетки остаются видны, чтобы сравнить. */
  const OV = 0.5;
  function drawSelection() {
    const sc = state.scheme;
    if (!sc) return;
    let ov = state.overlay;
    const w = Math.round(sc.image.width * OV), h = Math.round(sc.image.height * OV);
    if (!ov) { ov = state.overlay = A.makeCanvas(w, h); }
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    ov.className = 'overlay';
    const x = ov.getContext('2d');
    x.clearRect(0, 0, w, h);
    if (state.sel < 0) return;
    const scan = sc.scan, g = scan.grid, x0 = sc.box.x0, y0 = sc.box.y0;
    x.strokeStyle = '#ff2d7a';
    x.lineWidth = 2;
    for (let i = 0; i < scan.cells.length; i++) {
      if (scan.cells[i] !== state.sel) continue;
      const cx = i % g.cols, cy = Math.floor(i / g.cols);
      x.strokeRect((g.xs[cx] - x0) * OV + 1, (g.ys[cy] - y0) * OV + 1, g.pitch * OV - 2, g.pitch * OV - 2);
    }
  }

  /* Увеличить схему на первой клетке выбранного значка. */
  function focusSel() {
    const sc = state.scheme, stage = $('stage');
    if (!sc || state.sel < 0 || state.tab !== 'scheme') return;
    const scan = sc.scan, g = scan.grid, i = scan.cells.indexOf(state.sel);
    if (i < 0) return;
    state.zoom = clamp(12 * (sc.image.height / g.pitch) / 200, 3, 6); // видно новые значки и соседей вокруг
    applyZoom();
    const cv = $('holder').firstChild, r = cv.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const cx = ((g.xs[i % g.cols] - sc.box.x0 + g.pitch / 2) / cv.width) * r.width, cy = ((g.ys[Math.floor(i / g.cols)] - sc.box.y0 + g.pitch / 2) / cv.height) * r.height;
    stage.scrollLeft += r.left + cx - (sr.left + sr.width / 2);
    stage.scrollTop += r.top + cy - (sr.top + sr.height / 2);
  }

  function select(k, keep) {
    state.sel = keep ? k : (state.sel === k ? -1 : k);
    renderRows();
    if (state.tab === 'scheme') drawSelection();
  }
  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(render, 250);
  }

  // ---------- вкладыш и этикетки ----------
  function renderKit() {
    const sc = state.scheme, list = $('kitRows');
    list.textContent = '';
    if (!sc) return;
    sc.ocr.forEach(function (o, j) {
      const k = sc.classOf[j], li = el('li'), th = el('span', 'row-thumb');
      th.appendChild(sc.rowThumbs[j].cloneNode());
      li.appendChild(th);
      const code = el('input', o.sure ? '' : 'unsure');
      code.type = 'text';
      code.maxLength = 8;
      code.value = o.code;
      code.title = T('Номер цвета DMC');
      code.setAttribute('aria-label', code.title);
      code.addEventListener('input', function () { o.code = code.value.trim(); o.sure = true; code.className = ''; scheduleInsert(); });
      li.appendChild(code);
      const fixed = k >= 0 ? state.edits.get(k) : null;
      if (fixed) {
        const f = el('span', 'sym fixed', fixed.replace(/︎/g, ''));
        f.title = T('Новый значок');
        li.appendChild(f);
      } else {
        const sym = el('input', 'sym' + (o.symSure ? '' : ' unsure'));
        sym.type = 'text';
        sym.maxLength = 2;
        sym.value = o.symbol;
        sym.title = T('Значок на схеме');
        sym.setAttribute('aria-label', sym.title);
        sym.addEventListener('input', function () { o.symbol = sym.value.trim(); o.symSure = true; sym.className = 'sym'; scheduleInsert(); });
        li.appendChild(sym);
      }
      list.appendChild(li);
    });
    $('insertSave').disabled = $('labelsSave').disabled = false;
  }

  /* Значки программы, прочитанные из легенды: значок → позначка (их нельзя дать другому цвету). */
  function usedSymbols() {
    const sc = state.scheme, m = new Map();
    if (sc) sc.ocr.forEach(function (o, j) { if (o.symbol && sc.classOf[j] >= 0) m.set(o.symbol, sc.classOf[j]); });
    return m;
  }

  function hex2(v) { v = clamp(Math.round(v), 0, 255); return (v < 16 ? '0' : '') + v.toString(16); }

  /* Цвета в порядке легенды программы: номер, значок (новый или прочитанный), число страз, цвет, квадратик. */
  function kitColors() {
    const sc = state.scheme, out = [];
    sc.ocr.forEach(function (o, j) {
      const k = sc.classOf[j];
      if (k < 0) return; // строка легенды без клеток на схеме
      const c = sc.scan.classes[k], r = c.bg[0], g = c.bg[1], b = c.bg[2];
      out.push({ code: o.code || '?', symbol: state.edits.get(k) || o.symbol || '?', count: c.count, r: r, g: g, b: b,
        hex: '#' + hex2(r) + hex2(g) + hex2(b), dark: 0.299 * r + 0.587 * g + 0.114 * b < 128, symImage: sc.legend[j].sq });
    });
    return out;
  }

  function insertCanvas(K) {
    const sc = state.scheme, m = meta(), st = readSettings();
    m.insertStyle = st.insertStyle === 'table' ? 'table' : 'list'; // как выбрано в «Алмазной схеме»
    return A.renderInsert({ cols: sc.cols, rows: sc.rows, colors: kitColors() }, m, state.photo || sc.cells, K);
  }
  function scheduleInsert() {
    clearTimeout(state.insTimer);
    state.insTimer = setTimeout(function () {
      if (!state.scheme) return;
      const old = state.insert;
      state.insert = insertCanvas(0.5);
      if (state.tab === 'insert') showView();
      release(old);
    }, 300);
  }

  function baseName() {
    const clean = function (s) { return String(s || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 80); };
    return clean([$('article').value.trim(), $('title').value.trim()].filter(Boolean).join(' ')) || clean(state.scheme.name.replace(/\.[^.]+$/, ''));
  }

  function download(parts, name, type) {
    const url = URL.createObjectURL(new Blob(parts, { type: type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function unsureCount() {
    return state.scheme.ocr.filter(function (o, j) { return !o.sure || (!o.symSure && !state.edits.has(state.scheme.classOf[j])); }).length;
  }

  async function saveInsert() {
    if (!state.scheme || state.busy) return;
    state.busy = true;
    let cv = null;
    try {
      cv = insertCanvas(1);
      const blob = await new Promise(function (resolve) { cv.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('png');
      const bytes = A.pngSetDpi(new Uint8Array(await blob.arrayBuffer()), A.INSERT_PX_PER_MM);
      const name = T('Вкладыш') + ' ' + baseName() + '.png';
      download([bytes], name, 'image/png');
      const u = unsureCount();
      setStatus(T('Сохранено: ') + name + (u ? ' · ' + T('проверьте строки, выделенные жёлтым: ') + u : ''), u ? '' : 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти. Попробуйте на компьютере.'), 'error');
    } finally { release(cv); state.busy = false; }
  }

  function saveLabels() {
    if (!state.scheme || state.busy) return;
    const st = readSettings(), reserve = clamp(parseInt(st.reserve, 10) || 0, 0, 50), k = 1 + reserve / 100;
    const parts = A.labelsDocx({
      article: $('article').value.trim(), title: $('title').value.trim(), unit: T('шт'),
      rows: kitColors().map(function (c) { return { symbol: c.symbol, code: c.code, count: Math.ceil(c.count * k) }; })
    });
    const name = T('Этикетки') + ' ' + baseName() + '.docx';
    download(parts, name, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const u = unsureCount();
    setStatus(T('Сохранено: ') + name + (reserve ? ' · ' + T('с запасом ') + reserve + '%' : '') + (u ? ' · ' + T('проверьте строки, выделенные жёлтым: ') + u : ''), u ? '' : 'ok');
  }

  // ---------- сохранение ----------
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

  /* Лист → JPEG CMYK (мелованная бумага, FOGRA39), 300 dpi, полосами — как в «Алмазной схеме». */
  async function jpegCmyk(cv, pxPerMm) {
    const lut = await loadCmykLut();
    let dpi = 300, k = (dpi / 25.4) / pxPerMm;
    const area = cv.width * cv.height * k * k;
    if (area > JPEG_MAX_PIXELS) { dpi = Math.floor(dpi * Math.sqrt(JPEG_MAX_PIXELS / area)); k = (dpi / 25.4) / pxPerMm; }
    const w = Math.max(8, Math.round(cv.width * k)), h = Math.max(8, Math.round(cv.height * k)), BAND = 256;
    const band = A.makeCanvas(w, BAND), x = band.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    const enc = A.jpegCmyk(w, h, lut, 80, dpi);
    try {
      for (let y0 = 0; y0 < h; y0 += BAND) {
        const bh = Math.min(BAND, h - y0);
        x.fillStyle = '#ffffff';
        x.fillRect(0, 0, w, BAND);
        x.drawImage(cv, 0, -y0, w, h);
        const data = x.getImageData(0, 0, w, bh).data;
        for (let y = 0; y < bh; y += 8) enc.band(data.subarray(y * w * 4, (y + 8) * w * 4), Math.min(8, bh - y));
        setStatus(T('Сохраняю JPEG для типографии… ') + Math.round(((y0 + bh) / h) * 100) + '%');
        await wait(0);
      }
      return { parts: enc.finish(), dpi: dpi };
    } finally { release(band); }
  }

  /* Имя файла как принято у заказчика: артикул без «AS» (305087.jpg); нет артикула — название. */
  function fileName() {
    const clean = function (s) { return String(s || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 60); };
    return (clean($('article').value.replace(/^\s*AS\b\s*/i, '')) || clean($('title').value) || T('Макет')) + '.jpg';
  }

  async function save() {
    if (!state.scheme || state.busy) return;
    state.busy = true;
    $('save').disabled = true;
    setStatus(T('Собираю лист в печатном качестве…'));
    await wait(40);
    let cv = null;
    try {
      const s = sheet(1);
      cv = s.canvas;
      const out = await jpegCmyk(cv, s.pxPerMm), name = fileName();
      const url = URL.createObjectURL(new Blob(out.parts, { type: 'image/jpeg' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      setStatus(T('Сохранено: ') + name + ' · CMYK · ' + out.dpi + ' dpi', 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти. Попробуйте на компьютере.'), 'error');
    } finally {
      release(cv);
      state.busy = false;
      $('save').disabled = !state.scheme;
    }
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
  /* Масштаб вокруг точки (курсора или середины экрана): то, что под ней, остаётся на месте. */
  function setZoom(z, cx, cy) {
    const cv = $('holder').firstChild, stage = $('stage');
    if (!cv) return;
    z = clamp(z, 0.5, state.tab === 'insert' ? 6 : 24);
    const sr = stage.getBoundingClientRect(), px = cx === undefined ? sr.left + sr.width / 2 : cx, py = cy === undefined ? sr.top + sr.height / 2 : cy;
    const r0 = cv.getBoundingClientRect(), fx = (px - r0.left) / r0.width, fy = (py - r0.top) / r0.height;
    state.zoom = z;
    applyZoom();
    const r1 = cv.getBoundingClientRect();
    stage.scrollLeft += r1.left + fx * r1.width - px;
    stage.scrollTop += r1.top + fy * r1.height - py;
  }

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
      if (target && /^H[23]$/.test(target.tagName)) target.appendChild(b);
      else p.parentElement.insertBefore(b, p);
      p.remove();
    });
    document.addEventListener('click', hide);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, true);
  }

  function init() {
    A.translateDom(document.body);
    setupHints();
    $('version').textContent = VERSION;
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === A.lang ? 'true' : 'false');
      b.addEventListener('click', function () { if (b.dataset.lang !== A.lang) { A.setLang(b.dataset.lang); location.reload(); } });
    });
    $('urls').value = typeof readSettings().urls === 'string' ? readSettings().urls.slice(0, 300) : '';
    restoreLogos();
    ['drop', 'emptyPick'].forEach(function (id) { $(id).addEventListener('click', function () { $('file').click(); }); });
    $('file').addEventListener('change', function (e) { loadFiles(e.target.files); e.target.value = ''; });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });
    ['article', 'title'].forEach(function (id) { $(id).addEventListener('input', schedule); });
    A.symbolPicker.init(function () { return { scan: state.scheme.scan, edits: state.edits, crops: state.crops, size: +$('size').value / 100, used: usedSymbols() }; },
      function (k, sym) {
        if (sym) state.edits.set(k, sym); else state.edits.delete(k);
        afterEdit();
        if (sym) { state.sel = k; selectTab('scheme'); focusSel(); } // сразу показать новые значки крупно
      });
    $('size').addEventListener('input', function () {
      $('sizeOut').textContent = $('size').value + '%';
      if (!state.scheme || !state.edits.size) return;
      clearTimeout(state.sizeTimer);
      state.sizeTimer = setTimeout(function () { applyEdits(); render(); }, 200);
    });
    $('gridContrast').addEventListener('change', function () { if (state.scheme) { applyEdits(); render(); } });
    $('resetAll').addEventListener('click', function () { state.edits.clear(); afterEdit(); });
    $('insertSave').addEventListener('click', saveInsert);
    $('labelsSave').addEventListener('click', saveLabels);
    $('urls').addEventListener('input', function () { saveUrls(); schedule(); });
    $('logoPick').addEventListener('click', function () { $('logoFile').click(); });
    $('logoFile').addEventListener('change', function (e) {
      const files = Array.prototype.slice.call(e.target.files || [], 0, MAX_LOGOS - state.logos.length);
      e.target.value = '';
      Promise.all(files.map(readLogo)).then(function (items) {
        const ok = items.filter(Boolean);
        ok.forEach(function (it) { state.logos.push(it); });
        if (ok.length < files.length) setStatus(T('Некоторые картинки не удалось открыть.'), 'error');
        showLogos(); storeLogos(); schedule();
      });
    });
    $('save').addEventListener('click', save);
    $('panelToggle').addEventListener('click', function () {
      const hidden = document.body.classList.toggle('hide-panel');
      $('panelToggle').setAttribute('aria-pressed', hidden ? 'false' : 'true');
      applyZoom();
    });
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
    const stage = $('stage');
    stage.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !state.scheme) return;
      e.preventDefault();
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    let drag = null; // увеличенную схему двигают мышью или пальцем
    stage.addEventListener('pointerdown', function (e) {
      if (!state.scheme || e.button !== 0 || state.zoom <= 1.01) return;
      drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
      stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!drag) return;
      stage.scrollLeft = drag.l - (e.clientX - drag.x);
      stage.scrollTop = drag.t - (e.clientY - drag.y);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) { stage.addEventListener(ev, function () { drag = null; stage.classList.remove('panning'); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.sel >= 0 && !document.querySelector('dialog[open]')) select(-1, true); });
    $('zoomIn').addEventListener('click', function () { setZoom(state.zoom * 1.5); });
    $('zoomOut').addEventListener('click', function () { setZoom(state.zoom / 1.5); });
    $('zoomFit').addEventListener('click', function () { state.zoom = 1; applyZoom(); });
    window.addEventListener('resize', applyZoom);
  }

  A.composeApp = { state: state, loadFiles: loadFiles, save: save, sheet: sheet, fileName: fileName,
    setEdit: function (k, s) { if (s) state.edits.set(k, s); else state.edits.delete(k); afterEdit(); } };
  init();
})(window.ALMAZ = window.ALMAZ || {});
