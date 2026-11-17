/* Чтение номеров DMC и значков из легенды схемы программы — для вкладыша и этикеток, где нужен
 * текст. Без внешних библиотек: каждая цифра (значок) сравнивается с образцами, нарисованными
 * шрифтами, которыми пишет программа; номер сверяется со списком номеров DMC. Что прочитано
 * неуверенно, помечается — пользователь проверяет и исправляет. */
(function (A) {
  'use strict';

  const GW = 16, GH = 24; // размер, к которому приводится каждая буква
  const FONTS = ['Verdana', 'Tahoma', 'Arial', 'Segoe UI', 'Helvetica', 'sans-serif'];
  const DIGITS = '0123456789';
  const SYMBOLS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-=*#%&@<>?!/×'.split('');

  /* Кусок картинки → яркость (0…255). */
  function grayOf(src, r) {
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1, cv = A.makeCanvas(w, h), x = cv.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, w, h);
    x.drawImage(src, r.x0, r.y0, w, h, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    cv.width = cv.height = 0;
    return { g: g, w: w, h: h };
  }

  /* Маска «чернил» → рамка и уменьшенная до GW×GH копия (доля чернил в ячейке). */
  function norm(ink, w, x0, y0, x1, y1) {
    const out = new Float32Array(GW * GH), bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const sx0 = x0 + (gx * bw) / GW, sx1 = x0 + ((gx + 1) * bw) / GW, sy0 = y0 + (gy * bh) / GH, sy1 = y0 + ((gy + 1) * bh) / GH;
      let s = 0, n = 0;
      for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++) for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) { s += ink[y * w + x]; n++; }
      out[gy * GW + gx] = s / n;
    }
    return { m: out, aspect: bw / bh, h: bh };
  }

  function bbox(ink, w, h, x0, x1) {
    let a = x1, b = h - 1, c = x0, d = 0, any = false;
    for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (ink[y * w + x]) { any = true; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    return any ? { x0: a, y0: b, x1: c, y1: d } : null;
  }

  /* Образец буквы в шрифте: рисуем крупно и приводим к GW×GH. */
  const cache = new Map();
  function template(ch, font, bold) {
    const key = ch + '|' + font + '|' + (bold ? 1 : 0);
    if (cache.has(key)) return cache.get(key);
    const S = 96, cv = A.makeCanvas(S * 2, S * 2), x = cv.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, cv.width, cv.height);
    x.fillStyle = '#000000';
    x.font = (bold ? 'bold ' : '') + S + 'px "' + font + '", sans-serif';
    x.textBaseline = 'middle';
    x.fillText(ch, S * 0.4, S);
    const d = x.getImageData(0, 0, cv.width, cv.height).data, ink = new Uint8Array(cv.width * cv.height);
    for (let i = 0, p = 0; p < ink.length; i += 4, p++) ink[p] = d[i] < 128 ? 1 : 0;
    const b = bbox(ink, cv.width, cv.height, 0, cv.width - 1);
    const t = b ? norm(ink, cv.width, b.x0, b.y0, b.x1, b.y1) : null;
    cv.width = cv.height = 0;
    cache.set(key, t);
    return t;
  }

  function dist(a, t) {
    let s = 0;
    for (let i = 0; i < a.m.length; i++) { const q = a.m[i] - t.m[i]; s += q * q; }
    return s / a.m.length + 0.6 * Math.abs(Math.log(a.aspect / t.aspect)); // форма + пропорции
  }

  /* Цифры номера: столбцы с чернилами, разделённые пустыми. */
  function glyphsOfCode(src, r) {
    const im = grayOf(src, r), ink = new Uint8Array(im.g.length);
    for (let i = 0; i < ink.length; i++) ink[i] = im.g[i] < 140 ? 1 : 0;
    const out = [];
    let s0 = -1;
    for (let x = 0; x <= im.w; x++) {
      let col = false;
      if (x < im.w) for (let y = 0; y < im.h; y++) if (ink[y * im.w + x]) { col = true; break; }
      if (col && s0 < 0) s0 = x;
      else if (!col && s0 >= 0) { const b = bbox(ink, im.w, im.h, s0, x - 1); if (b && b.y1 - b.y0 >= im.h * 0.4) out.push(norm(ink, im.w, b.x0, b.y0, b.x1, b.y1)); s0 = -1; }
    }
    return out;
  }

  /* Значок в квадратике: точки, заметно отличающиеся от заливки квадратика. */
  function glyphOfSquare(src, r) {
    const pad = Math.max(3, Math.round((r.x1 - r.x0) * 0.1)), im = grayOf(src, { x0: r.x0 + pad, y0: r.y0 + pad, x1: r.x1 - pad, y1: r.y1 - pad });
    const hist = new Uint32Array(256);
    im.g.forEach(function (v) { hist[v]++; });
    let acc = 0, med = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= im.g.length) { med = v; break; } }
    const ink = new Uint8Array(im.g.length);
    for (let i = 0; i < ink.length; i++) ink[i] = Math.abs(im.g[i] - med) > 55 ? 1 : 0;
    const b = bbox(ink, im.w, im.h, 0, im.w - 1);
    return b ? norm(ink, im.w, b.x0, b.y0, b.x1, b.y1) : null;
  }

  function best(glyph, chars, font, bold) {
    let bc = '', bd = Infinity, second = Infinity;
    chars.forEach(function (ch) {
      const t = template(ch, font, bold);
      if (!t) return;
      const d = dist(glyph, t);
      if (d < bd) { second = bd; bd = d; bc = ch; } else if (d < second) second = d;
    });
    return { ch: bc, d: bd, margin: second - bd };
  }

  /* Ближайший настоящий номер DMC той же длины, если прочитанного нет в списке. */
  function nearestCode(glyphs, codes, font, bold) {
    let bc = null, bd = Infinity;
    codes.forEach(function (code) {
      if (code.length !== glyphs.length || !/^\d+$/.test(code)) return;
      let s = 0;
      for (let i = 0; i < glyphs.length; i++) s += dist(glyphs[i], template(code[i], font, bold));
      if (s < bd) { bd = s; bc = code; }
    });
    return bc;
  }

  /* rows: [{ sq, code }] (схема программы); src — картинка схемы. → [{ code, symbol, sure }]. */
  function read(src, rows) {
    const codes = new Set(String(A.DMC_RAW || '').trim().split(/\s+/).map(function (p) { return p.split(':')[0]; }));
    const codeGlyphs = rows.map(function (r) { return glyphsOfCode(src, r.code); });
    const symGlyphs = rows.map(function (r) { return glyphOfSquare(src, r.sq); });
    // шрифт программы — тот, что лучше всего объясняет все цифры
    let font = FONTS[0], bold = false, fs = Infinity;
    FONTS.forEach(function (f) {
      [false, true].forEach(function (b) {
        let s = 0;
        codeGlyphs.forEach(function (gs) { gs.forEach(function (g) { s += best(g, DIGITS.split(''), f, b).d; }); });
        if (s < fs) { fs = s; font = f; bold = b; }
      });
    });
    let sfont = font, sbold = bold, ss = Infinity;
    FONTS.forEach(function (f) {
      [false, true].forEach(function (b) {
        let s = 0;
        symGlyphs.forEach(function (g) { if (g) s += best(g, SYMBOLS, f, b).d; });
        if (s < ss) { ss = s; sfont = f; sbold = b; }
      });
    });
    return rows.map(function (r, i) {
      const gs = codeGlyphs[i];
      let code = '', sure = gs.length > 0;
      gs.forEach(function (g) { const m = best(g, DIGITS.split(''), font, bold); code += m.ch; if (m.margin < 0.01) sure = false; });
      if (!codes.has(code)) { const near = nearestCode(gs, codes, font, bold); if (near) code = near; sure = false; }
      const sg = symGlyphs[i];
      const sm = sg ? best(sg, SYMBOLS, sfont, sbold) : { ch: '', margin: 0 };
      return { code: code, symbol: sm.ch, sure: sure, symSure: !!sg && sm.margin > 0.008 };
    });
  }

  A.schemeOcr = { read: read };
})(window.ALMAZ = window.ALMAZ || {});
