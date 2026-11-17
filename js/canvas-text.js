/* Надписи на холсте: шрифты, стили (цвет, золото, тень, контур, подложка) и рисование слоя текста.
 * Размеры в слое — физические: буквы в сантиметрах, тень и контур в миллиметрах; на экране и в файле
 * для печати надпись выглядит одинаково, меняется только число точек на сантиметр (ppc). */
(function (A) {
  'use strict';

  /* Шрифты, которые обычно есть на Windows и Mac. Показываем только установленные. */
  const FONTS = [
    ['Рукописные', ['Segoe Script', 'Segoe Print', 'Gabriola', 'Monotype Corsiva', 'Apple Chancery', 'Snell Roundhand', 'Savoye LET', 'Zapfino', 'Brush Script MT', 'Lucida Handwriting', 'Bradley Hand', 'Comic Sans MS', 'Noteworthy', 'Marker Felt', 'Ink Free', 'Mistral', 'Kristen ITC', 'Freestyle Script', 'Edwardian Script ITC', 'Vivaldi', 'Kunstler Script', 'Script MT Bold', 'Palace Script MT']],
    ['С засечками', ['Times New Roman', 'Georgia', 'Cambria', 'Palatino Linotype', 'Palatino', 'Book Antiqua', 'Garamond', 'Baskerville', 'Didot', 'Bodoni 72', 'Constantia', 'Bookman Old Style', 'Hoefler Text', 'Iowan Old Style', 'PT Serif', 'Charter', 'Sylfaen', 'Century Schoolbook']],
    ['Без засечек', ['Arial', 'Helvetica Neue', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Segoe UI', 'Calibri', 'Candara', 'Corbel', 'Century Gothic', 'Futura', 'Avenir Next', 'Gill Sans', 'Optima', 'PT Sans', 'Franklin Gothic Medium', 'Bahnschrift', 'Montserrat', 'Roboto', 'Open Sans']],
    ['Декоративные', ['Impact', 'Arial Black', 'Copperplate', 'Rockwell', 'Cooper Black', 'Papyrus', 'Herculanum', 'Chalkduster', 'Stencil', 'Showcard Gothic', 'Jokerman', 'Algerian', 'Old English Text MT', 'Broadway', 'Bauhaus 93', 'Harrington', 'Curlz MT', 'Snap ITC', 'Ravie', 'Chiller']]
  ];

  // ---------- какие шрифты установлены ----------
  let probe = null;
  function width(font, text) {
    if (!probe) probe = A.makeCanvas(10, 10).getContext('2d');
    probe.font = font;
    return probe.measureText(text).width;
  }
  /* Шрифт есть, если текст им шире или уже, чем запасным; кириллица — то же для русских букв. */
  function check(family) {
    const lat = 'AaBbWwQqgjl1230', cyr = 'ЖжЩщЮюЯяФфЄєЇї';
    let has = false, cyrOk = false;
    ['monospace', 'serif'].forEach(function (base) {
      if (width('72px "' + family + '", ' + base, lat) !== width('72px ' + base, lat)) has = true;
      if (width('72px "' + family + '", ' + base, cyr) !== width('72px ' + base, cyr)) cyrOk = true;
    });
    return { has: has, cyr: has && cyrOk };
  }

  let listCache = null;
  /* Установленные шрифты по группам: [{ group, fonts: [{ family, cyr }] }] + свои шрифты из файлов. */
  function available() {
    if (!listCache) {
      listCache = FONTS.map(function (g) {
        return { group: g[0], fonts: g[1].map(function (f) { const c = check(f); return { family: f, cyr: c.cyr, has: c.has }; }).filter(function (f) { return f.has; }) };
      }).filter(function (g) { return g.fonts.length; });
    }
    const own = userFonts.map(function (u) { return { family: u.family, cyr: true, own: true }; });
    return own.length ? [{ group: 'Свои шрифты', fonts: own }].concat(listCache) : listCache;
  }

  function defaultFont() {
    const groups = available(), pick = function (g) { const f = g && g.fonts.find(function (x) { return x.cyr; }); return f && f.family; };
    return pick(groups.find(function (g) { return g.group === 'Рукописные'; })) || pick(groups.find(function (g) { return g.group === 'С засечками'; })) || 'Georgia';
  }

  // ---------- свои шрифты (файлы TTF, OTF, WOFF) — хранятся в браузере ----------
  const userFonts = []; // { family, name, data: ArrayBuffer }
  function db() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no idb')); return; }
      const r = indexedDB.open('almaz-canvas', 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains('fonts')) r.result.createObjectStore('fonts', { keyPath: 'family' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  async function register(family, data) {
    const face = new FontFace(family, data);
    await face.load();
    document.fonts.add(face);
    if (!userFonts.some(function (u) { return u.family === family; })) userFonts.push({ family: family, data: data });
  }
  async function loadUserFonts() {
    try {
      const d = await db();
      const all = await new Promise(function (resolve, reject) {
        const q = d.transaction('fonts', 'readonly').objectStore('fonts').getAll();
        q.onsuccess = function () { resolve(q.result || []); };
        q.onerror = function () { reject(q.error); };
      });
      for (const f of all) { try { await register(f.family, f.data); } catch (e) { /* испорченный файл — пропускаем */ } }
    } catch (e) { /* хранилище недоступно — свои шрифты только до перезагрузки */ }
    return userFonts.length;
  }
  /* Файл шрифта → имя семейства (по имени файла). */
  async function addUserFont(file) {
    if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw Object.assign(new Error('type'), { code: 'type' });
    if (file.size > 15e6) throw Object.assign(new Error('big'), { code: 'big' });
    const data = await file.arrayBuffer();
    let family = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().slice(0, 40) || 'Мой шрифт';
    if (FONTS.some(function (g) { return g[1].indexOf(family) >= 0; })) family += ' (файл)';
    await register(family, data.slice(0));
    try {
      const d = await db();
      d.transaction('fonts', 'readwrite').objectStore('fonts').put({ family: family, data: data });
    } catch (e) { /* не запомнится */ }
    return family;
  }
  /* Шрифт из файла проекта (base64). */
  async function addFontData(family, b64) {
    if (userFonts.some(function (u) { return u.family === family; })) return;
    const bin = atob(b64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    await register(family, data.buffer);
  }
  function fontData(family) {
    const u = userFonts.find(function (x) { return x.family === family; });
    if (!u) return null;
    const b = new Uint8Array(u.data);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------- стили ----------
  const FILLS = {
    gold: ['#7a5a12', '#e8c766', '#fff2bf', '#c99a2e', '#8f6a17'],
    silver: ['#6c6c6c', '#d9d9d9', '#ffffff', '#a6a6a6', '#707070'],
    rose: ['#8a4b3c', '#e8a996', '#ffe3d8', '#c97f6b', '#8a4b3c']
  };

  function newLayer(text) {
    return {
      text: text || '', font: defaultFont(), size: 4, bold: false, italic: false,
      fill: 'color', color: '#ffffff', opacity: 100, align: 'center', spacing: 0, lineH: 1.15, rot: 0,
      shadow: { on: true, color: '#000000', alpha: 60, blur: 1.5, dx: 0.5, dy: 0.7 },
      outline: { on: false, color: '#000000', width: 0.6 },
      plate: { on: false, color: '#ffffff', alpha: 80, pad: 6, radius: 3 },
      x: 0.5, y: 0.85
    };
  }

  /* Готовые стили: меняют оформление, текст и шрифт остаются. */
  const PRESETS = {
    'white': { fill: 'color', color: '#ffffff', shadow: { on: true, color: '#000000', alpha: 60, blur: 1.5, dx: 0.5, dy: 0.7 }, outline: { on: false }, plate: { on: false } },
    'black': { fill: 'color', color: '#151515', shadow: { on: false }, outline: { on: false }, plate: { on: false } },
    'gold': { fill: 'gold', shadow: { on: true, color: '#2a1a00', alpha: 55, blur: 1.2, dx: 0.4, dy: 0.6 }, outline: { on: false }, plate: { on: false } },
    'silver': { fill: 'silver', shadow: { on: true, color: '#000000', alpha: 50, blur: 1.2, dx: 0.4, dy: 0.6 }, outline: { on: false }, plate: { on: false } },
    'outline': { fill: 'color', color: '#ffffff', shadow: { on: false }, outline: { on: true, color: '#111111', width: 0.7 }, plate: { on: false } },
    'plate': { fill: 'color', color: '#1d1d1d', shadow: { on: false }, outline: { on: false }, plate: { on: true, color: '#ffffff', alpha: 82, pad: 6, radius: 3 } }
  };
  function applyPreset(L, id) {
    const p = PRESETS[id];
    if (!p) return;
    ['fill', 'color'].forEach(function (k) { if (p[k] !== undefined) L[k] = p[k]; });
    ['shadow', 'outline', 'plate'].forEach(function (k) { L[k] = Object.assign({}, L[k], p[k]); });
  }

  // ---------- размеры и рисование ----------
  function rgba(hex, alpha) {
    const n = parseInt(String(hex).slice(1), 16) || 0;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + (alpha / 100) + ')';
  }

  function setFont(ctx, L, px) {
    ctx.font = (L.italic ? 'italic ' : '') + (L.bold ? 'bold ' : '') + px.toFixed(2) + 'px "' + L.font + '", Georgia, serif';
    if ('letterSpacing' in ctx) ctx.letterSpacing = ((L.spacing || 0) * px / 100).toFixed(2) + 'px';
  }

  /* Строки и размеры блока текста в точках (без поворота). */
  function measure(ctx, L, ppc) {
    const px = Math.max(1, L.size * ppc);
    setFont(ctx, L, px);
    const lines = String(L.text || '').split('\n').slice(0, 12);
    const m0 = ctx.measureText('ЁЙHgjy');
    const asc = m0.fontBoundingBoxAscent || px * 0.8, desc = m0.fontBoundingBoxDescent || px * 0.25;
    const lh = px * (L.lineH || 1.15);
    const ws = lines.map(function (t) { return ctx.measureText(t).width; });
    const w = Math.max(px * 0.3, Math.max.apply(null, ws));
    const h = (lines.length - 1) * lh + asc + desc;
    return { px: px, lines: lines, ws: ws, w: w, h: h, asc: asc, lh: lh };
  }

  /* Прямоугольник слоя с подложкой и контуром: центр, ширина, высота (точки), угол — для выбора мышью. */
  function box(ctx, L, ppc, cx, cy) {
    const m = measure(ctx, L, ppc), pad = L.plate && L.plate.on ? (L.plate.pad / 10) * ppc : 0, ol = L.outline && L.outline.on ? (L.outline.width / 10) * ppc : 0;
    return { cx: cx, cy: cy, w: m.w + 2 * (pad + ol), h: m.h + 2 * (pad + ol), rot: ((L.rot || 0) * Math.PI) / 180 };
  }

  function hit(b, x, y) {
    const c = Math.cos(-b.rot), s = Math.sin(-b.rot), dx = x - b.cx, dy = y - b.cy;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }

  /* Углы прямоугольника после поворота — проверка, не заходит ли надпись на сгиб. */
  function corners(b) {
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(function (k) {
      const x = (k[0] * b.w) / 2, y = (k[1] * b.h) / 2;
      return { x: b.cx + x * c - y * s, y: b.cy + x * s + y * c };
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* Нарисовать слой с центром в (cx, cy) точек; ppc — точек на сантиметр. */
  function draw(ctx, L, ppc, cx, cy) {
    if (!String(L.text || '').trim()) return;
    const m = measure(ctx, L, ppc), mm = ppc / 10;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(((L.rot || 0) * Math.PI) / 180);
    ctx.globalAlpha = Math.max(0, Math.min(1, (L.opacity == null ? 100 : L.opacity) / 100));
    const top = -m.h / 2, left = -m.w / 2;
    if (L.plate && L.plate.on) {
      const pad = L.plate.pad * mm;
      ctx.fillStyle = rgba(L.plate.color, L.plate.alpha);
      roundRect(ctx, left - pad, top - pad, m.w + 2 * pad, m.h + 2 * pad, L.plate.radius * mm);
      ctx.fill();
    }
    setFont(ctx, L, m.px);
    ctx.textAlign = L.align === 'left' ? 'left' : L.align === 'right' ? 'right' : 'center';
    ctx.textBaseline = 'alphabetic';
    const ax = L.align === 'left' ? left : L.align === 'right' ? -left : 0;
    if (FILLS[L.fill]) {
      const g = ctx.createLinearGradient(0, top, 0, top + m.h), st = FILLS[L.fill];
      st.forEach(function (c, i) { g.addColorStop(i / (st.length - 1), c); });
      ctx.fillStyle = g;
    } else ctx.fillStyle = L.color;
    const shadow = function (on) {
      if (on && L.shadow && L.shadow.on) {
        ctx.shadowColor = rgba(L.shadow.color, L.shadow.alpha);
        ctx.shadowBlur = L.shadow.blur * mm;
        ctx.shadowOffsetX = L.shadow.dx * mm;
        ctx.shadowOffsetY = L.shadow.dy * mm;
      } else { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
    };
    const each = function (fn) { m.lines.forEach(function (t, i) { fn(t, ax, top + m.asc + i * m.lh); }); };
    if (L.outline && L.outline.on && L.outline.width > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = 2 * L.outline.width * mm; // половина линии под буквой — снаружи остаётся ровно width
      ctx.strokeStyle = L.outline.color;
      shadow(true);
      each(function (t, x, y) { ctx.strokeText(t, x, y); });
      shadow(false);
      each(function (t, x, y) { ctx.fillText(t, x, y); });
    } else {
      shadow(true);
      each(function (t, x, y) { ctx.fillText(t, x, y); });
    }
    ctx.restore();
  }

  A.canvasText = {
    FILLS: FILLS, PRESETS: PRESETS, available: available, defaultFont: defaultFont, newLayer: newLayer, applyPreset: applyPreset,
    measure: measure, box: box, hit: hit, corners: corners, draw: draw, roundRect: roundRect,
    loadUserFonts: loadUserFonts, addUserFont: addUserFont, addFontData: addFontData, fontData: fontData,
    isUserFont: function (f) { return userFonts.some(function (u) { return u.family === f; }); },
    resetCache: function () { listCache = null; }
  };
})(window.ALMAZ = window.ALMAZ || {});
