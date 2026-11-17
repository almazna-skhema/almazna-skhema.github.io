/* Разбор готового макета: где сетка схемы, где легенда, какая позначка в какой клетке.
 * Работает по составляющим файла (для CMYK — по краскам), ничего не пересчитывая в RGB. */
(function (A) {
  'use strict';

  const MAX_GROUPS = 800;
  const SAME_MASK = 0.6, SAME_SHADE = 100; // см. mergeScore

  /* Яркость каждой точки в полном разрешении — только для поиска сетки и легенды. */
  function grayPlane(dec) {
    const f = dec.frame, W = f.width, H = f.height, cs = f.comps, g = new Uint8Array(W * H);
    const pick = cs.map(function (c) {
      const sx = c.h / f.hmax, sy = c.v / f.vmax, xs = new Int32Array(W);
      for (let x = 0; x < W; x++) xs[x] = Math.floor(x * sx);
      return { c: c, sy: sy, xs: xs };
    });
    const cmyk = cs.length === 4, ycc = cs.length === 3 && !(dec.adobe && dec.adobe.transform === 0);
    for (let y = 0; y < H; y++) {
      const rows = pick.map(function (p) { return Math.floor(y * p.sy) * p.c.pw; });
      for (let x = 0; x < W; x++) {
        const v0 = pick[0].c.plane[rows[0] + pick[0].xs[x]];
        let v;
        if (cs.length === 1 || ycc) v = v0;
        else {
          const v1 = pick[1].c.plane[rows[1] + pick[1].xs[x]], v2 = pick[2].c.plane[rows[2] + pick[2].xs[x]];
          if (cmyk) {
            const k = pick[3].c.plane[rows[3] + pick[3].xs[x]]; // Adobe хранит краски перевёрнутыми: 255 — нет краски
            // YCCK (Adobe transform 2): первая составляющая уже яркость
            v = dec.adobe && dec.adobe.transform === 2 ? (v0 * k) / 255 : ((0.299 * v0 + 0.587 * v1 + 0.114 * v2) * k) / 255;
          } else v = 0.299 * v0 + 0.587 * v1 + 0.114 * v2;
        }
        g[y * W + x] = v;
      }
    }
    return g;
  }

  function smooth(a, r) {
    const out = new Float64Array(a.length);
    let s = 0;
    for (let i = 0; i < a.length + r; i++) {
      if (i < a.length) s += a[i];
      if (i - 2 * r - 1 >= 0) s -= a[i - 2 * r - 1];
      const c = i - r;
      if (c >= 0 && c < a.length) out[c] = s / (Math.min(a.length - 1, c + r) - Math.max(0, c - r) + 1);
    }
    return out;
  }

  function longestRun(a, t) {
    let best = [0, -1], s = -1;
    for (let i = 0; i <= a.length; i++) {
      if (i < a.length && a[i] > t) { if (s < 0) s = i; } else if (s >= 0) { if (i - 1 - s > best[1] - best[0]) best = [s, i - 1]; s = -1; }
    }
    return best;
  }

  /* Шаг и сдвиг сетки по одной оси. prof — сила «линии» в каждой точке, [from, to] — где схема. */
  function fitAxis(prof, from, to) {
    const n = to - from + 1, q = new Float64Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += prof[from + i];
    mean /= n;
    for (let i = 0; i < n; i++) q[i] = prof[from + i] - mean;
    let lag0 = 0, r0 = -Infinity;
    const rs = [];
    for (let lag = 8; lag <= Math.min(200, n / 3); lag++) {
      let r = 0;
      for (let i = 0; i + lag < n; i++) r += q[i] * q[i + lag];
      rs[lag] = r / (n - lag);
      if (rs[lag] > r0) { r0 = rs[lag]; lag0 = lag; }
    }
    for (let lag = 9; lag < lag0; lag++) if (rs[lag] > 0.75 * r0 && rs[lag] >= rs[lag - 1] && rs[lag] >= rs[lag + 1]) { lag0 = lag; break; } // не кратный шаг
    const at = function (x) { const i = Math.floor(x), t = x - i; return i < 0 || i + 1 >= prof.length ? 0 : prof[i] * (1 - t) + prof[i + 1] * t; };
    let best = { score: -Infinity };
    for (let P = lag0 - 1.5; P <= lag0 + 1.5; P += 0.005) {
      for (let x0 = from; x0 < from + P; x0 += 0.25) {
        let sum = 0, k = 0;
        for (let x = x0; x <= to; x += P) { sum += at(x); k++; }
        if (sum / k > best.score) best = { score: sum / k, P: P, x0: x0 };
      }
    }
    // края схемы: линии, ближайшие к границам «ряби»
    const kFrom = Math.round((from - best.x0) / best.P), kTo = Math.round((to - best.x0) / best.P);
    return { P: best.P, first: best.x0 + kFrom * best.P, count: kTo - kFrom, lag: lag0 };
  }

  /* Сила «линии» в точке: точка темнее (или светлее) обоих соседей через 2 точки. */
  function ridge(v, l, r) {
    if (v < l && v < r) return Math.min(l - v, r - v);
    if (v > l && v > r) return Math.min(v - l, v - r);
    return 0;
  }

  /* Края схемы по «ряби»: точные, без сглаживания. */
  function edges(e) {
    const sm = smooth(e, 20), vals = Array.from(sm).sort(function (a, b) { return a - b; });
    const hi = vals[Math.floor(vals.length * 0.9)], run = longestRun(sm, hi * 0.2);
    let a = run[0], b = run[1];
    const t = hi * 0.15;
    while (a > 0 && e[a - 1] > t) a--;
    while (b < e.length - 1 && e[b + 1] > t) b++;
    return [a, b];
  }

  /* Поиск сетки схемы. Возвращает границы клеток по обеим осям. */
  function findGrid(g, W, H) {
    const colE = new Float64Array(W), rowE = new Float64Array(H);
    for (let y = 0; y < H; y += 3) for (let x = 1; x < W; x++) colE[x] += Math.abs(g[y * W + x] - g[y * W + x - 1]);
    const xr = edges(colE);
    for (let y = 1; y < H; y++) for (let x = xr[0]; x <= xr[1]; x += 3) rowE[y] += Math.abs(g[y * W + x] - g[(y - 1) * W + x]);
    const yr = edges(rowE);
    // линия сетки идёт через всю схему, значок — нет: берём медиану «силы линии» по строкам
    function profile(axisX) {
      const len = axisX ? W : H, a = axisX ? yr : xr, lines = [], out = new Float64Array(len);
      const nS = Math.min(240, a[1] - a[0] + 1);
      for (let i = 0; i < nS; i++) lines.push(Math.round(a[0] + ((a[1] - a[0]) * (i + 0.5)) / nS));
      const col = new Float64Array(nS), lo = axisX ? xr[0] : yr[0], hi = axisX ? xr[1] : yr[1];
      for (let i = Math.max(2, lo - 6); i <= Math.min(len - 3, hi + 6); i++) {
        for (let k = 0; k < nS; k++) {
          const t = lines[k];
          col[k] = axisX ? ridge(g[t * W + i], g[t * W + i - 2], g[t * W + i + 2]) : ridge(g[i * W + t], g[(i - 2) * W + t], g[(i + 2) * W + t]);
        }
        col.sort();
        out[i] = col[nS >> 1] + 0.5 * col[Math.floor(nS * 0.3)];
      }
      return out;
    }
    const px = profile(true), py = profile(false);
    const fx = fitAxis(px, xr[0], xr[1]), fy = fitAxis(py, yr[0], yr[1]);
    let xs = [], ys = [];
    for (let i = 0; i <= fx.count; i++) xs.push(fx.first + i * fx.P);
    for (let i = 0; i <= fy.count; i++) ys.push(fy.first + i * fy.P);
    // за краем схемы бывает рамка на расстоянии клетки: там нет значков — такие «клетки» отбрасываем
    function busy(axisX, lines, k) {
      const a0 = Math.ceil(lines[k] + 4), a1 = Math.floor(lines[k + 1] - 4), o = axisX ? [ys[0], ys[ys.length - 1]] : [xs[0], xs[xs.length - 1]];
      let s = 0, n = 0;
      for (let t = Math.ceil(o[0]); t <= o[1]; t += 3) for (let i = a0; i <= a1; i++) {
        // поперёк полосы: в клетках есть поперечные линии и значки, в промежутке до рамки — ровный фон
        s += axisX ? Math.abs(g[t * W + i] - g[(t - 1) * W + i]) : Math.abs(g[i * W + t] - g[i * W + t - 1]);
        n++;
      }
      return n ? s / n : 0;
    }
    function trim(axisX) {
      for (let round = 0; round < 2; round++) {
        let lines = axisX ? xs : ys;
        const e = [];
        for (let k = 0; k < lines.length - 1; k++) e.push(busy(axisX, lines, k));
        const med = e.slice().sort(function (a2, b2) { return a2 - b2; })[e.length >> 1];
        let a2 = 0, b2 = e.length - 1;
        while (a2 < b2 && e[a2] < med * 0.35) a2++;
        while (b2 > a2 && e[b2] < med * 0.35) b2--;
        lines = lines.slice(a2, b2 + 2);
        if (axisX) xs = lines; else ys = lines;
      }
    }
    trim(true); trim(false); trim(true);
    // толщина линий по профилю яркости поперёк линии
    function width(axisX, lines, every10) {
      const ws = [], a = axisX ? yr : xr;
      lines.forEach(function (x, i) {
        if ((i % 10 === 0) !== every10 || i === 0 || i === lines.length - 1) return;
        const c = Math.round(x), prof = [];
        for (let d = -6; d <= 6; d++) {
          let s = 0, n = 0;
          for (let t = a[0]; t <= a[1]; t += 7) { s += axisX ? g[t * W + c + d] : g[(c + d) * W + t]; n++; }
          prof.push(s / n);
        }
        const base = (prof[0] + prof[1] + prof[11] + prof[12]) / 4, peak = prof[6];
        let w = 0;
        for (let d = 0; d < prof.length; d++) if (Math.abs(prof[d] - base) > Math.abs(peak - base) * 0.4) w++;
        ws.push(w);
      });
      ws.sort(function (a2, b2) { return a2 - b2; });
      return ws.length ? ws[Math.floor(ws.length / 2)] : 0;
    }
    const thin = Math.max(width(true, xs, false), width(false, ys, false), 1), bold = Math.max(width(true, xs, true), width(false, ys, true), thin);
    return { xs: xs, ys: ys, cols: xs.length - 1, rows: ys.length - 1, pitch: (fx.P + fy.P) / 2, thin: thin, bold: bold, box: [xr, yr], lag: [fx.lag, fy.lag] };
  }

  /* Внутренность клетки без линий сетки (в точках полного разрешения). */
  function cellBox(grid, cx, cy) {
    const m = function (i) { return (i % 10 === 0 ? grid.bold : grid.thin) / 2 + 1.5; };
    return {
      x0: Math.ceil(grid.xs[cx] + m(cx)), x1: Math.floor(grid.xs[cx + 1] - m(cx + 1)),
      y0: Math.ceil(grid.ys[cy] + m(cy)), y1: Math.floor(grid.ys[cy + 1] - m(cy + 1))
    };
  }

  /* Легенда: белая плашка справа от схемы со столбиком квадратиков с рамкой. */
  function findLegend(g, W, H, grid) {
    const left = Math.ceil(grid.xs[grid.xs.length - 1] + grid.pitch);
    if (left >= W - 10) return null;
    const white = function (x, y) { return g[y * W + x] > 225; };
    // у плашки резкий край (фон за ней размыт): ищем столбец, где чаще всего фон резко сменяется белым
    const rise = new Float64Array(W);
    for (let y = 0; y < H; y += 2) {
      const r = y * W;
      for (let x = left + 2; x < W - 1; x++) if (g[r + x - 2] < 236 && g[r + x - 1] < 244 && g[r + x] >= 246 && g[r + x + 1] >= 246) rise[x]++;
    }
    let bx0 = -1, mr = 0;
    for (let x = left; x < W; x++) if (rise[x] > mr) mr = rise[x];
    for (let x = left; x < W; x++) if (rise[x] >= mr * 0.6) { bx0 = x; break; } // край плашки — левее квадратиков
    if (bx0 < 0 || mr * 2 < H * 0.08) return null;
    // высота плашки — по белой полоске у её левого края
    const sx = Math.min(W - 1, bx0 + 3);
    let by0 = 0, by1 = -1, s0 = -1;
    for (let y = 0; y <= H; y++) {
      if (y < H && g[y * W + sx] >= 235) { if (s0 < 0) s0 = y; } else if (s0 >= 0) { if (y - 1 - s0 > by1 - by0) { by0 = s0; by1 = y - 1; } s0 = -1; }
    }
    if (by1 - by0 < H * 0.08) return null;
    // правый край: где белое резко сменяется фоном; если такого нет — плашка у края листа
    const fall = new Float64Array(W);
    for (let y = by0; y <= by1; y += 2) {
      const r = y * W;
      for (let x = bx0 + 20; x < W - 1; x++) if (g[r + x] >= 240 && g[r + x + 1] < 215) fall[x]++;
    }
    let bx1 = W - 1, mf = 0;
    for (let x = bx0 + 20; x < W - 1; x++) if (fall[x] > mf) { mf = fall[x]; bx1 = x; }
    if (mf * 2 < (by1 - by0) * 0.5) bx1 = W - 1;
    // строки легенды: полосы с не-белыми точками в левой части плашки
    const bw = bx1 - bx0 + 1, sx0 = bx0 + 2, sx1 = bx0 + Math.round(bw * 0.5);
    const runs = [];
    let s = -1;
    for (let y = by0; y <= by1 + 1; y++) {
      let ink = false;
      if (y <= by1) for (let x = sx0; x <= sx1; x++) if (!white(x, y)) { ink = true; break; }
      if (ink) { if (s < 0) s = y; } else if (s >= 0) { runs.push([s, y - 1]); s = -1; }
    }
    // у каждой полосы — первый сплошной столбик слева: у цветного квадратика он во всю ширину
    const nonWhite = function (x, y) { return g[y * W + x] < 238; };
    const cand = [];
    runs.forEach(function (r) {
      const h = r[1] - r[0] + 1;
      if (h < 6) return;
      const cov = function (x) { let n = 0; for (let y = r[0]; y <= r[1]; y++) if (nonWhite(x, y)) n++; return n / h; };
      let a = sx0;
      while (a < sx1 && cov(a) <= 0.6) a++;
      if (a >= sx1) return;
      let b = a;
      while (b + 1 < sx1 && cov(b + 1) > 0.6) b++;
      cand.push({ y0: r[0], y1: r[1], h: h, a: a, s: b - a + 1 });
    });
    const good = cand.filter(function (c) { return Math.abs(c.s - c.h) <= c.h * 0.2; });
    if (good.length < 2) return null;
    const median = function (arr) { const v = arr.slice().sort(function (p2, q2) { return p2 - q2; }); return v[v.length >> 1]; };
    const aL = median(good.map(function (c) { return c.a; })), S = median(good.map(function (c) { return c.s; }));
    // все строки: квадратик того же размера и на том же месте; проверяем рамку по контуру
    const rows = [];
    cand.forEach(function (c) {
      if (Math.abs(c.a - aL) > 3 || c.h < S * 0.75 || c.h > S * 1.35) return;
      const y0 = Math.round((c.y0 + c.y1) / 2 - S / 2), y1 = y0 + S - 1, x0 = aL, x1 = aL + S - 1;
      let ring = 0, tot = 0;
      for (let x = x0 + 1; x < x1; x++) { tot += 2; if (nonWhite(x, y0 + 1)) ring++; if (nonWhite(x, y1 - 1)) ring++; }
      for (let y = y0 + 1; y < y1; y++) { tot += 2; if (nonWhite(x0 + 1, y)) ring++; if (nonWhite(x1 - 1, y)) ring++; }
      if (ring / tot < 0.6) return;
      rows.push({ x0: x0, y0: y0, x1: x1, y1: y1, rowX1: bx1 - 2 });
    });
    return rows.length >= 2 ? { box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, rows: rows, size: S } : null;
  }

  // ---------- признаки клетки ----------
  const N = 10; // сетка признака формы значка 10×10

  /* Цвет фона по каждой составляющей (медиана внутри области), цвет краски значка и маска значка 10×10. */
  function features(dec, g, W, box) {
    const f = dec.frame, bg = [], ink = [], hist = new Uint32Array(256);
    f.comps.forEach(function (c) {
      const sx = c.h / f.hmax, sy = c.v / f.vmax;
      const x0 = Math.ceil(box.x0 * sx), x1 = Math.floor(box.x1 * sx), y0 = Math.ceil(box.y0 * sy), y1 = Math.floor(box.y1 * sy);
      // фон — по узкой рамке внутри клетки: крупный значок может занять больше половины клетки
      const rw = Math.max(1, Math.round(2 * sx));
      hist.fill(0);
      let rn = 0;
      for (let y = y0; y <= y1; y++) {
        const r = y * c.pw, edgeRow = y < y0 + rw || y > y1 - rw;
        for (let x = x0; x <= x1; x++) if (edgeRow || x < x0 + rw || x > x1 - rw) { hist[c.plane[r + x]]++; rn++; }
      }
      let acc = 0, med = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= rn) { med = v; break; } }
      hist.fill(0);
      let n = 0;
      for (let y = y0; y <= y1; y++) { const r = y * c.pw; for (let x = x0; x <= x1; x++) { hist[c.plane[r + x]]++; n++; } }
      // краска значка: самые далёкие от фона 6 % точек
      let need = Math.max(1, Math.round(n * 0.02)), sum = 0, got = 0;
      for (let dlt = 255; dlt > 0 && got < need; dlt--) {
        [med - dlt, med + dlt].forEach(function (v) {
          if (v < 0 || v > 255 || got >= need) return;
          const take = Math.min(hist[v], need - got);
          sum += take * v; got += take;
        });
      }
      bg.push(med);
      ink.push(got ? Math.round(sum / got) : med);
    });
    const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1, gh = new Uint32Array(256);
    let gn = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      const edgeRow = y < box.y0 + 2 || y > box.y1 - 2;
      for (let x = box.x0; x <= box.x1; x++) if (edgeRow || x < box.x0 + 2 || x > box.x1 - 2) { gh[g[y * W + x]]++; gn++; }
    }
    let acc = 0, gbg = 0;
    for (let v = 0; v < 256; v++) { acc += gh[v]; if (acc * 2 >= gn) { gbg = v; break; } }
    const mask = new Float32Array(N * N), cnt = new Float32Array(N * N);
    let dark = 0, light = 0;
    for (let y = 0; y < bh; y++) {
      const my = Math.min(N - 1, Math.floor((y * N) / bh)) * N, r = (box.y0 + y) * W + box.x0;
      for (let x = 0; x < bw; x++) {
        const d = g[r + x] - gbg, i = my + Math.min(N - 1, Math.floor((x * N) / bw));
        mask[i] += Math.min(1, Math.abs(d) / 90);
        cnt[i]++;
        if (d < -40) dark++; else if (d > 40) light++;
      }
    }
    for (let i = 0; i < N * N; i++) mask[i] /= cnt[i] || 1;
    return { bg: bg, mask: mask, ink: ink, lightGlyph: light > dark };
  }

  function colorDist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }
  function maskDist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }
  // одна мера на цвет и форму: шум внутри одной позначки даёт около 1, разные позначки — от 10
  function score(ft, t) { return colorDist(ft.bg, t.bg) / 9 + maskDist(ft.mask, t.mask); }

  /* Для слияния групп: одинаковая форма значка (у разных позначек от 2, у одной — меньше 0,1) и близкий
   * цвет — это одна позначка, даже если файл пересохраняли с переводом цвета и оттенок «поплыл». */
  function mergeScore(a, b) {
    const s = score(a, b);
    if (s <= 4) return s;
    return maskDist(a.mask, b.mask) < SAME_MASK && colorDist(a.bg, b.bg) / a.bg.length < SAME_SHADE ? 4 : s;
  }

  function meanOf(feats, idx) {
    const nb = feats[0].bg.length, bg = new Float64Array(nb), mask = new Float32Array(N * N);
    idx.forEach(function (i) { const ft = feats[i]; for (let j = 0; j < nb; j++) bg[j] += ft.bg[j]; for (let j = 0; j < N * N; j++) mask[j] += ft.mask[j]; });
    for (let j = 0; j < nb; j++) bg[j] /= idx.length;
    for (let j = 0; j < N * N; j++) mask[j] /= idx.length;
    return { bg: Array.from(bg), mask: mask, n: idx.length };
  }

  /* Позначки ищем по самой схеме (в легенде некоторых макетов строк не хватает), потом сопоставляем с легендой. */
  async function classify(dec, g, W, grid, legend, onStep) {
    const feats = [];
    for (let cy = 0; cy < grid.rows; cy++) {
      for (let cx = 0; cx < grid.cols; cx++) feats.push(features(dec, g, W, cellBox(grid, cx, cy)));
      if (onStep && cy % 20 === 19) await onStep();
    }
    // 1) мелкие группы по цвету, внутри них — по форме значка
    let groups = [];
    const byColor = [];
    feats.forEach(function (ft, i) {
      let b = -1, bd = Infinity;
      for (let k = 0; k < byColor.length; k++) { const dd = colorDist(ft.bg, byColor[k].c); if (dd < bd) { bd = dd; b = k; } }
      if (bd < 25) byColor[b].m.push(i); else byColor.push({ c: ft.bg, m: [i] });
    });
    byColor.forEach(function (grp) {
      const sub = [];
      grp.m.forEach(function (i) {
        let b = -1, bd = Infinity;
        for (let k = 0; k < sub.length; k++) { const dd = maskDist(feats[i].mask, sub[k].mask); if (dd < bd) { bd = dd; b = k; } }
        if (bd < 3) sub[b].m.push(i); else sub.push({ mask: feats[i].mask, m: [i] });
      });
      sub.forEach(function (x) { groups.push(x.m); });
    });
    // в настоящем макете значков не больше 169; тысячи групп — значит, это не макет (фото, картинка)
    if (groups.length > MAX_GROUPS) { const e = new Error('grid'); e.code = 'grid'; throw e; }
    // 2) сливаем группы одной позначки, разорванные шумом
    // Попарные сходства считаем один раз и после слияния обновляем только затронутые строки:
    // так при сотнях групп это доли секунды, а не минуты.
    let tpls = groups.map(function (m) { return meanOf(feats, m); });
    {
      const n = tpls.length, sc = new Float64Array(n * n), alive = new Uint8Array(n).fill(1);
      const rowMin = new Float64Array(n), rowArg = new Int32Array(n);
      const fillRow = function (a) {
        let m = Infinity, arg = -1;
        for (let b = a + 1; b < n; b++) if (alive[b] && sc[a * n + b] < m) { m = sc[a * n + b]; arg = b; }
        rowMin[a] = m; rowArg[a] = arg;
      };
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) sc[a * n + b] = mergeScore(tpls[a], tpls[b]);
        if (onStep && a % 64 === 63) await onStep();
      }
      for (let a = 0; a < n; a++) fillRow(a);
      for (let merges = 0; ; merges++) {
        let pa = -1, bs = Infinity;
        for (let a = 0; a < n; a++) if (alive[a] && rowMin[a] < bs) { bs = rowMin[a]; pa = a; }
        if (pa < 0 || bs > 4) break;
        const pb = rowArg[pa];
        groups[pa] = groups[pa].concat(groups[pb]);
        groups[pb] = null;
        alive[pb] = 0;
        tpls[pa] = meanOf(feats, groups[pa]);
        for (let x = 0; x < n; x++) {
          if (!alive[x] || x === pa) continue;
          const lo = Math.min(x, pa), hi = Math.max(x, pa);
          sc[lo * n + hi] = mergeScore(tpls[lo], tpls[hi]);
        }
        for (let a = 0; a < n; a++) {
          if (!alive[a]) continue;
          if (a === pa || rowArg[a] === pa || rowArg[a] === pb) fillRow(a);
          else if (a < pa && sc[a * n + pa] < rowMin[a]) { rowMin[a] = sc[a * n + pa]; rowArg[a] = pa; }
        }
        if (onStep && merges % 16 === 15) await onStep();
      }
      groups = groups.filter(function (m) { return m !== null; });
      tpls = tpls.filter(function (t, i) { return alive[i]; });
    }
    // 3) каждую клетку — к ближайшему образцу, дважды
    const cells = new Uint16Array(feats.length);
    for (let pass = 0; pass < 2; pass++) {
      feats.forEach(function (ft, i) {
        let b = 0, bs2 = Infinity;
        for (let k = 0; k < tpls.length; k++) { const s2 = score(ft, tpls[k]); if (s2 < bs2) { bs2 = s2; b = k; } }
        cells[i] = b;
      });
      const mem = tpls.map(function () { return []; });
      for (let i = 0; i < cells.length; i++) mem[cells[i]].push(i);
      const keep = [];
      mem.forEach(function (m, k) { if (m.length) keep.push(k); });
      tpls = keep.map(function (k) { return meanOf(feats, mem[k]); });
      const remap = new Int32Array(mem.length).fill(-1);
      keep.forEach(function (k, j) { remap[k] = j; });
      for (let i = 0; i < cells.length; i++) cells[i] = remap[cells[i]];
    }
    // 3а) после распределения образцы точнее — ещё раз сливаем одну позначку, распавшуюся на оттенки
    for (;;) {
      let pa = -1, pb = -1;
      for (let a = 0; a < tpls.length && pa < 0; a++) for (let b = a + 1; b < tpls.length; b++) {
        if (maskDist(tpls[a].mask, tpls[b].mask) < SAME_MASK && colorDist(tpls[a].bg, tpls[b].bg) / tpls[a].bg.length < SAME_SHADE) { pa = a; pb = b; break; }
      }
      if (pa < 0) break;
      const m = [];
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] === pb) cells[i] = pa; else if (cells[i] > pb) cells[i]--;
        if (cells[i] === pa) m.push(i);
      }
      tpls.splice(pb, 1);
      tpls[pa] = meanOf(feats, m);
    }
    // сомнительные клетки: второй образец почти так же близок
    let doubtful = 0;
    feats.forEach(function (ft, i) {
      let b1 = Infinity, b2 = Infinity;
      tpls.forEach(function (t) { const s2 = score(ft, t); if (s2 < b1) { b2 = b1; b1 = s2; } else if (s2 < b2) b2 = s2; });
      if (b2 < 6) doubtful++;
    });
    // 4) сопоставляем с легендой: сначала самые похожие пары
    const legFeats = legend ? legend.rows.map(function (r) {
      const inset = Math.max(2, Math.round((r.x1 - r.x0) * 0.14));
      return features(dec, g, W, { x0: r.x0 + inset, y0: r.y0 + inset, x1: r.x1 - inset, y1: r.y1 - inset });
    }) : [];
    const pairs = [];
    tpls.forEach(function (t, k) { legFeats.forEach(function (lf, j) { pairs.push({ k: k, j: j, s: colorDist(t.bg, lf.bg) / 9 + 0.5 * maskDist(t.mask, lf.mask) }); }); });
    pairs.sort(function (a, b) { return a.s - b.s; });
    const legendOf = new Int32Array(tpls.length).fill(-1), used = new Uint8Array(legFeats.length);
    pairs.forEach(function (p) { if (p.s < 30 && legendOf[p.k] < 0 && !used[p.j]) { legendOf[p.k] = p.j; used[p.j] = 1; } });
    // образец клетки каждой позначки: та, что ближе всех к среднему
    const sample = tpls.map(function () { return -1; }), sampleS = tpls.map(function () { return Infinity; });
    feats.forEach(function (ft, i) { const k = cells[i], s2 = score(ft, tpls[k]); if (s2 < sampleS[k]) { sampleS[k] = s2; sample[k] = i; } });
    const classes = tpls.map(function (t, k) {
      let ink = null, light = 0, n = 0;
      const nb = t.bg.length, sum = new Float64Array(nb);
      feats.forEach(function (ft, i) { if (cells[i] !== k) return; n++; if (ft.lightGlyph) light++; for (let j = 0; j < nb; j++) sum[j] += ft.ink[j]; });
      ink = Array.from(sum, function (v) { return Math.round(v / Math.max(1, n)); });
      return { bg: t.bg.map(Math.round), ink: ink, mask: t.mask, count: t.n, legend: legendOf[k], sample: sample[k], lightGlyph: light * 2 > n };
    });
    const nb = dec.frame.comps.length, cellBg = new Uint8Array(feats.length * nb);
    feats.forEach(function (ft, i) { for (let j = 0; j < nb; j++) cellBg[i * nb + j] = ft.bg[j]; });
    return { cells: cells, classes: classes, doubtful: doubtful, legendFeats: legFeats, cellBg: cellBg };
  }

  /* Замена значков в свежеразобранном файле. JPEG — только коэффициенты блоков под клетками;
   * PNG (dec.png) — прямо точки в плоскостях, их потом записывает pngEdit.encode.
   * edits: [{ k: номер позначки, symbol }]; maskFor(w, h, symbol, size) → покрытие значком 0…1 для области w×h.
   * size — размер значка в долях клетки. Меняются только блоки 8×8 под перерисованными клетками. */
  function applyEdits(dec, scan, edits, maskFor, opt) {
    const f = dec.frame, J = A.jpegEdit, grid = scan.grid, nb = f.comps.length, direct = !!dec.png;
    const touched = f.comps.map(function () { return new Map(); }); // блок → его точки
    function samples(ci, bi) {
      const t = touched[ci];
      let px = t.get(bi);
      if (!px) {
        const c = f.comps[ci];
        px = new Uint8Array(64);
        J.idctBlock(c.coefs, bi * 64, c.q, px);
        t.set(bi, px);
      }
      return px;
    }
    /* Перерисовать прямоугольник box (полное разрешение): фон bg, значок цветом ink по маске. */
    function paint(box, bg, ink, mask) {
      const w = box.x1 - box.x0 + 1;
      f.comps.forEach(function (c, ci) {
        const sx = c.h / f.hmax, sy = c.v / f.vmax, fx = 1 / sx, fy = 1 / sy;
        const u0 = Math.ceil(box.x0 * sx), u1 = Math.floor((box.x1 + 1) * sx) - 1, v0 = Math.ceil(box.y0 * sy), v1 = Math.floor((box.y1 + 1) * sy) - 1;
        for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
          let a = 0, n = 0; // доля значка в точке этой составляющей
          for (let yy = Math.round(v * fy); yy < Math.round((v + 1) * fy); yy++) for (let xx = Math.round(u * fx); xx < Math.round((u + 1) * fx); xx++) {
            a += mask[(yy - box.y0) * w + (xx - box.x0)]; n++;
          }
          a /= n || 1;
          const val = Math.round(bg[ci] + a * (ink[ci] - bg[ci]));
          const cl = val < 0 ? 0 : val > 255 ? 255 : val;
          if (direct) { c.plane[v * c.pw + u] = cl; continue; }
          const bi = (v >> 3) * c.bpl + (u >> 3);
          samples(ci, bi)[(v & 7) * 8 + (u & 7)] = cl;
        }
      });
    }
    const size = opt && opt.size ? opt.size : 0.78, cache = new Map();
    function maskCached(w, h, sym, sz) {
      const key = w + 'x' + h + ':' + sym + ':' + sz.toFixed(2);
      let m = cache.get(key);
      if (!m) { m = maskFor(w, h, sym, sz); cache.set(key, m); }
      return m;
    }
    let cellsDone = 0;
    edits.forEach(function (e) {
      const cl = scan.classes[e.k];
      for (let i = 0; i < scan.cells.length; i++) {
        if (scan.cells[i] !== e.k) continue;
        const cx = i % grid.cols, cy = Math.floor(i / grid.cols), box = cellBox(grid, cx, cy);
        const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
        if (w < 2 || h < 2) continue;
        // значок рисуем по центру клетки; размер — от шага сетки, маска ограничена внутренностью клетки
        const bg = [];
        for (let j = 0; j < nb; j++) bg.push(scan.cellBg[i * nb + j]);
        // у жирной линии сетки клетка внутри на пару точек меньше — значок не должен вылезать за неё и обрезаться
        paint(box, bg, cl.ink, maskCached(w, h, e.symbol, Math.min(grid.pitch * size, Math.min(w, h) - 2) / Math.max(w, h)));
        cellsDone++;
      }
      // квадратик в легенде
      if (opt && opt.legend !== false && cl.legend >= 0 && scan.legend) {
        const r = scan.legend.rows[cl.legend], lf = scan.legendFeats[cl.legend];
        const inset = Math.max(2, Math.round((r.x1 - r.x0) * 0.14));
        const box = { x0: r.x0 + inset, y0: r.y0 + inset, x1: r.x1 - inset, y1: r.y1 - inset };
        const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
        paint(box, lf.bg, lf.ink, maskCached(w, h, e.symbol, Math.min((r.x1 - r.x0 + 1) * size, Math.min(w, h) - 2) / Math.max(w, h)));
      }
    });
    let blocks = 0;
    f.comps.forEach(function (c, ci) {
      touched[ci].forEach(function (px, bi) { J.fdctBlock(px, c.q, c.coefs, bi * 64); blocks++; });
    });
    return { cells: cellsDone, blocks: blocks };
  }

  A.layoutScan = { grayPlane: grayPlane, findGrid: findGrid, findLegend: findLegend, classify: classify, cellBox: cellBox, features: features, applyEdits: applyEdits };
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
