/* Отрисовка: вид мозаики, схема для печати, легенда, макет. */
(function (A) {
  'use strict';

  const T = A.T; // перевод надписи на выбранный язык

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

  /* under — картинка для зон «без страз»: там на холсте остаётся печать, а не стразы. */
  function drawCells(res, s, sprites, under) {
    const cv = A.makeCanvas(res.cols * s, res.rows * s), x = cv.getContext('2d');
    const cells = res.cells, cols = res.cols;
    if (res.empty) {
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, cv.width, cv.height);
      if (under) { x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; x.drawImage(under, 0, 0, cv.width, cv.height); }
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== A.EMPTY_CELL) x.drawImage(sprites[cells[i]], (i % cols) * s, ((i / cols) | 0) * s);
    }
    return cv;
  }

  /* Поверх линий сетки возвращает картинку в клетки «без страз». */
  function patchEmpty(x, res, s, under) {
    if (!res.empty) return;
    const cells = res.cells, cols = res.cols;
    const kx = under ? under.width / (cols * s) : 0, ky = under ? under.height / (res.rows * s) : 0;
    x.fillStyle = '#ffffff';
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== A.EMPTY_CELL) continue;
      const cx = (i % cols) * s, cy = ((i / cols) | 0) * s;
      if (under) x.drawImage(under, cx * kx, cy * ky, s * kx, s * ky, cx, cy, s, s); else x.fillRect(cx, cy, s, s);
    }
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

  function renderMosaic(res, cellPx, shape, highlight, under) {
    return drawCells(res, cellPx, withHighlight(res.colors, highlight).map(function (c) { return stoneSprite(c, cellPx, shape); }), under);
  }

  // ---------- схема для печати ----------
  /* Значки-фигуры рисуем сами, а не шрифтом: так они одинаковые на любом компьютере
   * и заметно крупнее букв. r — половина размера значка. */
  function drawShape(x, sym, cx, cy, r) {
    x.beginPath();
    if (sym === '●') x.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
    else if (sym === '■') x.rect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
    else if (sym === '▲' || sym === '▼') {
      const d = sym === '▲' ? 1 : -1;
      x.moveTo(cx, cy - r * 0.95 * d);
      x.lineTo(cx + r, cy + r * 0.8 * d);
      x.lineTo(cx - r, cy + r * 0.8 * d);
      x.closePath();
    } else if (sym === '◆') {
      x.moveTo(cx, cy - r * 1.08);
      x.lineTo(cx + r * 0.9, cy);
      x.lineTo(cx, cy + r * 1.08);
      x.lineTo(cx - r * 0.9, cy);
      x.closePath();
    } else if (sym === '★') {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, q = i % 2 ? r * 0.46 : r * 1.1;
        x[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * q, cy + r * 0.06 + Math.sin(a) * q);
      }
      x.closePath();
    } else if (sym === '♥') {
      const t = cy - r * 0.38, w = r * 1.02;
      x.moveTo(cx, cy + r * 0.95);
      x.bezierCurveTo(cx - w * 1.5, cy - r * 0.05, cx - w * 0.75, t - r * 0.95, cx, t);
      x.bezierCurveTo(cx + w * 0.75, t - r * 0.95, cx + w * 1.5, cy - r * 0.05, cx, cy + r * 0.95);
      x.closePath();
    } else if (sym === '✚') {
      const a = r * 0.34;
      x.rect(cx - a, cy - r, a * 2, r * 2);
      x.rect(cx - r, cy - a, r * 2, a * 2);
    } else if (sym === '○' || sym === '□') {
      x.lineWidth = r * 0.36;
      x.strokeStyle = x.fillStyle;
      if (sym === '○') x.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
      else x.rect(cx - r * 0.68, cy - r * 0.68, r * 1.36, r * 1.36);
      x.stroke();
      return true;
    } else if (sym === '▶' || sym === '◀') {
      const d = sym === '▶' ? 1 : -1;
      x.moveTo(cx + r * 0.95 * d, cy);
      x.lineTo(cx - r * 0.8 * d, cy - r);
      x.lineTo(cx - r * 0.8 * d, cy + r);
      x.closePath();
    } else if (sym === '◢' || sym === '◣') {
      const d = sym === '◢' ? 1 : -1;
      x.moveTo(cx + r * 0.85 * d, cy - r * 0.85);
      x.lineTo(cx + r * 0.85 * d, cy + r * 0.85);
      x.lineTo(cx - r * 0.85 * d, cy + r * 0.85);
      x.closePath();
    } else if (sym === '⬟' || sym === '⬢') {
      const n = sym === '⬟' ? 5 : 6;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        x[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      x.closePath();
    } else if (sym === '✖') {
      x.lineWidth = r * 0.5;
      x.strokeStyle = x.fillStyle;
      x.lineCap = 'butt';
      x.moveTo(cx - r * 0.8, cy - r * 0.8); x.lineTo(cx + r * 0.8, cy + r * 0.8);
      x.moveTo(cx + r * 0.8, cy - r * 0.8); x.lineTo(cx - r * 0.8, cy + r * 0.8);
      x.stroke();
      return true;
    } else if (sym === '◐' || sym === '◑' || sym === '◧' || sym === '◨') {
      // контур целиком и закрашенная половина
      const round = sym === '◐' || sym === '◑', left = sym === '◐' || sym === '◧', q = r * 0.85;
      x.lineWidth = r * 0.22;
      x.strokeStyle = x.fillStyle;
      if (round) x.arc(cx, cy, q, 0, Math.PI * 2); else x.rect(cx - q, cy - q, q * 2, q * 2);
      x.stroke();
      x.beginPath();
      if (round) x.arc(cx, cy, q, left ? Math.PI / 2 : -Math.PI / 2, left ? Math.PI * 1.5 : Math.PI / 2);
      else x.rect(left ? cx - q : cx, cy - q, q, q * 2);
    } else if (sym === '⊕' || sym === '⊗') {
      const q = r * 0.85, k = sym === '⊕' ? q : q * 0.707;
      x.lineWidth = r * 0.24;
      x.strokeStyle = x.fillStyle;
      x.arc(cx, cy, q, 0, Math.PI * 2);
      if (sym === '⊕') { x.moveTo(cx - k, cy); x.lineTo(cx + k, cy); x.moveTo(cx, cy - k); x.lineTo(cx, cy + k); }
      else { x.moveTo(cx - k, cy - k); x.lineTo(cx + k, cy + k); x.moveTo(cx + k, cy - k); x.lineTo(cx - k, cy + k); }
      x.stroke();
      return true;
    } else if (sym === '◎' || sym === '▣') {
      const q = r * 0.85;
      x.lineWidth = r * 0.24;
      x.strokeStyle = x.fillStyle;
      if (sym === '◎') x.arc(cx, cy, q, 0, Math.PI * 2); else x.rect(cx - q, cy - q, q * 2, q * 2);
      x.stroke();
      x.beginPath();
      if (sym === '◎') x.arc(cx, cy, q * 0.42, 0, Math.PI * 2); else x.rect(cx - q * 0.45, cy - q * 0.45, q * 0.9, q * 0.9);
    } else return false;
    x.fill();
    return true;
  }

  function drawSymbol(x, c, cx, cy, size) {
    x.fillStyle = c.faint ? '#c4c4c4' : c.dark ? '#ffffff' : '#000000';
    if (c.symbol.length === 1 && A.SHAPES && (A.SHAPES.indexOf(c.symbol) >= 0 || A.MORE_SHAPES.indexOf(c.symbol) >= 0) && drawShape(x, c.symbol, cx, cy, size * 0.47)) return;
    x.font = 'bold ' + Math.round(size) + 'px ' + FONT;
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    const m = x.measureText(c.symbol);
    const dy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    x.fillText(c.symbol, cx, cy + dy);
  }

  /* Цвета так, как они напечатаны на схеме: клетке можно задать свой цвет печати
   * (например, чёрные стразы печатать светло-серым, чтобы значок читался). */
  function printed(colors) {
    return colors.map(function (c) {
      if (!c.print) return c;
      return { code: c.code, symbol: c.symbol, count: c.count, r: c.print.r, g: c.print.g, b: c.print.b, hex: c.print.hex, dark: c.print.dark };
    });
  }

  /* Размер значка в клетке схемы: 1 — обычный, больше — крупнее (но не шире самой клетки). */
  let symbolScale = 1;
  function setSymbolScale(k) { symbolScale = Math.max(0.8, Math.min(1.3, +k || 1)); }

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
    if (s >= 9) drawSymbol(x, c, s / 2, s / 2, s * Math.min(0.98, 0.78 * symbolScale));
    return cv;
  }

  function renderScheme(res, cellPx, shape, highlight, under) {
    const s = cellPx;
    const cv = drawCells(res, s, withHighlight(printed(res.colors), highlight).map(function (c) { return symbolSprite(c, s, shape); }), under);
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
      patchEmpty(x, res, s, under); // в зонах без страз сетка не нужна
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
    return meta.wCm + '×' + meta.hCm + T(' см');
  }

  function stoneLabel(meta) {
    const p = String(meta.pitch).replace('.', ',');
    return meta.shape === 'round' ? T('круглых страз ') + p + T(' мм') : T('страз размера ') + p + ' × ' + p + T(' мм');
  }

  function renderLegend(res, meta) {
    const K = 2; // масштаб для чёткости
    const colors = printed(res.colors), n = colors.length;
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
    x.fillText(T('Легенда для схемы размером ') + sizeLabel(meta) + '* (' + res.cols + '×' + res.rows + T(' страз) из ') + n + T(' цветов'), pad, pad + 22, W - pad * 2);
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
      x.fillText(T('ЗНАЧОК'), x0, top + 20);
      x.fillText(T('НОМЕР DMC'), xCode, top + 20);
      x.textAlign = 'right';
      x.fillText(T('ЧИСЛО СТРАЗ'), xCount, top + 20);
      x.fillText(T('ВЕС, г*'), xW, top + 20);
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
        drawSymbol(x, c, x0 + 19, y + 20, 22);
        const g = grams(c.count, meta.gramPerStone);
        total += c.count; totalG += g;
        x.fillStyle = '#111111';
        x.textAlign = 'left';
        x.font = 'bold 17px ' + FONT;
        x.fillText('—  ' + c.code, xCode, y + 26);
        x.font = '17px ' + FONT;
        x.textAlign = 'right';
        x.fillText(fmt(c.count), xCount, y + 26);
        x.fillText(g + T(' г'), xW, y + 26);
      }
    }

    let y = top + tableH + 26;
    x.fillStyle = '#111111';
    x.fillRect(pad, y - 22, W - pad * 2, 1);
    x.textAlign = 'left';
    x.font = 'bold 17px ' + FONT;
    x.fillText(T('Всего: ') + fmt(total) + T(' страз, около ') + fmt(totalG) + T(' г'), pad, y + 6);
    y += 48;
    x.font = '13px ' + FONT;
    x.fillStyle = '#555555';
    x.fillText(T('* Размер схемы в см и вес страз каждого цвета указаны ориентировочно для ') + stoneLabel(meta) + '.', pad, y);
    x.fillText(T('Вес округлён вверх до целого грамма, из расчёта ') + String(meta.gramBase || meta.gramPerStone).replace('.', ',') + T(' г на одну стразу') + (meta.reserve ? T(', с запасом ') + meta.reserve + ' %' : '') + '.', pad, y + 20);
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
    const rows = [T('Значок;Номер DMC;Число страз;Вес, г')];
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

  /* meta: wCm, hCm, pitch, shape, article, title, urls[], logos (картинки для низа листа), focusX, focusY
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
    left.push(meta.wCm + 'x' + meta.hCm + T('см'));
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
    printed(res.colors).forEach(function (c, i) {
      const y = ly + rowH * (1.35 + i);
      const qx = lx + rowH * 0.35, qy = y + (rowH - sq) / 2;
      x.fillStyle = c.hex;
      x.fillRect(qx, qy, sq, sq);
      x.strokeStyle = '#444444';
      x.lineWidth = Math.max(0.5, rowH * 0.02);
      x.strokeRect(qx, qy, sq, sq);
      if (sq >= 7) drawSymbol(x, c, qx + sq / 2, qy + sq / 2, sq * 0.78);
      x.fillStyle = '#000000';
      x.textAlign = 'left';
      x.textBaseline = 'middle';
      x.font = codeFont;
      x.fillText(c.code, qx + sq + rowH * 0.3, y + rowH / 2, codeMax);
    });

    // QR-коды и логотип внизу по центру: в ряд, одной высоты, в порядке добавления
    const logos = (meta.logos || []).filter(function (im) { return (im.naturalWidth || im.width) > 0 && (im.naturalHeight || im.height) > 0; });
    if (logos.length) {
      const lgap = mm(8);
      let h = mm(26), rowW = lgap * (logos.length - 1);
      const widths = logos.map(function (im) { return (im.naturalWidth || im.width) / (im.naturalHeight || im.height); });
      widths.forEach(function (a) { rowW += a * h; });
      const maxW = Math.min(mm(240), W - mm(20));
      const k2 = Math.min(1, maxW / rowW); // длинный ряд ужимаем целиком
      h *= k2;
      let px = (W - rowW * k2) / 2;
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      logos.forEach(function (im, i) {
        const w = widths[i] * h;
        x.drawImage(im, px, H - mm(4) - h, w, h);
        px += w + lgap * k2;
      });
    }
    return cv;
  }

  /* Наклейки на пакетики со стразами: листы A4 по 24 штуки (3 × 8, наклейка 70 × 37 мм).
   * На каждой — значок, номер DMC, вес и артикул. Возвращает массив холстов (по листу). */
  function renderLabels(res, meta) {
    const W = 2480, H = 3507, mm = W / 210, lw = 70 * mm, lh = 37.125 * mm, per = 24;
    const colors = printed(res.colors), pages = [];
    for (let p = 0; p * per < colors.length; p++) {
      const cv = A.makeCanvas(W, H), x = cv.getContext('2d');
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, W, H);
      colors.slice(p * per, (p + 1) * per).forEach(function (c, i) {
        const lx = (i % 3) * lw, ly = Math.floor(i / 3) * lh;
        x.strokeStyle = '#d0d0d0'; // тонкая рамка — по ней видно границы, если лист без высечки
        x.lineWidth = 1;
        x.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
        const sq = lh * 0.56, sx = lx + lh * 0.2, sy = ly + (lh - sq) / 2;
        x.fillStyle = c.hex;
        x.fillRect(sx, sy, sq, sq);
        x.strokeStyle = '#444444';
        x.lineWidth = 3;
        x.strokeRect(sx, sy, sq, sq);
        drawSymbol(x, c, sx + sq / 2, sy + sq / 2, sq * 0.78);
        const tx = sx + sq + lh * 0.16, tw = lx + lw - tx - lh * 0.12;
        x.fillStyle = '#000000';
        x.textAlign = 'left';
        x.textBaseline = 'alphabetic';
        x.font = 'bold ' + Math.round(lh * 0.3) + 'px ' + FONT;
        x.fillText('DMC ' + c.code, tx, ly + lh * 0.46, tw);
        x.font = Math.round(lh * 0.19) + 'px ' + FONT;
        x.fillText(grams(c.count, meta.gramPerStone) + T(' г') + ' · ' + fmt(c.count) + T(' шт'), tx, ly + lh * 0.7, tw);
        if (meta.article) {
          x.fillStyle = '#666666';
          x.font = Math.round(lh * 0.14) + 'px ' + FONT;
          x.fillText(meta.article, tx, ly + lh * 0.89, tw);
        }
      });
      pages.push(cv);
    }
    return pages;
  }

  /* Русское и украинское склонение после числа: 1 цвет, 2 цвета, 5 цветов. */
  function plural(n, forms) {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 12 || b > 14) ? forms[1] : forms[2];
  }

  /* Лист-вкладыш в набор, A4 при 300 dpi: миниатюра, артикул, название, размер и таблица
   * «значок — номер DMC» без количества. K — масштаб (1 для печати, меньше для предпросмотра). */
  const INSERT_W = 2480, INSERT_H = 3507, INSERT_ROWS = 21;
  function renderInsert(res, meta, src, K) {
    K = K || 1;
    const W = INSERT_W, H = INSERT_H;
    const cv = A.makeCanvas(Math.round(W * K), Math.round(H * K)), x = cv.getContext('2d');
    x.scale(K, K);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
    const colors = printed(res.colors), n = colors.length;

    // миниатюра той части картинки, что попала в схему
    let textX = 1693;
    if (src) {
      const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
      const rc = A.cropRect(iw, ih, res.cols, res.rows, meta.focusX, meta.focusY);
      let th = 553, tw = (th * res.cols) / res.rows;
      if (tw > 760) { tw = 760; th = (tw * res.rows) / res.cols; }
      const tx = 1162 - tw / 2;
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, rc.x, rc.y, rc.w, rc.h, tx, 22, tw, th);
      textX = Math.max(textX, tx + tw + 150);
    } else textX = 150;

    // подписи справа от миниатюры: длинное название переносится по словам
    const maxW = W - textX - 60;
    x.fillStyle = '#000000';
    x.textAlign = 'left';
    x.textBaseline = 'alphabetic';
    x.font = 'bold 50px ' + FONT;
    const lines = [];
    if (meta.article) lines.push(meta.article);
    if (meta.title) {
      let cur = '';
      meta.title.split(/\s+/).forEach(function (word) {
        const next = cur ? cur + ' ' + word : word;
        if (cur && x.measureText(next).width > maxW && lines.length < 4) { lines.push(cur); cur = word; } else cur = next;
      });
      if (cur) lines.push(cur);
    }
    if (lines.length) lines.push('');
    lines.push(meta.wCm + 'x' + meta.hCm + T('см'));
    lines.push(n + ' ' + plural(n, [T('цвет'), T('цвета'), T('цветов')]));
    lines.forEach(function (l, i) { x.fillText(l, textX, 135 + i * 73, maxW); });

    // таблица: по 21 строке в столбце, как в образце
    const cc = Math.max(1, Math.ceil(n / INSERT_ROWS));
    const k = Math.min(1, (W - 92) / (cc * 931)); // три столбца ужимаем по ширине
    for (let col = 0; col < cc; col++) {
      const x0 = 46 + col * 931 * k;
      x.fillStyle = '#000000';
      x.textAlign = 'left';
      x.textBaseline = 'alphabetic';
      x.font = 'bold ' + Math.round(46 * k) + 'px ' + FONT;
      x.fillText(T('Обозначение'), x0, 686, 400 * k);
      x.fillText(T('Номер цвета DMC'), x0 + 430 * k, 686, 470 * k); // не шире своего столбца
      for (let row = 0; row < INSERT_ROWS; row++) {
        const c = colors[col * INSERT_ROWS + row];
        if (!c) break;
        const cy = 830 + row * 117;
        const sq = 63 * k, sx = x0 + 219 * k;
        x.fillStyle = c.hex;
        x.fillRect(sx, cy - sq / 2, sq, sq);
        x.strokeStyle = '#444444';
        x.lineWidth = 2;
        x.strokeRect(sx + 1, cy - sq / 2 + 1, sq - 2, sq - 2);
        drawSymbol(x, c, sx + sq / 2, cy, sq * 0.76);
        const rw = 221 * k, rh = 91 * k, rx = x0 + 374 * k;
        x.fillStyle = c.hex;
        x.fillRect(rx, cy - rh / 2, rw, rh);
        x.strokeStyle = '#d0d0d0'; // чтобы белые и очень светлые образцы не терялись на листе
        x.lineWidth = 1;
        x.strokeRect(rx + 0.5, cy - rh / 2 + 0.5, rw - 1, rh - 1);
        x.fillStyle = '#000000';
        x.textAlign = 'left';
        x.textBaseline = 'middle';
        x.font = Math.round(70 * k) + 'px ' + FONT;
        x.fillText('- ' + c.code, x0 + 647 * k, cy + 2);
      }
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
  A.drawSymbol = drawSymbol;
  A.printed = printed;
  A.layoutCells = layoutCells;
  A.grams = grams;
  A.renderInsert = renderInsert;
  A.setSymbolScale = setSymbolScale;
  A.renderLabels = renderLabels;
  A.INSERT_PX_PER_MM = INSERT_W / 210;
})(window.ALMAZ = window.ALMAZ || {});
