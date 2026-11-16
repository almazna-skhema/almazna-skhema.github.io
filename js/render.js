/* Отрисовка: вид мозаики, схема для печати, легенда, макет. */
(function (A) {
  'use strict';

  const FONT = 'Arial, Helvetica, sans-serif';
  const MARGIN_MM = 50; // поля макета вокруг схемы (как в образце: 40x50 на листе 50x60)

  function shade(c, k) {
    let r = c.r, g = c.g, b = c.b;
    if (k <= 1) { r *= k; g *= k; b *= k; } else {
      const t = k - 1;
      r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t;
    }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }

  function poly(x, pts, fill) {
    x.beginPath();
    x.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
    x.closePath();
    x.fillStyle = fill;
    x.fill();
  }

  // ---------- вид мозаики ----------
  function stoneSprite(c, s, shape) {
    const cv = A.makeCanvas(s, s), x = cv.getContext('2d');
    if (shape === 'round') {
      x.fillStyle = '#cfd3da';
      x.fillRect(0, 0, s, s);
      const g = x.createRadialGradient(s * 0.36, s * 0.34, s * 0.04, s / 2, s / 2, s * 0.48);
      g.addColorStop(0, shade(c, 1.4));
      g.addColorStop(0.45, c.hex);
      g.addColorStop(1, shade(c, 0.66));
      x.fillStyle = g;
      x.beginPath();
      x.arc(s / 2, s / 2, s * 0.47, 0, Math.PI * 2);
      x.fill();
      return cv;
    }
    if (s < 5) {
      x.fillStyle = c.hex;
      x.fillRect(0, 0, s, s);
      return cv;
    }
    x.fillStyle = shade(c, 0.74);
    x.fillRect(0, 0, s, s);
    const gap = Math.max(0.5, s * 0.05), f = s * 0.22, a = gap, b = s - gap;
    poly(x, [[a, a], [b, a], [b - f, a + f], [a + f, a + f]], shade(c, 1.3));
    poly(x, [[a, a], [a + f, a + f], [a + f, b - f], [a, b]], shade(c, 1.13));
    poly(x, [[b, a], [b, b], [b - f, b - f], [b - f, a + f]], shade(c, 0.85));
    poly(x, [[a, b], [a + f, b - f], [b - f, b - f], [b, b]], shade(c, 0.7));
    x.fillStyle = c.hex;
    x.fillRect(a + f, a + f, b - a - 2 * f, b - a - 2 * f);
    return cv;
  }

  function drawCells(res, s, sprites) {
    const cv = A.makeCanvas(res.cols * s, res.rows * s), x = cv.getContext('2d');
    const cells = res.cells, cols = res.cols;
    for (let i = 0; i < cells.length; i++) x.drawImage(sprites[cells[i]], (i % cols) * s, ((i / cols) | 0) * s);
    return cv;
  }

  /* Для подсветки одного цвета: остальные цвета становятся бледными. */
  function withHighlight(colors, highlight) {
    if (typeof highlight !== 'number' || highlight < 0) return colors;
    return colors.map(function (c, i) {
      if (i === highlight) return c;
      const r = Math.round(c.r + (255 - c.r) * 0.86), g = Math.round(c.g + (255 - c.g) * 0.86), b = Math.round(c.b + (255 - c.b) * 0.86);
      return { r: r, g: g, b: b, hex: 'rgb(' + r + ',' + g + ',' + b + ')', symbol: c.symbol, dark: false, faint: true };
    });
  }

  function renderMosaic(res, cellPx, shape, highlight) {
    return drawCells(res, cellPx, withHighlight(res.colors, highlight).map(function (c) { return stoneSprite(c, cellPx, shape); }));
  }

  // ---------- схема для печати ----------
  function drawSymbol(x, c, cx, cy, size) {
    x.font = 'bold ' + Math.round(size) + 'px ' + FONT;
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    const m = x.measureText(c.symbol);
    const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    x.fillStyle = c.faint ? '#c4c4c4' : c.dark ? '#ffffff' : '#000000';
    x.fillText(c.symbol, cx, cy + dy);
  }

  function symbolSprite(c, s, shape) {
    const cv = A.makeCanvas(s, s), x = cv.getContext('2d');
    if (shape === 'round') {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, s, s);
      x.fillStyle = c.hex;
      x.beginPath();
      x.arc(s / 2, s / 2, s * 0.47, 0, Math.PI * 2);
      x.fill();
    } else {
      x.fillStyle = c.hex;
      x.fillRect(0, 0, s, s);
    }
    if (s >= 9) drawSymbol(x, c, s / 2, s / 2, s * 0.66);
    return cv;
  }

  function renderScheme(res, cellPx, shape, highlight) {
    const s = cellPx;
    const cv = drawCells(res, s, withHighlight(res.colors, highlight).map(function (c) { return symbolSprite(c, s, shape); }));
    const x = cv.getContext('2d'), W = cv.width, H = cv.height;
    if (s >= 6) {
      const big = s >= 16; // на мелком предпросмотре линии делаем легче, иначе они забивают картинку
      const lw = Math.max(1, Math.round(s / 30));
      x.fillStyle = big ? '#8a8a8a' : 'rgba(0,0,0,0.22)';
      for (let i = 1; i < res.cols; i++) if (i % 10) x.fillRect(i * s - (lw >> 1), 0, lw, H);
      for (let j = 1; j < res.rows; j++) if (j % 10) x.fillRect(0, j * s - (lw >> 1), W, lw);
      // каждая десятая линия — жирная, с белой подложкой, чтобы читалась на тёмном
      const bw = Math.max(1, Math.round(s * 0.08)), hw = bw + 2 * Math.max(1, Math.round(s * 0.035));
      (big ? [['#ffffff', hw], ['#000000', bw]] : [['#000000', bw]]).forEach(function (p) {
        x.fillStyle = p[0];
        for (let i = 10; i < res.cols; i += 10) x.fillRect(Math.round(i * s - p[1] / 2), 0, p[1], H);
        for (let j = 10; j < res.rows; j += 10) x.fillRect(0, Math.round(j * s - p[1] / 2), W, p[1]);
      });
      x.strokeStyle = '#000000';
      x.lineWidth = bw;
      x.strokeRect(bw / 2, bw / 2, W - bw, H - bw);
    }
    return cv;
  }

  // ---------- легенда ----------
  function grams(count, gramPerStone) {
    return Math.max(1, Math.ceil(count * gramPerStone - 1e-9));
  }

  function fmt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  }

  function sizeLabel(meta) {
    return meta.wCm + '×' + meta.hCm + ' см';
  }

  function stoneLabel(meta) {
    const p = String(meta.pitch).replace('.', ',');
    return meta.shape === 'round' ? 'круглых страз ' + p + ' мм' : 'страз размера ' + p + ' × ' + p + ' мм';
  }

  function renderLegend(res, meta) {
    const K = 2; // масштаб для чёткости
    const colors = res.colors, n = colors.length;
    const W = 1100, pad = 48, rowH = 40, headH = 34, gap = 56;
    const cc = n > 26 ? 2 : 1;
    const perCol = Math.ceil(n / cc);
    const colW = (W - pad * 2 - gap * (cc - 1)) / cc;
    const hasSub = !!(meta.article || meta.title);
    const top = pad + 34 + (hasSub ? 26 : 0) + 22;
    const tableH = headH + perCol * rowH;
    const H = top + tableH + 26 + 30 + 18 + 40 + pad;

    const cv = A.makeCanvas(W * K, H * K), x = cv.getContext('2d');
    x.scale(K, K);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);

    x.fillStyle = '#111111';
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    x.font = 'bold 22px ' + FONT;
    x.fillText('Легенда для схемы размером ' + sizeLabel(meta) + '* (' + res.cols + '×' + res.rows + ' страз) из ' + n + ' цветов', pad, pad + 22, W - pad * 2);
    if (hasSub) {
      x.font = '16px ' + FONT;
      x.fillStyle = '#555555';
      x.fillText([meta.article, meta.title ? '«' + meta.title + '»' : ''].filter(Boolean).join('  '), pad, pad + 50, W - pad * 2);
    }

    let total = 0, totalG = 0;
    for (let col = 0; col < cc; col++) {
      const x0 = pad + col * (colW + gap);
      const xCode = x0 + 52, xCount = x0 + colW * 0.7, xW = x0 + colW;
      x.font = 'bold 12px ' + FONT;
      x.fillStyle = '#666666';
      x.textAlign = 'left';
      x.fillText('ЗНАЧОК', x0, top + 20);
      x.fillText('НОМЕР DMC', xCode, top + 20);
      x.textAlign = 'right';
      x.fillText('ЧИСЛО СТРАЗ', xCount, top + 20);
      x.fillText('ВЕС, г*', xW, top + 20);
      x.fillStyle = '#111111';
      x.fillRect(x0, top + headH - 2, colW, 2);

      for (let r = 0; r < perCol; r++) {
        const c = colors[col * perCol + r];
        if (!c) break;
        const y = top + headH + r * rowH;
        if (r % 2) { x.fillStyle = '#f4f5f7'; x.fillRect(x0, y, colW, rowH); }
        x.fillStyle = c.hex;
        x.fillRect(x0 + 4, y + 5, 30, 30);
        x.strokeStyle = '#333333';
        x.lineWidth = 1;
        x.strokeRect(x0 + 4.5, y + 5.5, 29, 29);
        drawSymbol(x, c, x0 + 19, y + 20, 20);
        const g = grams(c.count, meta.gramPerStone);
        total += c.count; totalG += g;
        x.fillStyle = '#111111';
        x.textAlign = 'left';
        x.font = 'bold 17px ' + FONT;
        x.fillText('—  ' + c.code, xCode, y + 26);
        x.font = '17px ' + FONT;
        x.textAlign = 'right';
        x.fillText(fmt(c.count), xCount, y + 26);
        x.fillText(g + ' г', xW, y + 26);
      }
    }

    let y = top + tableH + 26;
    x.fillStyle = '#111111';
    x.fillRect(pad, y - 22, W - pad * 2, 1);
    x.textAlign = 'left';
    x.font = 'bold 17px ' + FONT;
    x.fillText('Всего: ' + fmt(total) + ' страз, около ' + fmt(totalG) + ' г', pad, y + 6);
    y += 48;
    x.font = '13px ' + FONT;
    x.fillStyle = '#555555';
    x.fillText('* Размер схемы в см и вес страз каждого цвета указаны ориентировочно для ' + stoneLabel(meta) + '.', pad, y);
    x.fillText('Вес округлён вверх до целого грамма, из расчёта ' + String(meta.gramPerStone).replace('.', ',') + ' г на одну стразу.', pad, y + 20);
    return cv;
  }

  /* Ячейка CSV: значения, которые Excel принял бы за формулу (= + - @), получают
   * пробел в начале; поля с «;», кавычками и переводами строк берутся в кавычки. */
  function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = ' ' + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function legendCsv(res, meta) {
    const rows = ['Значок;Номер DMC;Число страз;Вес, г'];
    res.colors.forEach(function (c) {
      rows.push([c.symbol, c.code, c.count, grams(c.count, meta.gramPerStone)].map(csvCell).join(';'));
    });
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }

  // ---------- макет ----------
  function roundRect(x, l, t, w, h, r) {
    x.beginPath();
    x.moveTo(l + r, t);
    x.lineTo(l + w, t);
    x.lineTo(l + w, t + h);
    x.lineTo(l + r, t + h);
    x.arcTo(l, t + h, l, t + h - r, r);
    x.lineTo(l, t + r);
    x.arcTo(l, t, l + r, t, r);
    x.closePath();
  }

  /* meta: wCm, hCm, pitch, shape, article, title, urls[], logo (Image|null), focusX, focusY
   * src — исходная картинка (или null), scheme — готовый холст схемы с тем же cellPx */
  function renderLayout(res, meta, src, cellPx, scheme) {
    const pxmm = cellPx / meta.pitch;
    const mm = function (v) { return v * pxmm; };
    const M = Math.round(mm(MARGIN_MM));
    const sw = res.cols * cellPx, sh = res.rows * cellPx;
    const W = sw + M * 2, H = sh + M * 2;
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d');

    // фон — размытая исходная картинка на весь лист
    x.fillStyle = '#2b3a55';
    x.fillRect(0, 0, W, H);
    if (src) {
      const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
      const bw = 40, bh = Math.max(2, Math.round((bw * H) / W));
      const tiny = A.downscale(src, A.cropRect(iw, ih, W, H, 0.5, 0.5), bw, bh);
      const mid = A.makeCanvas(bw * 8, bh * 8), mc = mid.getContext('2d');
      mc.imageSmoothingEnabled = true;
      mc.imageSmoothingQuality = 'high';
      mc.drawImage(tiny, 0, 0, mid.width, mid.height);
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(mid, 0, 0, W, H);
      x.fillStyle = 'rgba(12,20,40,0.16)';
      x.fillRect(0, 0, W, H);
    }

    // схема и тонкая белая рамка вокруг
    x.drawImage(scheme, M, M, sw, sh);
    x.strokeStyle = '#ffffff';
    x.lineWidth = Math.max(1, mm(0.35));
    const fo = mm(1.2);
    x.strokeRect(M - fo, M - fo, sw + fo * 2, sh + fo * 2);

    // шапка: артикул и размер, название, миниатюра, адреса
    const blocks = [];
    const fs = mm(5);
    const boldFont = function (size) { return 'bold ' + Math.max(6, Math.round(size)) + 'px ' + FONT; };
    const textBlock = function (lines, size) {
      x.font = boldFont(size);
      let w = 0;
      lines.forEach(function (l) { w = Math.max(w, x.measureText(l).width); });
      return { type: 'text', lines: lines, size: size, w: w };
    };
    const left = [];
    if (meta.article) left.push(meta.article);
    left.push(meta.wCm + 'x' + meta.hCm + 'см');
    blocks.push(textBlock(left, fs));
    if (meta.title) blocks.push(textBlock(['«' + meta.title + '»'], fs));
    const thumbH = mm(20);
    if (src) blocks.push({ type: 'thumb', w: (thumbH * res.cols) / res.rows });
    if (meta.urls && meta.urls.length) blocks.push(textBlock(meta.urls.slice(0, 3), fs * 0.95)); // больше трёх строк в поле шапки не помещается

    const gapX = mm(7);
    let totalW = gapX * (blocks.length - 1);
    blocks.forEach(function (b) { totalW += b.w; });
    const k = Math.min(1, (W - mm(16)) / totalW); // если не помещается — ужимаем
    const cy = mm(14);
    let bx = (W - totalW * k) / 2;
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.65)';
    x.shadowBlur = mm(1.4);
    blocks.forEach(function (b) {
      if (b.type === 'thumb') {
        const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
        const r = A.cropRect(iw, ih, res.cols, res.rows, meta.focusX, meta.focusY);
        const th = thumbH * k, tw = b.w * k;
        x.drawImage(src, r.x, r.y, r.w, r.h, bx, cy - th / 2, tw, th);
        x.shadowColor = 'transparent';
        x.strokeStyle = '#ffffff';
        x.lineWidth = Math.max(1, mm(0.3));
        x.strokeRect(bx, cy - th / 2, tw, th);
        x.shadowColor = 'rgba(0,0,0,0.65)';
      } else {
        const size = b.size * k, lh = size * 1.3;
        x.font = boldFont(size);
        x.fillStyle = '#ffffff';
        x.textAlign = 'left';
        x.textBaseline = 'middle';
        const y0 = cy - ((b.lines.length - 1) * lh) / 2;
        b.lines.forEach(function (l, i) { x.fillText(l, bx, y0 + i * lh); });
      }
      bx += (b.w + gapX) * k;
    });
    x.restore();

    // легенда DMC у правого края
    const n = res.colors.length;
    const rowH = Math.min(mm(7.5), (H - mm(40)) / (n + 2));
    const codeFont = Math.max(5, Math.round(rowH * 0.5)) + 'px ' + FONT;
    x.font = codeFont;
    let codeW = 0;
    res.colors.forEach(function (c) { codeW = Math.max(codeW, x.measureText(c.code).width); });
    // ширина плашки — по самому длинному номеру, но не шире поля листа
    const boxW = Math.min(M - mm(4), Math.max(rowH * 2.9, rowH * 1.27 + codeW + rowH * 0.45));
    const codeMax = boxW - rowH * 1.27 - rowH * 0.25;
    const boxH = rowH * (n + 1.7);
    const lx = W - boxW, ly = (H - boxH) / 2;
    x.fillStyle = '#ffffff';
    roundRect(x, lx, ly, boxW, boxH, rowH * 0.3);
    x.fill();
    x.fillStyle = '#000000';
    x.textAlign = 'left';
    x.textBaseline = 'middle';
    x.font = boldFont(rowH * 0.56);
    x.fillText('DMC', lx + rowH * 0.35, ly + rowH * 0.75);
    const sq = rowH * 0.62;
    res.colors.forEach(function (c, i) {
      const y = ly + rowH * (1.35 + i);
      const qx = lx + rowH * 0.35, qy = y + (rowH - sq) / 2;
      x.fillStyle = c.hex;
      x.fillRect(qx, qy, sq, sq);
      x.strokeStyle = '#444444';
      x.lineWidth = Math.max(0.5, rowH * 0.02);
      x.strokeRect(qx, qy, sq, sq);
      if (sq >= 7) drawSymbol(x, c, qx + sq / 2, qy + sq / 2, sq * 0.74);
      x.fillStyle = '#000000';
      x.textAlign = 'left';
      x.textBaseline = 'middle';
      x.font = codeFont;
      x.fillText(c.code, qx + sq + rowH * 0.3, y + rowH / 2, codeMax);
    });

    // логотип / QR внизу по центру
    if (meta.logo) {
      const lw = meta.logo.naturalWidth || meta.logo.width, lh = meta.logo.naturalHeight || meta.logo.height;
      const s = Math.min(mm(26) / lh, mm(240) / lw);
      x.drawImage(meta.logo, (W - lw * s) / 2, H - mm(4) - lh * s, lw * s, lh * s);
    }
    return cv;
  }

  /* Сколько клеток занимает лист макета (схема + поля) — для расчёта разрешения. */
  function layoutCells(res, pitch) {
    const m = (MARGIN_MM * 2) / pitch;
    return { cols: res.cols + m, rows: res.rows + m };
  }

  A.MARGIN_MM = MARGIN_MM;
  A.renderMosaic = renderMosaic;
  A.renderScheme = renderScheme;
  A.renderLegend = renderLegend;
  A.legendCsv = legendCsv;
  A.renderLayout = renderLayout;
  A.layoutCells = layoutCells;
  A.grams = grams;
})(window.ALMAZ = window.ALMAZ || {});
