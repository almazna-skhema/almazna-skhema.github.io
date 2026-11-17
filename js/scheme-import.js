/* Схема из программы «Алмазная мозаика 2.0» («Схема для печати.png»): сетка слева, справа легенда
 * строками «квадратик со значком — номер DMC — штуки, граммы». Находим сетку (общим разбором
 * layoutScan) и в легенде — квадратик и номер каждой строки, чтобы перенести их на наш макет
 * картинками, точка в точку, без распознавания текста. */
(function (A) {
  'use strict';

  const INK = 150; // темнее — чернила (рамка квадратика, цифры)

  /* g — яркость (layoutScan.grayPlane), grid — layoutScan.findGrid.
   * Возвращает строки легенды [{ sq: {x0,y0,x1,y1}, code: {x0,y0,x1,y1} }] в порядке чтения. */
  function findLegend(g, W, H, grid) {
    const gx1 = Math.round(grid.xs[grid.cols] + grid.pitch * 0.6);
    if (gx1 >= W - 20) return [];
    // полосы строк: подряд идущие строки точек, где справа от сетки есть чернила
    const bands = [];
    let b0 = -1;
    for (let y = 0; y <= H; y++) {
      let ink = false;
      if (y < H) { const r = y * W; for (let x = gx1; x < W; x++) if (g[r + x] < INK) { ink = true; break; } }
      if (ink && b0 < 0) b0 = y;
      else if (!ink && b0 >= 0) { if (y - b0 >= 6) bands.push([b0, y - 1]); b0 = -1; }
    }
    const rows = [];
    bands.forEach(function (bd) {
      const y0 = bd[0], y1 = bd[1], bh = y1 - y0 + 1;
      // отрезки чернил по горизонтали; пробел шире трети высоты строки разделяет слова
      const col = new Uint8Array(W - gx1);
      for (let y = y0; y <= y1; y++) { const r = y * W; for (let x = gx1; x < W; x++) if (g[r + x] < INK) col[x - gx1] = 1; }
      const gapMin = Math.max(6, bh * 0.45), segs = [];
      let s0 = -1, last = -1;
      for (let i = 0; i < col.length; i++) {
        if (!col[i]) continue;
        if (s0 < 0) s0 = i;
        else if (i - last > gapMin) { segs.push([s0 + gx1, last + gx1]); s0 = i; }
        last = i;
      }
      if (s0 >= 0) segs.push([s0 + gx1, last + gx1]);
      for (let k = 0; k + 1 < segs.length; k++) {
        const sq = tight(g, W, segs[k][0], y0, segs[k][1], y1);
        const sw = sq.x1 - sq.x0 + 1, sh = sq.y1 - sq.y0 + 1;
        if (sw < 8 || Math.abs(sw - sh) > Math.max(3, sw * 0.18) || !boxed(g, W, sq)) continue; // не квадратик в рамке
        const code = tight(g, W, segs[k + 1][0], y0, segs[k + 1][1], y1);
        rows.push({ sq: sq, code: code });
        k++;
      }
    });
    if (rows.length < 2) return rows;
    // столбцы легенды (если программа разбила длинную легенду) — по левому краю квадратика
    const size = median(rows.map(function (r) { return r.sq.x1 - r.sq.x0 + 1; }));
    const ok = rows.filter(function (r) { return Math.abs(r.sq.x1 - r.sq.x0 + 1 - size) <= Math.max(3, size * 0.15); });
    ok.sort(function (a, b) { return Math.abs(a.sq.x0 - b.sq.x0) > size ? a.sq.x0 - b.sq.x0 : a.sq.y0 - b.sq.y0; });
    return ok;
  }

  function median(a) { const s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }

  /* Плотная рамка вокруг чернил в прямоугольнике. */
  function tight(g, W, x0, y0, x1, y1) {
    let a = x1, b = y1, c = x0, d = y0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (g[y * W + x] < INK) {
      if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y;
    }
    return { x0: a, y0: b, x1: c, y1: d };
  }

  /* У квадратика легенды тёмная рамка: тёмные точки почти по всему периметру. */
  function boxed(g, W, r) {
    let n = 0, dark = 0;
    for (let x = r.x0; x <= r.x1; x++) { n += 2; if (g[r.y0 * W + x] < 200) dark++; if (g[r.y1 * W + x] < 200) dark++; }
    for (let y = r.y0; y <= r.y1; y++) { n += 2; if (g[y * W + r.x0] < 200) dark++; if (g[y * W + r.x1] < 200) dark++; }
    return dark >= n * 0.8;
  }

  /* Кусок картинки в отдельный холст. */
  function crop(src, r, pad) {
    pad = pad || 0;
    const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad);
    const w = Math.min((src.width || src.naturalWidth) - x0, r.x1 - r.x0 + 1 + pad * 2), h = Math.min((src.height || src.naturalHeight) - y0, r.y1 - r.y0 + 1 + pad * 2);
    const cv = A.makeCanvas(w, h);
    cv.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, w, h);
    return cv;
  }

  /* Маленькая «картинка» схемы: цвет середины каждой клетки — для миниатюры и фона, если нет исходного фото. */
  function cellColors(dec, grid) {
    const f = dec.frame, c = f.comps, W = f.width, cv = A.makeCanvas(grid.cols, grid.rows), x = cv.getContext('2d');
    const im = x.createImageData(grid.cols, grid.rows), d = im.data;
    for (let j = 0; j < grid.rows; j++) for (let i = 0; i < grid.cols; i++) {
      // фон клетки — у самого края внутри, чтобы не попасть в значок
      const px = Math.round(grid.xs[i] + grid.pitch * 0.2), py = Math.round(grid.ys[j] + grid.pitch * 0.2), p = py * W + px, o = (j * grid.cols + i) * 4;
      d[o] = c[0].plane[p]; d[o + 1] = c[1].plane[p]; d[o + 2] = c[2].plane[p]; d[o + 3] = 255;
    }
    x.putImageData(im, 0, 0);
    return cv;
  }

  A.schemeImport = { findLegend: findLegend, crop: crop, cellColors: cellColors };
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
