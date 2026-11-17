/* Коллаж для раздела «Фото на холсте»: раскладки под любое число фото и клетки в сантиметрах
 * с одинаковыми промежутками между фото и полями по краю. Раскладка — список клеток в долях
 * лицевой стороны (x, y, w, h от 0 до 1); границы клеток совпадают, поэтому промежуток везде ровный. */
(function (A) {
  'use strict';

  const MAX_ROW = 5; // больше фото в ряд — слишком мелко для холста

  /* Ряды с заданным числом фото в каждом: [2, 3] — сверху 2, снизу 3. */
  function rowsLayout(counts) {
    const cells = [], h = 1 / counts.length;
    counts.forEach(function (n, r) { for (let i = 0; i < n; i++) cells.push({ x: i / n, y: r * h, w: 1 / n, h: h }); });
    return cells;
  }

  function transpose(cells) {
    return cells.map(function (c) { return { x: c.y, y: c.x, w: c.h, h: c.w }; })
      .sort(function (a, b) { return a.x - b.x || a.y - b.y; });
  }

  /* Большое фото и остальные полосой сбоку: side — где полоса (right, left, bottom, top). */
  function bigStrip(m, side, share) {
    const cells = [], s = 1 - share;
    if (side === 'right' || side === 'left') {
      const bx = side === 'right' ? 0 : s;
      cells.push({ x: bx, y: 0, w: share, h: 1 });
      for (let i = 0; i < m; i++) cells.push({ x: side === 'right' ? share : 0, y: i / m, w: s, h: 1 / m });
    } else {
      const by = side === 'bottom' ? 0 : s;
      cells.push({ x: 0, y: by, w: 1, h: share });
      for (let i = 0; i < m; i++) cells.push({ x: i / m, y: side === 'bottom' ? share : 0, w: 1 / m, h: s });
    }
    return cells;
  }

  /* Большое фото на половину и сетка 2 × k на другой половине. */
  function bigGrid(m, side) {
    const k = m / 2, cells = [];
    if (side === 'right') {
      cells.push({ x: 0, y: 0, w: 0.5, h: 1 });
      for (let r = 0; r < k; r++) for (let c = 0; c < 2; c++) cells.push({ x: 0.5 + c * 0.25, y: r / k, w: 0.25, h: 1 / k });
    } else {
      cells.push({ x: 0, y: 0, w: 1, h: 0.5 });
      for (let r = 0; r < 2; r++) for (let c = 0; c < k; c++) cells.push({ x: c / k, y: 0.5 + r * 0.25, w: 1 / k, h: 0.25 });
    }
    return cells;
  }

  /* Большое фото в центре, остальные рамкой вокруг (сетка 4 × 4 без середины 2 × 2 → 13 фото, 3 × 3 → 9). */
  function bigCenter(grid) {
    const cells = [{ x: 1 / grid, y: 1 / grid, w: (grid - 2) / grid, h: (grid - 2) / grid }];
    for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) {
      if (r > 0 && r < grid - 1 && c > 0 && c < grid - 1) continue;
      cells.push({ x: c / grid, y: r / grid, w: 1 / grid, h: 1 / grid });
    }
    return cells;
  }

  /* Числа фото по рядам: поровну, лишние — сверху или снизу. */
  function spread(n, rows, extraFirst) {
    const base = Math.floor(n / rows), extra = n % rows, out = [];
    for (let r = 0; r < rows; r++) out.push(base + ((extraFirst ? r < extra : r >= rows - extra) ? 1 : 0));
    return out;
  }

  /* Все раскладки для n фото; первая — та, что подходит под пропорции холста (aspect = ширина / высота). */
  function templates(n, aspect) {
    n = Math.max(1, n | 0);
    const out = [], seen = new Set();
    function add(id, cells) {
      if (cells.length !== n) return;
      const sig = cells.map(function (c) { return [c.x, c.y, c.w, c.h].map(function (v) { return Math.round(v * 1000); }).join(','); }).sort().join(';');
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ id: id, cells: cells });
    }
    if (n === 1) { add('1', [{ x: 0, y: 0, w: 1, h: 1 }]); return out; }
    const land = (aspect || 1) >= 1;
    // ряды и столбцы
    const rowsSets = [];
    for (let r = 1; r <= Math.min(n, 5); r++) {
      [true, false].forEach(function (ef) {
        const c = spread(n, r, ef);
        if (Math.max.apply(null, c) <= MAX_ROW) rowsSets.push(c);
      });
    }
    // сначала самые «квадратные» сетки под холст
    rowsSets.sort(function (a, b) {
      const fit = function (c) { const cellAspect = (aspect || 1) * c.length / Math.max.apply(null, c); return Math.abs(Math.log(cellAspect)); };
      return fit(a) - fit(b);
    });
    rowsSets.forEach(function (c) {
      add('r' + c.join('-'), rowsLayout(c));
      add('c' + c.join('-'), transpose(rowsLayout(c)));
    });
    // большое фото + полоса остальных
    if (n >= 3 && n - 1 <= MAX_ROW) {
      (land ? ['right', 'left', 'bottom', 'top'] : ['bottom', 'top', 'right', 'left']).forEach(function (side) {
        add('big-' + side, bigStrip(n - 1, side, n - 1 >= 4 ? 0.7 : 0.62));
      });
    }
    // большое фото + сетка
    if (n >= 5 && (n - 1) % 2 === 0 && (n - 1) / 2 <= 4) {
      (land ? ['right', 'bottom'] : ['bottom', 'right']).forEach(function (side) { add('big-grid-' + side, bigGrid(n - 1, side)); });
    }
    if (n === 9) add('center-3', bigCenter(3));
    if (n === 13) add('center-4', bigCenter(4));
    // запас для больших чисел: сетка с последним неполным рядом
    if (!out.length) {
      const cols = Math.ceil(Math.sqrt(n * (aspect || 1))), rows = Math.ceil(n / cols), c = [];
      for (let r = 0; r < rows; r++) c.push(Math.min(cols, n - r * cols));
      add('grid', rowsLayout(c));
    }
    return out.slice(0, 12);
  }

  function find(n, id, aspect) {
    const list = templates(n, aspect);
    return list.find(function (t) { return t.id === id; }) || list[0];
  }

  /* Клетки в сантиметрах внутри прямоугольника area {x, y, w, h}: по краю — поля margin,
   * между фото — промежуток gap (оба в см). */
  function rects(tpl, area, margin, gap) {
    const eps = 1e-6;
    return tpl.cells.map(function (c) {
      const l = c.x < eps ? margin : gap / 2, r = c.x + c.w > 1 - eps ? margin : gap / 2;
      const t = c.y < eps ? margin : gap / 2, b = c.y + c.h > 1 - eps ? margin : gap / 2;
      const x = area.x + c.x * area.w + l, y = area.y + c.y * area.h + t;
      return { x: x, y: y, w: Math.max(0.5, c.w * area.w - l - r), h: Math.max(0.5, c.h * area.h - t - b) };
    });
  }

  /* Миниатюра раскладки для кнопки выбора. */
  function thumb(tpl, aspect, size) {
    const W = aspect >= 1 ? size : Math.round(size * aspect), H = aspect >= 1 ? Math.round(size / aspect) : size;
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    const cells = rects(tpl, { x: 0, y: 0, w: W, h: H }, 2, 2);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#9aa7c7';
    cells.forEach(function (c, i) {
      x.fillStyle = i === 0 ? '#6f83c0' : '#a9b6d9';
      x.fillRect(Math.round(c.x), Math.round(c.y), Math.max(1, Math.round(c.w)), Math.max(1, Math.round(c.h)));
    });
    return cv;
  }

  A.collage = { templates: templates, find: find, rects: rects, thumb: thumb };
})(window.ALMAZ = window.ALMAZ || {});
