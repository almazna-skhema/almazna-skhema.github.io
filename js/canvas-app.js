/* Раздел «Фото на холсте»: макет для печати картины или постера из одного фото.
 * Кадр, торцы подрамника, обработка, подпись, примерка на стене, файл CMYK или RGB. */
(function (A) {
  'use strict';

  const T = A.T;
  const ASSET_VERSION = 26; // тот же номер, что в адресах скриптов в canvas.html
  const VERSION = T('версия') + ' 26 · 17.11.2026';
  const $ = function (id) { return document.getElementById(id); };
  // телефоны и планшеты не держат большие холсты в памяти — там пределы скромнее
  const COARSE = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const MAX_SOURCE = COARSE ? 12e6 : 40e6; // рабочая копия фото, точек
  const MAX_OUT = COARSE ? 16e6 : 90e6;    // предел размера файла для печати, точек
  const MAX_SIDE = 16000;
  const SAVED = ['wCm', 'hCm', 'wrap', 'wrapMode', 'wrapColor', 'colorMode', 'captionColor', 'captionPos', 'captionSize'];
  const state = { raw: null, rawUrl: '', src: null, small: null, name: '', rot: 0, flipX: false, flipY: false, fx: 0.5, fy: 0.5, tab: 'layout', step: 1, busy: false };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
  function release(cv) { if (cv && cv.getContext) cv.width = cv.height = 0; }
  function setStatus(text, kind) {
    const s = $('status');
    s.textContent = text;
    s.classList.toggle('error', kind === 'error');
    s.classList.toggle('ok', kind === 'ok');
  }

  // ---------- настройки ----------
  function params() {
    return {
      w: clamp(parseFloat($('wCm').value) || 50, 5, 300), h: clamp(parseFloat($('hCm').value) || 40, 5, 300),
      wrap: clamp(parseFloat(String($('wrap').value).replace(',', '.')) || 0, 0, 10),
      wrapMode: $('wrapMode').value, wrapColor: $('wrapColor').value,
      zoom: clamp(+$('zoom').value / 100, 1, 4), fx: state.fx, fy: state.fy,
      brightness: +$('brightness').value, contrast: +$('contrast').value, saturation: +$('saturation').value, tone: $('tone').value,
      caption: $('caption').value.trim(), captionPos: $('captionPos').value, captionColor: $('captionColor').value, captionSize: +$('captionSize').value,
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
    ['brightness', 'contrast', 'saturation', 'captionSize'].forEach(function (id) { $(id + 'Out').textContent = $(id).value; });
    $('zoomOut').textContent = $('zoom').value + '%';
    $('wrapColorRow').hidden = $('wrapMode').value !== 'color';
    const w = +$('wCm').value, h = +$('hCm').value, key = Math.min(w, h) + 'x' + Math.max(w, h), preset = $('sizePreset');
    preset.value = Array.prototype.some.call(preset.options, function (o) { return o.value === key; }) ? key : 'custom';
  }

  // ---------- рабочая копия фото ----------
  function rebuildSource() {
    const raw = state.raw, iw = raw.naturalWidth, ih = raw.naturalHeight;
    const k = Math.min(1, Math.sqrt(MAX_SOURCE / (iw * ih)));
    const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k)), turned = state.rot % 180 !== 0;
    const cv = A.makeCanvas(turned ? h : w, turned ? w : h), x = cv.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cv.width, cv.height);
    x.translate(cv.width / 2, cv.height / 2);
    x.rotate((state.rot * Math.PI) / 180);
    x.scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1);
    x.drawImage(raw, -w / 2, -h / 2, w, h);
    release(state.src);
    state.src = cv;
    // для экрана — уменьшенная копия: кадр двигается плавно даже с очень большим фото
    const sk = Math.min(1, 1800 / Math.max(cv.width, cv.height));
    release(state.small);
    state.small = sk < 1 ? A.downscale(cv, { x: 0, y: 0, w: cv.width, h: cv.height }, Math.max(1, Math.round(cv.width * sk)), Math.max(1, Math.round(cv.height * sk))) : null;
  }

  /* Что и куда рисуется: вся площадь печати (лицо + торцы), лицевая часть и кусок фото. */
  function geometry(p, from) {
    const src = from || state.src, total = { w: p.w + 2 * p.wrap, h: p.h + 2 * p.wrap };
    const area = p.wrapMode === 'extend' ? total : { w: p.w, h: p.h }; // на что ложится само фото
    const aspect = area.w / area.h;
    let cw = src.width, ch = cw / aspect;
    if (ch > src.height) { ch = src.height; cw = ch * aspect; }
    cw /= p.zoom; ch /= p.zoom;
    return { total: total, area: area, crop: { x: (src.width - cw) * p.fx, y: (src.height - ch) * p.fy, w: cw, h: ch } };
  }

  /* Свет, цвет и тон — по точкам: так работает в любом браузере. */
  function adjust(cv, p) {
    if (!p.brightness && !p.contrast && !p.saturation && p.tone === 'color') return;
    const x = cv.getContext('2d'), br = p.brightness * 1.1, c = p.contrast * 1.2, cf = (259 * (c + 255)) / (255 * (259 - c)), sf = 1 + p.saturation / 100;
    for (let y0 = 0; y0 < cv.height; y0 += 512) {
      const rows = Math.min(512, cv.height - y0), im = x.getImageData(0, y0, cv.width, rows), d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = cf * (d[i] + br - 128) + 128, g = cf * (d[i + 1] + br - 128) + 128, b = cf * (d[i + 2] + br - 128) + 128;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * sf; g = gray + (g - gray) * sf; b = gray + (b - gray) * sf;
        if (p.tone === 'bw') r = g = b = gray;
        else if (p.tone === 'sepia') {
          const R = 0.393 * r + 0.769 * g + 0.189 * b, G = 0.349 * r + 0.686 * g + 0.168 * b, B = 0.272 * r + 0.534 * g + 0.131 * b;
          r = R; g = G; b = B;
        }
        d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray сам обрежет до 0…255
      }
      x.putImageData(im, 0, y0);
    }
  }

  /* Макет для печати. ppc — точек на сантиметр; guides — линии сгиба для экрана. */
  function renderPrint(p, ppc, guides, from) {
    const src = from || state.src, g = geometry(p, src), W = Math.max(8, Math.round(g.total.w * ppc)), H = Math.max(8, Math.round(g.total.h * ppc));
    const wr = Math.round(p.wrap * ppc), fw = W - 2 * wr, fh = H - 2 * wr;
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.fillStyle = p.wrapMode === 'color' ? p.wrapColor : '#ffffff';
    x.fillRect(0, 0, W, H);
    if (p.wrapMode === 'extend') x.drawImage(src, g.crop.x, g.crop.y, g.crop.w, g.crop.h, 0, 0, W, H);
    else x.drawImage(src, g.crop.x, g.crop.y, g.crop.w, g.crop.h, wr, wr, fw, fh);
    adjust(cv, p);
    if (p.wrapMode === 'color' && wr) { // заливку торцов обработка трогать не должна
      x.fillStyle = p.wrapColor;
      x.fillRect(0, 0, W, wr); x.fillRect(0, H - wr, W, wr); x.fillRect(0, wr, wr, fh); x.fillRect(W - wr, wr, wr, fh);
    }
    if (p.wrapMode === 'mirror' && wr) {
      // сначала боковые торцы, потом верх и низ во всю ширину — так сами собой заполняются углы
      x.save(); x.translate(2 * wr, 0); x.scale(-1, 1); x.drawImage(cv, wr, wr, wr, fh, wr, wr, wr, fh); x.restore();
      x.save(); x.translate(2 * (W - wr), 0); x.scale(-1, 1); x.drawImage(cv, W - 2 * wr, wr, wr, fh, W - 2 * wr, wr, wr, fh); x.restore();
      x.save(); x.translate(0, 2 * wr); x.scale(1, -1); x.drawImage(cv, 0, wr, W, wr, 0, wr, W, wr); x.restore();
      x.save(); x.translate(0, 2 * (H - wr)); x.scale(1, -1); x.drawImage(cv, 0, H - 2 * wr, W, wr, 0, H - 2 * wr, W, wr); x.restore();
    }
    if (p.caption) {
      const size = (fh * p.captionSize) / 100, lines = p.caption.split('\n').slice(0, 4);
      x.font = 'bold ' + Math.max(6, Math.round(size)) + 'px Arial, Helvetica, sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      const lh = size * 1.2, block = lh * lines.length;
      const cy = p.captionPos === 'top' ? wr + size * 0.9 + block / 2 : p.captionPos === 'center' ? wr + fh / 2 : wr + fh - size * 0.9 - block / 2;
      x.shadowColor = 'rgba(0,0,0,0.55)';
      x.shadowBlur = size * 0.18;
      x.fillStyle = p.captionColor;
      lines.forEach(function (l, i) { x.fillText(l, wr + fw / 2, cy - block / 2 + lh * (i + 0.5), fw * 0.92); });
      x.shadowColor = 'transparent';
    }
    if (guides && wr) {
      x.fillStyle = 'rgba(255,255,255,0.28)'; // торцы на экране чуть приглушены
      x.fillRect(0, 0, W, wr); x.fillRect(0, H - wr, W, wr); x.fillRect(0, wr, wr, fh); x.fillRect(W - wr, wr, wr, fh);
      x.setLineDash([Math.max(4, W / 90), Math.max(3, W / 140)]);
      x.lineWidth = Math.max(1, W / 600);
      x.strokeStyle = '#ffffff';
      x.strokeRect(wr, wr, fw, fh);
      x.lineDashOffset = Math.max(4, W / 90);
      x.strokeStyle = '#000000';
      x.strokeRect(wr, wr, fw, fh);
      x.setLineDash([]);
    }
    return cv;
  }

  /* Примерка: картина на стене рядом с человеком ростом 165 см. */
  function renderWall(p) {
    const W = 1400, H = 900, floor = 760, wallCm = Math.max(260, p.w * 1.9, (p.h + 150) * 1.05), k = (W * 0.86) / wallCm; // точек на см
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    const bg = x.createLinearGradient(0, 0, 0, floor);
    bg.addColorStop(0, '#eceae5'); bg.addColorStop(1, '#dedbd4');
    x.fillStyle = bg; x.fillRect(0, 0, W, floor);
    x.fillStyle = '#b9ab98'; x.fillRect(0, floor, W, H - floor);
    x.fillStyle = '#f4f2ee'; x.fillRect(0, floor - 14, W, 14);
    const face = renderPrint(Object.assign({}, p, { wrap: 0, wrapMode: 'mirror' }), Math.max(2, Math.min(40, 900 / Math.max(p.w, p.h))), false, state.small);
    const pw = p.w * k, ph = p.h * k, px = W * 0.56 - pw / 2, py = floor - 150 * k - ph; // центр картины примерно на уровне глаз
    x.shadowColor = 'rgba(0,0,0,0.3)'; x.shadowBlur = 22; x.shadowOffsetY = 10;
    x.drawImage(face, px, Math.max(20, py), pw, ph);
    x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0;
    release(face);
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
    x.fillStyle = '#6b7480'; x.font = '22px Arial, Helvetica, sans-serif'; x.textAlign = 'center';
    x.fillText('165 ' + T('см'), fxp, floor + 40);
    x.fillText(p.w + ' × ' + p.h + ' ' + T('см'), px + pw / 2, floor + 40);
    return cv;
  }

  // ---------- экран ----------
  let frame = 0;
  function redraw() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      if (!state.src) return;
      const p = params(), holder = $('holder');
      const total = geometry(p).total;
      const cv = state.tab === 'wall' ? renderWall(p) : renderPrint(p, clamp(1100 / Math.max(total.w, total.h), 1.5, 60), true, state.small);
      release(holder.firstChild);
      holder.textContent = '';
      holder.appendChild(cv);
      fit();
      showQuality(p);
      showFileInfo(p);
    });
  }

  function fit() {
    const cv = $('holder').firstChild, stage = $('stage');
    if (!cv) return;
    const s = Math.max(0.02, Math.min((stage.clientWidth - 44) / cv.width, (stage.clientHeight - 44) / cv.height));
    cv.style.width = Math.round(cv.width * s) + 'px';
    cv.style.height = Math.round(cv.height * s) + 'px';
    stage.classList.toggle('pannable', state.tab === 'layout');
  }

  /* Хватит ли фото на выбранный размер: считаем, сколько точек придётся на дюйм. */
  function sourceDpi(p) {
    const g = geometry(p);
    return g.crop.w / (g.area.w / 2.54);
  }

  function showQuality(p) {
    const box = $('quality'), dpi = sourceDpi(p);
    box.hidden = false;
    box.classList.toggle('bad', dpi < 70);
    box.classList.toggle('warn', dpi >= 70 && dpi < 110);
    // для холста 100 dpi и выше — хорошо; подсказываем, до какого размера фото «дотягивает»
    const g = geometry(p), k = dpi / 100, mw = Math.floor((g.area.w * k) / 5) * 5, mh = Math.floor((g.area.h * k) / 5) * 5;
    box.textContent = fmt(state.src.width) + ' × ' + fmt(state.src.height) + ' ' + T('точек') + ' · ' +
      (dpi >= 110 ? T('качества хватает') : dpi >= 70 ? T('приемлемо, вблизи может быть мягковато') : T('мало для этого размера — картина выйдет размытой')) +
      ' (' + Math.round(dpi) + ' dpi)' + (dpi < 110 && mw >= 10 && mh >= 10 ? '. ' + T('Чётко выйдет до ') + mw + ' × ' + mh + ' ' + T('см') : '');
  }

  function outputSize(p) {
    const g = geometry(p);
    let dpi = 300, w = (g.total.w / 2.54) * dpi, h = (g.total.h / 2.54) * dpi;
    const k = Math.min(1, Math.sqrt(MAX_OUT / (w * h)), MAX_SIDE / Math.max(w, h)); // очень большие холсты — с меньшим разрешением
    dpi = Math.max(50, Math.floor(dpi * k));
    return { dpi: dpi, w: Math.round((g.total.w / 2.54) * dpi), h: Math.round((g.total.h / 2.54) * dpi), cm: g.total };
  }

  function showFileInfo(p) {
    const o = outputSize(p);
    $('fileInfo').textContent = fileName(p) + ' · ' + fmt(o.w) + ' × ' + fmt(o.h) + ' ' + T('точек') + ' · ' + o.dpi + ' dpi · ' +
      T('лист') + ' ' + String(o.cm.w).replace('.', ',') + ' × ' + String(o.cm.h).replace('.', ',') + ' ' + T('см');
  }

  function fileName(p) {
    const base = (p.order || state.name.replace(/\.[^.]+$/, '') || T('Картина')).replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/^[\s.]+/, '').trim().slice(0, 60) || T('Картина');
    return base + ' ' + p.w + 'x' + p.h + '.jpg';
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

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function buildFile() {
    const p = params(), o = outputSize(p);
    const cv = renderPrint(p, o.dpi / 2.54, false);
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

  async function save() {
    if (!state.src || state.busy) return;
    state.busy = true;
    $('save').disabled = $('saveTop').disabled = true;
    setStatus(T('Готовлю файл в печатном качестве, это займёт несколько секунд…'));
    await wait(40);
    try {
      const f = await buildFile();
      const url = URL.createObjectURL(new Blob(f.parts, { type: 'image/jpeg' }));
      const a = document.createElement('a');
      a.href = url; a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      setStatus(f.dpi < 300 ? T('Сохранено с разрешением ') + f.dpi + T(' dpi: для такого большого холста браузер не держит 300.') : T('Сохранено в папку загрузок'), 'ok');
    } catch (e) {
      console.error(e);
      setStatus(T('Не получилось сохранить: браузеру не хватило памяти. Попробуйте размер меньше или другой компьютер.'), 'error');
    }
    state.busy = false;
    $('save').disabled = $('saveTop').disabled = false;
  }

  // ---------- загрузка фото ----------
  function loadImage(src, name, isBlob) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () {
        if (!img.naturalWidth || !img.naturalHeight) { setStatus(T('В файле нет изображения.'), 'error'); reject(new Error('empty')); return; }
        if (state.rawUrl) URL.revokeObjectURL(state.rawUrl);
        state.raw = img; state.rawUrl = isBlob ? src : ''; state.name = String(name || '').slice(0, 120);
        state.rot = 0; state.flipX = state.flipY = false; state.fx = state.fy = 0.5;
        $('zoom').value = 100;
        $('order').value = ''; $('caption').value = ''; // номер и подпись относятся к прошлому заказу
        ['brightness', 'contrast', 'saturation'].forEach(function (id) { $(id).value = 0; });
        $('tone').value = 'color';
        try { rebuildSource(); } catch (e) { setStatus(T('Не удалось прочитать эту картинку. Сохраните её как JPG или PNG и загрузите снова.'), 'error'); reject(e); return; }
        // холст поворачиваем под ориентацию фото
        const w = +$('wCm').value, h = +$('hCm').value, land = state.src.width > state.src.height * 1.05, port = state.src.height > state.src.width * 1.05;
        if ((land && w < h) || (port && w > h)) { $('wCm').value = h; $('hCm').value = w; }
        const thumb = A.downscale(state.src, { x: 0, y: 0, w: state.src.width, h: state.src.height }, Math.max(1, Math.round(state.src.width * Math.min(1, 200 / state.src.width))), Math.max(1, Math.round(state.src.height * Math.min(1, 200 / state.src.width))));
        $('dropThumb').textContent = '';
        $('dropThumb').style.backgroundImage = 'url("' + thumb.toDataURL('image/jpeg', 0.8) + '")';
        release(thumb);
        $('dropTitle').textContent = state.name || T('Фото загружено');
        $('dropHint').textContent = T('нажмите, чтобы заменить');
        $('imageTools').hidden = false;
        $('empty').hidden = true; $('holder').hidden = false;
        $('save').disabled = $('saveTop').disabled = false;
        syncOutputs();
        setStep(2);
        setStatus(T('Фото загружено. Выберите размер и кадр.'));
        resolve();
      };
      img.onerror = function () {
        if (isBlob) URL.revokeObjectURL(src);
        setStatus(T('Не удалось открыть файл. Подойдут JPG, PNG, WebP. Фото с iPhone в формате HEIC сначала сохраните как JPG.'), 'error');
        reject(new Error('load'));
      };
      img.src = src;
    });
  }

  function loadFile(file) {
    if (!file || state.busy) return;
    if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name)) { setStatus(T('Это не картинка. Подойдут JPG, PNG, WebP.'), 'error'); return; }
    setStatus(T('Открываю картинку…'));
    loadImage(URL.createObjectURL(file), file.name, true).catch(function () {});
  }

  function turn(change) {
    if (!state.raw) return;
    if (change.rot) {
      state.rot = (state.rot + change.rot + 360) % 360;
      const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w;
    }
    if (change.flipX) state.flipX = !state.flipX;
    if (change.flipY) state.flipY = !state.flipY;
    state.fx = state.fy = 0.5;
    try {
      rebuildSource();
    } catch (e) { // не хватило памяти на повёрнутую копию — возвращаем как было
      console.error(e);
      if (change.rot) { state.rot = (state.rot - change.rot + 360) % 360; const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w; }
      if (change.flipX) state.flipX = !state.flipX;
      if (change.flipY) state.flipY = !state.flipY;
      setStatus(T('Не получилось повернуть: браузеру не хватило памяти.'), 'error');
    }
    syncOutputs();
    redraw();
  }

  // ---------- этапы ----------
  const STEP_NAMES = { 1: 'Фото', 2: 'Размер', 3: 'Обработка', 4: 'Файл' };
  function setStep(n) {
    n = clamp(n | 0, 1, 4);
    if (!state.src) n = 1;
    state.step = n;
    document.querySelectorAll('[data-step]').forEach(function (s) { s.hidden = +s.dataset.step !== n; });
    document.querySelectorAll('[data-go]').forEach(function (b) {
      const k = +b.dataset.go;
      b.disabled = k > 1 && !state.src;
      if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', k < n);
    });
    $('stepBack').hidden = n === 1;
    $('stepNext').hidden = n === 4;
    $('stepNext').disabled = !state.src;
    $('stepNext').textContent = n < 4 ? T('Далее: ') + T(STEP_NAMES[n + 1]) + ' →' : '';
    $('save').hidden = n !== 4;
    $('panel').scrollTop = 0;
    redraw();
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('[data-tab]').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'); });
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
    setStep(1);

    ['drop', 'emptyPick'].forEach(function (id) { $(id).addEventListener('click', function () { $('file').click(); }); });
    $('file').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]); });
    document.addEventListener('paste', function (e) {
      const t = e.target, cd = e.clipboardData;
      if (!cd || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const f = Array.prototype.filter.call(cd.files, function (x) { return /^image\//.test(x.type); })[0];
      if (f) { e.preventDefault(); loadFile(f); }
    });

    ['wCm', 'hCm', 'wrap', 'wrapMode', 'wrapColor', 'zoom', 'brightness', 'contrast', 'saturation', 'tone', 'caption', 'captionPos', 'captionColor', 'captionSize', 'order', 'colorMode'].forEach(function (id) {
      $(id).addEventListener('input', function () { syncOutputs(); saveSettings(); redraw(); });
      $(id).addEventListener('change', function () { syncOutputs(); saveSettings(); redraw(); });
    });
    $('sizePreset').addEventListener('change', function (e) {
      if (e.target.value === 'custom') { $('wCm').focus(); return; }
      const wh = e.target.value.split('x'), land = +$('wCm').value >= +$('hCm').value;
      $('wCm').value = land ? wh[1] : wh[0];
      $('hCm').value = land ? wh[0] : wh[1];
      state.fx = state.fy = 0.5;
      syncOutputs(); saveSettings(); redraw();
    });
    $('swap').addEventListener('click', function () {
      const w = $('wCm').value; $('wCm').value = $('hCm').value; $('hCm').value = w;
      state.fx = state.fy = 0.5;
      syncOutputs(); saveSettings(); redraw();
    });
    $('rotL').addEventListener('click', function () { turn({ rot: -90 }); });
    $('rotR').addEventListener('click', function () { turn({ rot: 90 }); });
    $('flipH').addEventListener('click', function () { turn({ flipX: true }); });
    $('flipV').addEventListener('click', function () { turn({ flipY: true }); });
    $('resetAdjust').addEventListener('click', function () {
      ['brightness', 'contrast', 'saturation'].forEach(function (id) { $(id).value = 0; });
      $('tone').value = 'color';
      syncOutputs(); redraw();
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

    // кадр: фото двигают прямо на макете, масштаб — Ctrl + колесо или два пальца
    const stage = $('stage'), touches = new Map();
    let drag = null, pinch = null;
    function dist() { const t = Array.from(touches.values()); return Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y); }
    stage.addEventListener('pointerdown', function (e) {
      if (!state.src || state.tab !== 'layout' || e.target !== $('holder').firstChild) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ } // и второй палец: иначе его отпускание можно потерять
      if (touches.size === 2) { pinch = { d: dist(), zoom: +$('zoom').value }; drag = null; return; }
      if (touches.size > 2) return;
      drag = { x: e.clientX, y: e.clientY, fx: state.fx, fy: state.fy };
      stage.classList.add('panning');
    });
    stage.addEventListener('pointermove', function (e) {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        $('zoom').value = clamp(Math.round(pinch.zoom * (dist() / Math.max(10, pinch.d))), 100, 400);
        syncOutputs(); redraw();
        return;
      }
      if (!drag) return;
      const cv = $('holder').firstChild, p = params(), g = geometry(p), r = cv.getBoundingClientRect();
      // сколько экранных точек приходится на одну точку фото
      const areaPx = (p.wrapMode === 'extend' ? r.width : r.width * (p.w / g.total.w)), s = areaPx / g.crop.w;
      const slackX = state.src.width - g.crop.w, slackY = state.src.height - g.crop.h;
      if (slackX > 0.5) state.fx = clamp(drag.fx - (e.clientX - drag.x) / s / slackX, 0, 1);
      if (slackY > 0.5) state.fy = clamp(drag.fy - (e.clientY - drag.y) / s / slackY, 0, 1);
      redraw();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) {
      stage.addEventListener(ev, function (e) {
        if (!touches.has(e.pointerId) && ev === 'lostpointercapture') return;
        touches.delete(e.pointerId); if (touches.size < 2) pinch = null; drag = null; stage.classList.remove('panning');
      });
    });
    stage.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !state.src || state.tab !== 'layout') return;
      e.preventDefault();
      $('zoom').value = clamp(Math.round(+$('zoom').value * Math.exp(-e.deltaY * 0.01)), 100, 400);
      syncOutputs(); redraw();
    }, { passive: false });
    window.addEventListener('resize', fit);
  }

  A.canvasApp = {
    state: state, params: params, geometry: geometry, outputSize: outputSize, buildFile: buildFile, setStep: setStep, selectTab: selectTab,
    loadUrl: function (url, name) { return loadImage(url, name, false); }, sourceDpi: sourceDpi, fileName: fileName
  };
  init();
})(window.ALMAZ = window.ALMAZ || {});
