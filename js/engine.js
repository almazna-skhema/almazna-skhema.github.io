/* Движок: картинка -> сетка страз -> подбор цветов DMC. */
(function (A) {
  'use strict';

  /* Символы для схемы. Похожие на цифры буквы (B, D, G, I, O, Q) убраны или
   * отодвинуты в конец, чтобы не путались при выкладке. */
  const SYMBOLS = '123456789ACEHJKLMNPRSTUWXYZ+=#%&@?*<>$FVbdfghkmnrt'.split('');
  const MAX_COLORS = SYMBOLS.length;
  /* Крупные значки-фигуры: их можно назначить цвету вручную, когда буква или цифра
   * плохо читается. На схеме рисуются контуром, а не шрифтом. */
  const SHAPES = '●■▲▼◆★♥✚○□'.split('');
  const ALL_SYMBOLS = SYMBOLS.concat(SHAPES);
  const MAX_PALETTE = 3000; // больше цветов в таблице не бывает, а расчёт начинает тормозить

  // ---------- цвет: sRGB -> Oklab (расстояния в нём близки к восприятию глазом) ----------
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToOklab(r, g, b, out, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  }

  function parsePalette(raw) {
    const items = raw.trim().split(/\s+/).map(function (tok) {
      const p = tok.split(':');
      const v = parseInt(p[1], 16);
      return { code: p[0], r: v >> 16, g: (v >> 8) & 255, b: v & 255, hex: '#' + p[1] };
    });
    return paletteFromItems(items);
  }

  function paletteFromItems(items) {
    const lab = new Float32Array(items.length * 3);
    items.forEach(function (it, i) { rgbToOklab(it.r, it.g, it.b, lab, i * 3); });
    return { items: items, lab: lab };
  }

  /* Делит строку таблицы на поля. Разделитель — тот, что есть в строке: «;», табуляция
   * или «,»; кавычки вокруг поля учитываются. Без разделителя цвет ищется в конце строки:
   * «157:8da7ca», «157 8da7ca», «DMC 310 #000000», «157 141 167 202». */
  function splitRow(line) {
    const delim = line.indexOf(';') >= 0 ? ';' : line.indexOf('\t') >= 0 ? '\t' : line.indexOf(',') >= 0 ? ',' : '';
    if (!delim) {
      let m = /^(.*?)[\s:]+(#?[0-9a-f]{6})$/i.exec(line);
      if (m) return [m[1], m[2]];
      m = /^(.*?)[\s:]+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/.exec(line);
      return m ? [m[1], m[2], m[3], m[4]] : [line];
    }
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
      } else if (ch === delim && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function isByte(v) { return /^\d{1,3}$/.test(v) && +v <= 255; }

  /* Цвет в строке: сначала #rrggbb, затем тройка R;G;B (последняя в строке — перед цветом
   * часто стоят количество или остаток), затем шесть hex-знаков без решётки. */
  function rowColor(f) {
    let m;
    for (let i = 1; i < f.length; i++) if ((m = /^#([0-9a-f]{6})$/i.exec(f[i]))) return parseInt(m[1], 16);
    for (let i = f.length - 3; i >= 1; i--) {
      if (isByte(f[i]) && isByte(f[i + 1]) && isByte(f[i + 2])) return (+f[i] << 16) | (+f[i + 1] << 8) | +f[i + 2];
    }
    for (let i = f.length - 1; i >= 1; i--) if (/^[0-9a-f]{6}$/i.test(f[i])) return parseInt(f[i], 16);
    return null;
  }

  /* Палитра без исключённых номеров (если остаётся меньше двух цветов — исходная). */
  function paletteWithout(pal, excluded) {
    const items = pal.items.filter(function (it) { return !excluded.has(it.code); });
    return items.length >= 2 ? paletteFromItems(items) : pal;
  }

  /* Разбор своей таблицы цветов (CSV или текст). В каждой строке — номер и цвет:
   *   157;#8da7ca      157,8da7ca      157:8da7ca      157;141;167;202
   * Лишние столбцы (название и т.п.) допускаются; если в заголовке есть столбцы R, G, B —
   * цвет берётся из них. Возвращает {items, skipped, tooMany}. */
  function parsePaletteText(text) {
    const byCode = new Map();
    let skipped = 0, tooMany = false, rgbCols = null;
    String(text).replace(/^\ufeff/, '').split(/\r\n|\r|\n/).forEach(function (line, lineNo) {
      line = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (!line) return;
      const f = splitRow(line);
      if (lineNo === 0) {
        const low = f.map(function (s) { return s.toLowerCase(); });
        const r = low.findIndex(function (s) { return /^(r|red|красный)$/.test(s); });
        const g = low.findIndex(function (s) { return /^(g|green|зел[её]ный)$/.test(s); });
        const b = low.findIndex(function (s) { return /^(b|blue|синий)$/.test(s); });
        if (r > 0 && g > 0 && b > 0) { rgbCols = [r, g, b]; return; }
      }
      const code = f[0].trim();
      let rgb = null;
      if (rgbCols && rgbCols.every(function (i) { return isByte(f[i] || ''); })) {
        rgb = (+f[rgbCols[0]] << 16) | (+f[rgbCols[1]] << 8) | +f[rgbCols[2]];
      }
      if (rgb === null) rgb = rowColor(f);
      if (!code || code.length > 16 || rgb === null) {
        if (lineNo > 0) skipped++; // первая строка обычно заголовок
        return;
      }
      if (byCode.size >= MAX_PALETTE && !byCode.has(code)) { tooMany = true; return; }
      byCode.set(code, {
        code: code, r: rgb >> 16, g: (rgb >> 8) & 255, b: rgb & 255,
        hex: '#' + rgb.toString(16).padStart(6, '0')
      });
    });
    return { items: Array.from(byCode.values()), skipped: skipped, tooMany: tooMany };
  }

  // ---------- 1. картинка -> сетка ----------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /* Область исходника, которая попадёт на холст (обрезка под пропорции). */
  function cropRect(sw, sh, cols, rows, focusX, focusY) {
    const target = cols / rows;
    let cw = sw, ch = sh;
    if (sw / sh > target) cw = sh * target; else ch = sw / target;
    return { x: (sw - cw) * focusX, y: (sh - ch) * focusY, w: cw, h: ch };
  }

  /* Уменьшение ступенями по 2 раза — без ряби и ступенек на больших фото. */
  function downscale(src, r, tw, th) {
    let cur = src, x = r.x, y = r.y, w = r.w, h = r.h;
    while (w > tw * 2 && h > th * 2) {
      const nw = Math.max(tw, Math.round(w / 2)), nh = Math.max(th, Math.round(h / 2));
      const t = makeCanvas(nw, nh);
      const tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, x, y, w, h, 0, 0, nw, nh);
      if (cur !== src) cur.width = cur.height = 0; // промежуточный холст больше не нужен
      cur = t; x = 0; y = 0; w = nw; h = nh;
    }
    const out = makeCanvas(tw, th);
    const oc = out.getContext('2d', { willReadFrequently: true });
    oc.fillStyle = '#ffffff';
    oc.fillRect(0, 0, tw, th);
    oc.imageSmoothingEnabled = true;
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(cur, x, y, w, h, 0, 0, tw, th);
    if (cur !== src) cur.width = cur.height = 0;
    return out;
  }

  /* opts: focusX, focusY (0..1), brightness, contrast, saturation (-100..100), smooth (0..1) */
  function sampleGrid(src, cols, rows, opts) {
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const rect = cropRect(sw, sh, cols, rows, opts.focusX, opts.focusY);
    const S = 4; // каждая страза усредняется по 4x4 точкам
    const small = downscale(src, rect, cols * S, rows * S);
    const px = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cols * S, rows * S).data;

    const n = cols * rows;
    const rgb = new Uint8ClampedArray(n * 3);
    const br = (opts.brightness || 0) * 1.1;
    const cv = (opts.contrast || 0) * 1.2;
    const cf = (259 * (cv + 255)) / (255 * (259 - cv));
    const sf = 1 + (opts.saturation || 0) / 100;
    const rowLen = cols * S * 4;
    const keepLines = !!opts.lines;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < S; dy++) {
          let p = (y * S + dy) * rowLen + x * S * 4;
          for (let dx = 0; dx < S; dx++, p += 4) { r += px[p]; g += px[p + 1]; b += px[p + 2]; }
        }
        r /= S * S; g /= S * S; b /= S * S;
        if (keepLines) {
          // тонкая тёмная линия занимает лишь часть клетки и при усреднении растворяется в фоне.
          // Если в клетке есть заметно более тёмные точки — берём цвет по ним: линия остаётся линией.
          const mean = 0.299 * r + 0.587 * g + 0.114 * b;
          let dn = 0, lmin = 255;
          for (let dy = 0; dy < S; dy++) {
            let p = (y * S + dy) * rowLen + x * S * 4;
            for (let dx = 0; dx < S; dx++, p += 4) {
              const l = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
              if (l < mean - 50 && l < 130) { dn++; if (l < lmin) lmin = l; }
            }
          }
          if (dn >= 3) {
            // цвет линии — по самым тёмным точкам: края линии смешаны с фоном и дали бы грязный оттенок
            let dr = 0, dg = 0, db = 0, m = 0;
            for (let dy = 0; dy < S; dy++) {
              let p = (y * S + dy) * rowLen + x * S * 4;
              for (let dx = 0; dx < S; dx++, p += 4) {
                const l = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
                if (l <= lmin + 30) { dr += px[p]; dg += px[p + 1]; db += px[p + 2]; m++; }
              }
            }
            r = dr / m; g = dg / m; b = db / m;
          }
        }
        r = cf * (r + br - 128) + 128; g = cf * (g + br - 128) + 128; b = cf * (b + br - 128) + 128;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        const o = (y * cols + x) * 3;
        rgb[o] = gray + (r - gray) * sf;
        rgb[o + 1] = gray + (g - gray) * sf;
        rgb[o + 2] = gray + (b - gray) * sf;
      }
    }

    let lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgbToOklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, i * 3);
    if (opts.smooth > 0) lab = smoothGrid(lab, cols, rows, opts.smooth);
    return { cols: cols, rows: rows, lab: lab };
  }

  /* Сглаживание с сохранением границ: шум в однородных зонах уходит, контуры остаются. */
  function smoothGrid(lab, cols, rows, strength) {
    const sigma = 0.025 + 0.085 * strength;
    const k = -1 / (2 * sigma * sigma);
    const passes = strength > 0.55 ? 2 : 1;
    let src = lab;
    for (let pass = 0; pass < passes; pass++) {
      const dst = new Float32Array(src.length);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 3;
          const L = src[i], a = src[i + 1], b = src[i + 2];
          let sL = 0, sa = 0, sb = 0, sw = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= rows) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= cols) continue;
              const j = (yy * cols + xx) * 3;
              const dL = src[j] - L, da = src[j + 1] - a, db = src[j + 2] - b;
              const w = Math.exp((dL * dL + da * da + db * db) * k);
              sL += src[j] * w; sa += src[j + 1] * w; sb += src[j + 2] * w; sw += w;
            }
          }
          dst[i] = sL / sw; dst[i + 1] = sa / sw; dst[i + 2] = sb / sw;
        }
      }
      src = dst;
    }
    return src;
  }

  // ---------- 2. подбор цветов ----------
  function nearest(L, a, b, plab, list) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < list.length; k++) {
      const p = list[k] * 3;
      const dL = L - plab[p], da = a - plab[p + 1], db = b - plab[p + 2];
      const d = dL * dL + da * da + db * db;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  /* Оставляет nColors цветов: по очереди убирает тот, чья потеря меньше всего
   * заметна (мало страз и рядом есть похожий цвет). Редкие, но контрастные
   * акценты при этом выживают. */
  function reducePalette(used, counts, plab, nColors) {
    const K = used.length;
    if (K <= nColors) return used.slice();
    const D = new Float32Array(K * K);
    for (let i = 0; i < K; i++) {
      const a = used[i] * 3;
      for (let j = i + 1; j < K; j++) {
        const b = used[j] * 3;
        const dL = plab[a] - plab[b], da = plab[a + 1] - plab[b + 1], db = plab[a + 2] - plab[b + 2];
        D[i * K + j] = D[j * K + i] = dL * dL + da * da + db * db;
      }
    }
    const alive = new Uint8Array(K).fill(1);
    const cnt = new Float64Array(K);
    for (let i = 0; i < K; i++) cnt[i] = counts[used[i]];
    const nn = new Int32Array(K), nd = new Float32Array(K);
    function recompute(i) {
      let b = -1, bd = Infinity;
      for (let j = 0; j < K; j++) {
        if (!alive[j] || j === i) continue;
        const d = D[i * K + j];
        if (d < bd) { bd = d; b = j; }
      }
      nn[i] = b; nd[i] = bd;
    }
    for (let i = 0; i < K; i++) recompute(i);
    let left = K;
    while (left > nColors) {
      let bi = -1, bc = Infinity;
      for (let i = 0; i < K; i++) {
        if (!alive[i]) continue;
        const cost = cnt[i] * nd[i];
        if (cost < bc) { bc = cost; bi = i; }
      }
      const j = nn[bi];
      cnt[j] += cnt[bi];
      alive[bi] = 0;
      left--;
      for (let i = 0; i < K; i++) if (alive[i] && nn[i] === bi) recompute(i);
    }
    const out = [];
    for (let i = 0; i < K; i++) if (alive[i]) out.push(used[i]);
    return out;
  }

  /* Убирает одиночные стразы — «шум», который неудобно выкладывать. */
  function cleanup(idx, lab, sel, plab, cols, rows, level) {
    // Заменяем только на близкий по цвету соседний оттенок: яркие акценты
    // (звёзды, огоньки) остаются, а картинка не уходит от оригинала.
    const limit = level === 2 ? 0.2 * 0.2 : 0.12 * 0.12;
    // сколько одноцветных соседей допускается на каждом проходе: 0 — совсем одиночные,
    // 1 — ещё и «хвостики» из двух страз; после них повторно добираем одиночные
    const plan = level === 2 ? [0, 1, 0, 0] : [0];
    for (let pass = 0; pass < plan.length; pass++) {
      const maxSame = plan[pass];
      const prev = idx.slice();
      const votes = new Uint16Array(sel.length);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x, k = prev[i];
          let same = 0;
          const seen = [];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= rows) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if ((dx === 0 && dy === 0) || xx < 0 || xx >= cols) continue;
              const q = prev[yy * cols + xx];
              if (q === k) same++;
              else { if (votes[q] === 0) seen.push(q); votes[q]++; }
            }
          }
          if (same <= maxSame && seen.length) {
            const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
            let best = -1, bv = 0, bd = Infinity;
            for (let s = 0; s < seen.length; s++) {
              const q = seen[s], p = sel[q] * 3;
              const dL = L - plab[p], da = a - plab[p + 1], db = b - plab[p + 2];
              const d = dL * dL + da * da + db * db;
              if (d < bd || (d === bd && votes[q] > bv)) { bv = votes[q]; bd = d; best = q; }
            }
            if (best >= 0 && bd <= limit) idx[i] = best;
          }
          for (let s = 0; s < seen.length; s++) votes[seen[s]] = 0;
        }
      }
    }
  }

  /* opts: nColors, dither (0..1), cleanup (0|1|2) */
  function quantizeCore(grid, pal, opts) {
    const cols = grid.cols, rows = grid.rows, n = cols * rows, lab = grid.lab;
    const plab = pal.lab, P = pal.items.length;
    const nColors = Math.max(2, Math.min(MAX_COLORS, opts.nColors | 0));

    // а) ближайший цвет из всей палитры для каждой клетки
    const all = [];
    for (let p = 0; p < P; p++) all.push(p);
    const counts = new Uint32Array(P);
    for (let i = 0; i < n; i++) counts[all[nearest(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], plab, all)]]++;
    const used = all.filter(function (p) { return counts[p] > 0; });

    // б) сокращаем до нужного числа цветов
    const sel = reducePalette(used, counts, plab, nColors);

    // в) раскладываем клетки по выбранным цветам
    const idx = new Uint16Array(n);
    const dither = opts.dither || 0;
    if (dither > 0) {
      const w = Float32Array.from(lab);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x, o = i * 3;
          const k = nearest(w[o], w[o + 1], w[o + 2], plab, sel);
          idx[i] = k;
          const p = sel[k] * 3;
          for (let c = 0; c < 3; c++) {
            const e = (w[o + c] - plab[p + c]) * dither;
            if (x + 1 < cols) w[o + 3 + c] += e * 0.4375;
            if (y + 1 < rows) {
              if (x > 0) w[o + (cols - 1) * 3 + c] += e * 0.1875;
              w[o + cols * 3 + c] += e * 0.3125;
              if (x + 1 < cols) w[o + (cols + 1) * 3 + c] += e * 0.0625;
            }
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) idx[i] = nearest(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], plab, sel);
    }

    // г) чистим одиночные стразы
    if (opts.cleanup > 0) cleanup(idx, lab, sel, plab, cols, rows, opts.cleanup);

    // д) убираем цвета, которых вышло слишком мало: их стразы уходят к ближайшему из оставшихся
    const minCount = opts.minCount | 0;
    const selCount = new Uint32Array(sel.length);
    for (let i = 0; i < n; i++) selCount[idx[i]]++;
    if (minCount > 1) {
      for (;;) {
        let worst = -1, live = 0;
        for (let k = 0; k < sel.length; k++) {
          if (!selCount[k]) continue;
          live++;
          if (selCount[k] < minCount && (worst < 0 || selCount[k] < selCount[worst])) worst = k;
        }
        if (worst < 0 || live <= 2) break;
        const others = [];
        for (let k = 0; k < sel.length; k++) if (selCount[k] && k !== worst) others.push(k);
        const list = others.map(function (k) { return sel[k]; });
        for (let i = 0; i < n; i++) {
          if (idx[i] !== worst) continue;
          const k = others[nearest(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], plab, list)];
          idx[i] = k;
          selCount[k]++;
        }
        selCount[worst] = 0;
      }
    }

    let picked = 0;
    for (let k = 0; k < sel.length; k++) if (selCount[k]) picked++;
    return { cols: cols, rows: rows, idx: idx, sel: sel, pal: pal, picked: picked };
  }

  /* Итог: цвета по порядку номеров (как в легенде программы), значки, количества.
   * Поверх автоматического подбора накладываются ручные правки (over):
   *   replace — Map: номер, выбранный программой → цвет, назначенный вручную;
   *             если такой номер уже есть в схеме, стразы сливаются с ним;
   *   paint   — Map: номер клетки → номер цвета (прорисовка кистью), itemOf(номер) → цвет;
   *   symbols — Map: номер цвета → значок;
   *   print   — Map: номер цвета → {r, g, b, hex} — каким цветом печатать клетку на схеме. */
  function compose(core, over) {
    over = over || {};
    const pal = core.pal, sel = core.sel, idx = core.idx, n = idx.length;
    const replace = over.replace && over.replace.size ? over.replace : null;
    const paint = over.paint && over.paint.size && over.itemOf ? over.paint : null;
    const groups = [], byCode = new Map(), painted = new Map();
    function gid(it) {
      let g = byCode.get(it.code);
      if (g === undefined) {
        g = groups.length;
        byCode.set(it.code, g);
        groups.push({ item: it, count: 0, from: [], own: false, painted: 0 });
      }
      return g;
    }
    const selG = new Int32Array(sel.length).fill(-1);
    const cellG = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let g = -1;
      if (paint) {
        const code = paint.get(i);
        if (code !== undefined) {
          g = painted.get(code);
          if (g === undefined) {
            const it = over.itemOf(code);
            g = it ? gid(it) : -1; // номера нет в таблице — клетка остаётся как подобрала программа
            painted.set(code, g);
          }
          if (g >= 0) groups[g].painted++;
        }
      }
      if (g < 0) {
        const k = idx[i];
        g = selG[k];
        if (g < 0) {
          const own = pal.items[sel[k]];
          const it = (replace && replace.get(own.code)) || own;
          g = gid(it);
          if (it.code === own.code) groups[g].own = true; else groups[g].from.push(own.code);
          selG[k] = g;
        }
      }
      groups[g].count++;
      cellG[i] = g;
    }
    const list = groups.filter(function (g) { return g.count > 0; }).sort(function (a, b) {
      return a.item.code < b.item.code ? -1 : a.item.code > b.item.code ? 1 : 0;
    });
    // значки: сначала назначенные вручную, остальным — первые свободные по порядку
    const used = new Set();
    list.forEach(function (g) {
      const s = over.symbols && over.symbols.get(g.item.code);
      if (s && !used.has(s)) { g.symbol = s; used.add(s); }
    });
    let next = 0;
    list.forEach(function (g) {
      if (g.symbol) return;
      while (next < ALL_SYMBOLS.length && used.has(ALL_SYMBOLS[next])) next++;
      g.symbol = ALL_SYMBOLS[next] || '?';
      used.add(g.symbol);
    });
    const colors = list.map(function (g, pos) {
      g.pos = pos;
      const it = g.item;
      let pr = over.print && over.print.get(it.code);
      // совсем тёмная клетка печатается светлее: значок читается, краски уходит меньше
      if (!pr && over.autoLight && 0.299 * it.r + 0.587 * it.g + 0.114 * it.b < 85) pr = lighter(it, 0.62);
      return {
        code: it.code, hex: it.hex, r: it.r, g: it.g, b: it.b,
        symbol: g.symbol, count: g.count, dark: isDark(it),
        from: g.from,       // номера, которые программа выбрала сама, а пользователь заменил на этот
        own: g.own,         // программа выбрала этот номер и сама
        painted: g.painted, // сколько страз этого цвета поставлено кистью
        print: pr ? { r: pr.r, g: pr.g, b: pr.b, hex: pr.hex, dark: isDark(pr) } : null
      };
    });
    const cells = new Uint8Array(n);
    for (let i = 0; i < n; i++) cells[i] = groups[cellG[i]].pos;
    return { cols: core.cols, rows: core.rows, cells: cells, colors: colors, picked: core.picked };
  }

  function isDark(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b < 140; }

  function lighter(c, t) {
    const r = Math.round(c.r + (255 - c.r) * t), g = Math.round(c.g + (255 - c.g) * t), b = Math.round(c.b + (255 - c.b) * t);
    return { r: r, g: g, b: b, hex: '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1) };
  }

  function quantize(grid, pal, opts) {
    return compose(quantizeCore(grid, pal, opts), opts);
  }

  A.SYMBOLS = SYMBOLS;
  A.SHAPES = SHAPES;
  A.ALL_SYMBOLS = ALL_SYMBOLS;
  A.MAX_COLORS = MAX_COLORS;
  A.MAX_PALETTE = MAX_PALETTE;
  A.parsePalette = parsePalette;
  A.paletteFromItems = paletteFromItems;
  A.parsePaletteText = parsePaletteText;
  A.paletteWithout = paletteWithout;
  A.cropRect = cropRect;
  A.downscale = downscale;
  A.sampleGrid = sampleGrid;
  A.quantize = quantize;
  A.quantizeCore = quantizeCore;
  A.compose = compose;
  A.makeCanvas = makeCanvas;
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
