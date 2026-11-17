/* Художественные эффекты для «Фото на полотне»: масло, акварель, карандаш, комикс, постер.
 * Всё считается в браузере, без библиотек. Размеры кисти и линий заданы в мм на напечатанном
 * холсте, поэтому превью и файл для печати выглядят одинаково: тяжёлая стилизация идёт на
 * внутреннем разрешении, привязанном к размеру кисти (а не к ppc), а мазки, рельеф и фактура
 * бумаги считаются в мм-координатах на полном разрешении, полосами — чтобы хватило памяти
 * на 30–50 Мп печати. */
(function (A) {
  'use strict';

  /* size — мм на холсте (ширина кисти / толщина линии / крупность деталей), relief — применим
   * ли ползунок «рельеф/фактура» 0..100, reliefDef — его значение по умолчанию.
   * API: apply(src, { effect, ppc, size, relief, amount, seed, onProgress, isCancelled }) → новый холст
   * того же размера; при отмене бросает { cancelled: true }. */
  const EFFECTS = [
    { id: 'none', name: 'Без эффекта' },
    { id: 'oil', name: 'Масляная живопись', size: { def: 5, min: 2, max: 14, step: 0.5 }, relief: true, reliefDef: 45 },
    { id: 'watercolor', name: 'Акварель', size: { def: 5, min: 2, max: 16, step: 0.5 }, relief: true, reliefDef: 50 },
    { id: 'pencil', name: 'Карандашный рисунок', size: { def: 1, min: 0.4, max: 2.5, step: 0.1 }, relief: true, reliefDef: 50 },
    { id: 'colorpencil', name: 'Цветной карандаш', size: { def: 1.2, min: 0.4, max: 2.5, step: 0.1 }, relief: true, reliefDef: 50 },
    { id: 'cartoon', name: 'Комикс', size: { def: 1.2, min: 0.4, max: 4, step: 0.1 } },
    { id: 'poster', name: 'Постер', size: { def: 3, min: 1, max: 10, step: 0.5 } }
  ];

  // ---------- служебное ----------
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  // Потолок внутреннего разрешения для тяжёлых фильтров: на телефоне меньше — меньше памяти и времени
  const CAP_HEAVY = COARSE ? 0.6e6 : 1.2e6;
  const CAP_LIGHT = COARSE ? 1.2e6 : 2.5e6;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth01(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }
  function sstep(a, b, x) { return smooth01((x - a) / (b - a)); }

  /* Уступаем поток через MessageChannel: setTimeout в фоновой вкладке зажимается до 1 с,
   * и печать «зависла» бы, если пользователь переключился на другую вкладку. */
  let chan = null;
  const waiting = [];
  function yieldNow() {
    if (typeof MessageChannel === 'undefined') return new Promise(r => setTimeout(r, 0));
    if (!chan) {
      chan = new MessageChannel();
      chan.port1.onmessage = function () { const r = waiting.shift(); if (r) r(); };
    }
    return new Promise(r => { waiting.push(r); chan.port2.postMessage(0); });
  }

  function makeJob(opts) {
    let last = now(), lo = 0, hi = 1, tm = now();
    const onP = opts.onProgress, isC = opts.isCancelled, marks = [];
    function check() { if (isC && isC()) throw { cancelled: true }; }
    return {
      check: check,
      marks: marks,
      // засечки времени по этапам — для отладки скорости (A.canvasFx.lastStats)
      mark(name) { const t = now(); marks.push(name + ' ' + Math.round(t - tm)); tm = t; },
      stage(a, b) { lo = a; hi = b; },
      // Вызывать часто: реально уступает поток не чаще раза в ~45 мс
      async tick(f) {
        const t = now();
        if (t - last < 45) return;
        if (onP) { try { onP(lo + (hi - lo) * clamp(f || 0, 0, 1)); } catch (e) { /* UI не должен ронять расчёт */ } }
        await yieldNow();
        check();
        last = now();
      }
    };
  }

  // ---------- детерминированный шум (от seed и мм-координат, не от пикселей) ----------
  function mix32(h) {
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function hash3(a, b, c, seed) {
    return mix32(Math.imul(a | 0, 0x9E3779B1) ^ Math.imul((b | 0) + 0x632BE5AB, 0x85EBCA77) ^
      Math.imul((c | 0) + 0x2545F491, 0xC2B2AE3D) ^ seed);
  }
  // Маленький ГПСЧ (mulberry32) для параметров одного мазка
  function rng(h) {
    let s = h | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Таблица случайных чисел 0..1 — для дешёвого шума во внутренних циклах
  function randTable(n, seed) {
    const t = new Float32Array(n), r = rng(seed ^ 0x1234567);
    for (let i = 0; i < n; i++) t[i] = r();
    return t;
  }

  // Значения шума в узлах решётки; period > 0 — плитка без швов
  function vnoise(u, v, salt, seed, period) {
    let i0 = Math.floor(u), j0 = Math.floor(v);
    const fu = u - i0, fv = v - j0;
    let i1 = i0 + 1, j1 = j0 + 1;
    if (period) {
      i0 = ((i0 % period) + period) % period; i1 = ((i1 % period) + period) % period;
      j0 = ((j0 % period) + period) % period; j1 = ((j1 % period) + period) % period;
    }
    const a = hash3(i0, j0, salt, seed) / 4294967296, b = hash3(i1, j0, salt, seed) / 4294967296;
    const c = hash3(i0, j1, salt, seed) / 4294967296, d = hash3(i1, j1, salt, seed) / 4294967296;
    const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
    return (a + (b - a) * su) * (1 - sv) + (c + (d - c) * su) * sv;
  }

  /* Плоскость низкочастотного шума (−1..1) на внутреннем разрешении; lam — длина волны в мм. */
  function noisePlane(w, h, pim, lam, oct, salt, seed) {
    const p = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xm = (x + 0.5) / pim, ym = (y + 0.5) / pim;
        let v = 0, amp = 1, norm = 0, l = lam;
        for (let o = 0; o < oct; o++) {
          v += amp * vnoise(xm / l + o * 17.3, ym / l - o * 9.1, salt + o, seed);
          norm += amp; amp *= 0.5; l *= 0.5;
        }
        p[y * w + x] = (v / norm) * 2 - 1;
      }
    }
    return p;
  }

  /* Плитка мелкой фактуры бумаги (−1..1) примерно 32×32 мм в пикселях итогового изображения.
   * Октавы мельче ~2 px гасятся — иначе на маленьком превью вместо зерна рябь. */
  function grainTile(ppm, seed, octs) {
    const T = Math.max(8, Math.round(32 * ppm));
    const tile = new Float32Array(T * T);
    let norm = 0;
    for (let k = 0; k < octs.length; k++) {
      const lam = octs[k][0], wgt = octs[k][1];
      const cells = Math.max(1, Math.round(32 / lam));
      const lod = sstep(2, 4, T / cells);
      norm += wgt * Math.max(lod, 0.5);
      if (lod <= 0) continue;
      for (let y = 0; y < T; y++) {
        const v = y / T * cells;
        for (let x = 0; x < T; x++) {
          tile[y * T + x] += wgt * lod * (vnoise(x / T * cells, v, 77 + k, seed, cells) * 2 - 1);
        }
      }
    }
    if (norm > 0) for (let i = 0; i < tile.length; i++) tile[i] = clamp(tile[i] / norm * 1.6, -1, 1);
    return { T: T, t: tile };
  }

  // ---------- плоскости Float32 ----------
  /* Уменьшение ступенями по 2 раза (без ряби), затем RGB-плоскости 0..1. */
  function readPlanes(src, w, h) {
    let cur = src, cw = src.width, ch = src.height;
    const tmp = [];
    while (cw > w * 2 && ch > h * 2) {
      const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
      const t = A.makeCanvas(nw, nh), tc = t.getContext('2d');
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      tmp.push(t); cur = t; cw = nw; ch = nh;
    }
    let data;
    if (cw === w && ch === h) {
      data = cur.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    } else {
      const t = A.makeCanvas(w, h), tc = t.getContext('2d', { willReadFrequently: true });
      tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
      tc.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
      data = tc.getImageData(0, 0, w, h).data;
      tmp.push(t);
    }
    tmp.forEach(c => { c.width = c.height = 0; });
    const n = w * h, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      R[i] = data[j] / 255; G[i] = data[j + 1] / 255; B[i] = data[j + 2] / 255;
    }
    return { R: R, G: G, B: B };
  }

  function lumaPlane(R, G, B) {
    const n = R.length, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    return L;
  }

  // sRGB 0..1 -> Oklab (расстояния в нём ближе к восприятию)
  function lin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function oklab(r, g, b, OL, OA, OB, i) {
    const R = lin(r), G = lin(g), B = lin(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    OL[i] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    OA[i] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    OB[i] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  }

  // Размытие по Гауссу: при малой сигме — честное ядро, при большой — три box-прохода (O(n))
  function blurH(s, d, w, h, k, r) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          let xx = x + i; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          acc += s[o + xx] * k[i + r];
        }
        d[o + x] = acc;
      }
    }
  }
  function blurV(s, d, w, h, k, r) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) d[o + x] = 0;
      for (let i = -r; i <= r; i++) {
        let yy = y + i; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
        const kk = k[i + r], oo = yy * w;
        for (let x = 0; x < w; x++) d[o + x] += s[oo + x] * kk;
      }
    }
  }
  function boxH(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let k = -r - 1; k < r; k++) acc += s[o + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        const a = x + r, b = x - r - 1;
        acc += s[o + (a >= w ? w - 1 : a)] - s[o + (b < 0 ? 0 : b)];
        d[o + x] = acc * inv;
      }
    }
  }
  function boxV(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1), acc = new Float64Array(w);
    for (let k = -r - 1; k < r; k++) {
      const o = (k < 0 ? 0 : k >= h ? h - 1 : k) * w;
      for (let x = 0; x < w; x++) acc[x] += s[o + x];
    }
    for (let y = 0; y < h; y++) {
      const a = y + r, b = y - r - 1;
      const oa = (a >= h ? h - 1 : a) * w, ob = (b < 0 ? 0 : b) * w, o = y * w;
      for (let x = 0; x < w; x++) { acc[x] += s[oa + x] - s[ob + x]; d[o + x] = acc[x] * inv; }
    }
  }
  function gauss(p, w, h, sigma, tmp) {
    if (!(sigma > 0.25)) return p;
    tmp = tmp && tmp.length >= p.length ? tmp : new Float32Array(p.length);
    if (sigma <= 2.5) {
      const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
      let s = 0;
      for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
      for (let i = 0; i < k.length; i++) k[i] /= s;
      blurH(p, tmp, w, h, k, r); blurV(tmp, p, w, h, k, r);
      return p;
    }
    // ширины трёх box-фильтров, дающих нужную сигму
    const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    for (let i = 0; i < n; i++) {
      const r = ((i < m ? wl : wl + 2) - 1) >> 1;
      boxH(p, tmp, w, h, r); boxV(tmp, p, w, h, r);
    }
    return p;
  }
  const blurCopy = (p, w, h, s, tmp) => gauss(Float32Array.from(p), w, h, s, tmp);

  /* Структурный тензор по RGB (Собель): E = gx², F = gx·gy, G = gy². */
  function tensor(R, G, B, w, h) {
    const n = w * h, E = new Float32Array(n), F = new Float32Array(n), Gt = new Float32Array(n);
    const ch = [R, G, B];
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : 0) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
        let e = 0, f = 0, g = 0;
        for (let c = 0; c < 3; c++) {
          const p = ch[c];
          const gx = (p[ym + xp] + 2 * p[y0 + xp] + p[yp + xp] - p[ym + xm] - 2 * p[y0 + xm] - p[yp + xm]) * 0.25;
          const gy = (p[yp + xm] + 2 * p[yp + x] + p[yp + xp] - p[ym + xm] - 2 * p[ym + x] - p[ym + xp]) * 0.25;
          e += gx * gx; f += gx * gy; g += gy * gy;
        }
        E[y0 + x] = e; F[y0 + x] = f; Gt[y0 + x] = g;
      }
    }
    return { E: E, F: F, G: Gt };
  }

  /* Касательная к структуре (вдоль контуров) и анизотропия 0..1 из сглаженного тензора. */
  function tangentField(T, n) {
    const TX = new Float32Array(n), TY = new Float32Array(n), AN = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const e = T.E[i], f = T.F[i], g = T.G[i];
      const d = Math.sqrt((e - g) * (e - g) + 4 * f * f);
      const l1 = (e + g + d) * 0.5, l2 = (e + g - d) * 0.5;
      let tx = l1 - e, ty = -f;
      const len = Math.sqrt(tx * tx + ty * ty);
      if (len > 1e-12) { tx /= len; ty /= len; } else { tx = 0; ty = 1; }
      TX[i] = tx; TY[i] = ty;
      AN[i] = l1 + l2 > 1e-9 ? (l1 - l2) / (l1 + l2) : 0;
    }
    return { TX: TX, TY: TY, AN: AN };
  }

  /* Анизотропный фильтр Кувахары (Kyprianidis и др., 8 секторов с полиномиальными весами).
   * Даёт «мазки» — плоские пятна цвета, вытянутые вдоль контуров, и не размывает границы. */
  async function kuwahara(job, P, w, h, fld, radius, q) {
    const n = w * h, R = P.R, G = P.G, B = P.B;
    const oR = new Float32Array(n), oG = new Float32Array(n), oB = new Float32Array(n);
    const TX = fld.TX, TY = fld.TY, AN = fld.AN;
    const zeta = 2 / radius, zc = 3 * Math.PI / 8, sz = Math.sin(zc);
    const eta = (zeta + Math.cos(zc)) / (sz * sz), SQ = Math.SQRT1_2;
    const GT = new Float32Array(258);
    for (let i = 0; i < 258; i++) GT[i] = Math.exp(-3.125 * i / 256);
    const acc = new Float64Array(40), wk = new Float64Array(8);
    const hq = q / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, tx = TX[i], ty = TY[i], an = AN[i];
        const a = radius * clamp(1 + an, 0.1, 2), b = radius * clamp(1 / (1 + an), 0.1, 2);
        const m00 = tx / a, m01 = ty / a, m10 = -ty / b, m11 = tx / b;
        const mx = Math.floor(Math.sqrt(a * a * tx * tx + b * b * ty * ty));
        const my = Math.floor(Math.sqrt(a * a * ty * ty + b * b * tx * tx));
        acc.fill(0);
        for (let j = -my; j <= my; j++) {
          let yy = y + j; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          const row = yy * w;
          for (let ii = -mx; ii <= mx; ii++) {
            const vx = m00 * ii + m01 * j, vy = m10 * ii + m11 * j, d2 = vx * vx + vy * vy;
            if (d2 > 1) continue;
            let xx = x + ii; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
            const k = row + xx, cr = R[k], cg = G[k], cb = B[k], qq = cr * cr + cg * cg + cb * cb;
            let vxx = zeta - eta * vx * vx, vyy = zeta - eta * vy * vy, z, sum = 0;
            z = vy + vxx; z = z > 0 ? z * z : 0; wk[0] = z; sum += z;
            z = -vx + vyy; z = z > 0 ? z * z : 0; wk[2] = z; sum += z;
            z = -vy + vxx; z = z > 0 ? z * z : 0; wk[4] = z; sum += z;
            z = vx + vyy; z = z > 0 ? z * z : 0; wk[6] = z; sum += z;
            const ux = (vx - vy) * SQ, uy = (vx + vy) * SQ;
            vxx = zeta - eta * ux * ux; vyy = zeta - eta * uy * uy;
            z = uy + vxx; z = z > 0 ? z * z : 0; wk[1] = z; sum += z;
            z = -ux + vyy; z = z > 0 ? z * z : 0; wk[3] = z; sum += z;
            z = -uy + vxx; z = z > 0 ? z * z : 0; wk[5] = z; sum += z;
            z = ux + vyy; z = z > 0 ? z * z : 0; wk[7] = z; sum += z;
            if (sum <= 0) continue;
            const g = GT[(d2 * 256) | 0] / sum;
            for (let s = 0, o = 0; s < 8; s++, o += 5) {
              const wv = wk[s] * g;
              if (wv === 0) continue;
              acc[o] += wv; acc[o + 1] += cr * wv; acc[o + 2] += cg * wv; acc[o + 3] += cb * wv; acc[o + 4] += qq * wv;
            }
          }
        }
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let s = 0, o = 0; s < 8; s++, o += 5) {
          const ws = acc[o];
          if (ws <= 0) continue;
          const mr = acc[o + 1] / ws, mg = acc[o + 2] / ws, mb = acc[o + 3] / ws;
          let v = acc[o + 4] / ws - (mr * mr + mg * mg + mb * mb);
          v = v < 0 ? -v : v;
          const wgt = 1 / (1 + Math.pow(1000 * v, hq));
          sr += mr * wgt; sg += mg * wgt; sb += mb * wgt; sw += wgt;
        }
        if (sw > 0) { oR[i] = sr / sw; oG[i] = sg / sw; oB[i] = sb / sw; } else { oR[i] = R[i]; oG[i] = G[i]; oB[i] = B[i]; }
      }
      await job.tick(y / h);
    }
    return { R: oR, G: oG, B: oB };
  }

  /* Насыщенность и лёгкий контраст на плоскостях. */
  function saturate(P, k, contrast) {
    const n = P.R.length;
    for (let i = 0; i < n; i++) {
      const r = P.R[i], g = P.G[i], b = P.B[i], l = 0.299 * r + 0.587 * g + 0.114 * b;
      let lc = l;
      if (contrast) lc = clamp(l + contrast * (l - 0.5) * (1 - Math.abs(l - 0.5) * 2) * 2, 0, 1);
      P.R[i] = clamp(lc + (r - l) * k, 0, 1);
      P.G[i] = clamp(lc + (g - l) * k, 0, 1);
      P.B[i] = clamp(lc + (b - l) * k, 0, 1);
    }
  }

  function sobelMag(L, w, h) {
    const M = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : 0) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
        const gx = (L[ym + xp] + 2 * L[y0 + xp] + L[yp + xp] - L[ym + xm] - 2 * L[y0 + xm] - L[yp + xm]) * 0.25;
        const gy = (L[yp + xm] + 2 * L[yp + x] + L[yp + xp] - L[ym + xm] - 2 * L[ym + x] - L[ym + xp]) * 0.25;
        M[y0 + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }
    return M;
  }

  // ---------- переход «внутреннее разрешение → полное» ----------
  /* Для каждого столбца полного размера — левый узел и доля во внутренней сетке (билинейно). */
  function axisMap(n, ni) {
    const i0 = new Int32Array(n), f = new Float32Array(n), sc = ni / n;
    for (let x = 0; x < n; x++) {
      let p = (x + 0.5) * sc - 0.5;
      p = p < 0 ? 0 : p > ni - 1 ? ni - 1 : p;
      let k = Math.floor(p);
      if (k > ni - 2) k = Math.max(0, ni - 2);
      i0[x] = k; f[x] = p - k;
    }
    return { i0: i0, f: f };
  }
  /* Строка плоскости, растянутая до полной ширины. */
  function upRow(p, wi, ym, y, xm, outRow) {
    const j0 = ym.i0[y], fy = ym.f[y], o0 = j0 * wi, o1 = o0 + wi;
    const I = xm.i0, F = xm.f, n = outRow.length;
    for (let x = 0; x < n; x++) {
      const k = I[x], fx = F[x];
      const a = p[o0 + k] + (p[o0 + k + 1] - p[o0 + k]) * fx;
      const b = p[o1 + k] + (p[o1 + k + 1] - p[o1 + k]) * fx;
      outRow[x] = a + (b - a) * fy;
    }
  }
  /* Значение плоскости в произвольной точке (внутренние пиксели). */
  function samp(p, w, h, x, y) {
    x = x < 0 ? 0 : x > w - 1.001 ? w - 1.001 : x;
    y = y < 0 ? 0 : y > h - 1.001 ? h - 1.001 : y;
    const i = x | 0, j = y | 0, fx = x - i, fy = y - j, o = j * w + i;
    const a = p[o] + (p[o + 1] - p[o]) * fx, b = p[o + w] + (p[o + w + 1] - p[o + w]) * fx;
    return a + (b - a) * fy;
  }

  /* Итог считается полосами: bandFn заполняет RGBA полосы, потом смешиваем с оригиналом
   * (amount) и кладём в холст. Целиком 30–50 Мп в Float32 не держим. */
  async function compose(job, src, out, W, H, amount, bandFn, bandPx) {
    const octx = out.getContext('2d');
    const sctx = amount < 0.999 ? src.getContext('2d', { willReadFrequently: true }) : null;
    const bh = Math.max(4, Math.min(H, Math.floor((bandPx || 1.5e6) / W)));
    for (let y0 = 0; y0 < H; y0 += bh) {
      const h = Math.min(bh, H - y0);
      const img = octx.createImageData(W, h), d = img.data;
      await bandFn(d, y0, h);
      if (sctx) {
        const s = sctx.getImageData(0, y0, W, h).data, a = amount, b = 1 - amount;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = d[i] * a + s[i] * b; d[i + 1] = d[i + 1] * a + s[i + 1] * b; d[i + 2] = d[i + 2] * a + s[i + 2] * b;
        }
      }
      octx.putImageData(img, 0, y0);
      await job.tick((y0 + h) / H);
    }
  }

  /* Внутреннее разрешение: k пикселей на «размер» (мм), но не больше исходника и потолка. */
  function internalSize(W, H, ppm, sizeMm, k, cap) {
    const s = Math.min(1, k / (sizeMm * ppm), Math.sqrt(cap / (W * H)));
    const wi = Math.max(16, Math.round(W * s)), hi = Math.max(16, Math.round(H * s));
    return { wi: wi, hi: hi, pim: wi / W * ppm };
  }

  // ================= МАСЛО =================
  /* Схема: Кувахара на внутреннем разрешении (~6 px на ширину кисти) упрощает цвет, тензор
   * задаёт направление мазков; на полном разрешении полосами «кладутся» мазки: у каждого своя
   * краска, форма с рваным хвостом, бороздки щетины и толщина. Высота мазков освещается сверху
   * слева — получается рельеф пасты. Мазки разбросаны по сетке в мм с seed, поэтому на превью
   * и в печати они одни и те же. */
  async function fxOil(job, src, out, W, H, o) {
    const ppm = o.ppc / 10, bw = o.size;
    const { wi, hi, pim } = internalSize(W, H, ppm, bw, 6, CAP_HEAVY);
    const n = wi * hi;
    job.stage(0, 0.04);
    const P0 = readPlanes(src, wi, hi);
    const tmp = new Float32Array(n);
    // тензор: мелкий — для Кувахары, крупный — для направления мазков
    const T0 = tensor(P0.R, P0.G, P0.B, wi, hi);
    await job.tick(1);
    const Tk = { E: blurCopy(T0.E, wi, hi, 2, tmp), F: blurCopy(T0.F, wi, hi, 2, tmp), G: blurCopy(T0.G, wi, hi, 2, tmp) };
    const sf = Math.max(1.5, bw * pim * 0.9), sl = sf * 3;
    const Ts = { E: blurCopy(T0.E, wi, hi, sf, tmp), F: blurCopy(T0.F, wi, hi, sf, tmp), G: blurCopy(T0.G, wi, hi, sf, tmp) };
    const Tl = { E: blurCopy(T0.E, wi, hi, sl, tmp), F: blurCopy(T0.F, wi, hi, sl, tmp), G: blurCopy(T0.G, wi, hi, sl, tmp) };
    // совсем крупный масштаб: на гладкой воде или небе мазки идут вдоль горизонта и крупных линий
    const sv = Math.max(sl * 2.5, Math.min(wi, hi) * 0.06);
    const Tv = { E: gauss(T0.E, wi, hi, sv, tmp), F: gauss(T0.F, wi, hi, sv, tmp), G: gauss(T0.G, wi, hi, sv, tmp) };
    // направление мазков в «двойном угле» (чтобы направления с разным знаком не гасили друг друга)
    const FC = new Float32Array(n), FS = new Float32Array(n);
    // На ровных участках (небо, стена) структуры нет: направление задаёт «рука художника» —
    // плавный шум в мм, иначе мазки ложатся одинаково, как кирпичная кладка.
    const NA = noisePlane(wi, hi, pim, bw * 9, 2, 5, o.seed);
    for (let i = 0; i < n; i++) {
      const ts = Ts.E[i] + Ts.G[i] + 1e-6, tl = Tl.E[i] + Tl.G[i] + 1e-6, tv = Tv.E[i] + Tv.G[i] + 1e-6;
      const a0 = -0.5 + 1.3 * NA[i];
      // для касательной знак двойного угла меняется на противоположный
      FC[i] = -(Ts.E[i] - Ts.G[i]) / ts - 0.6 * (Tl.E[i] - Tl.G[i]) / tl - 0.4 * (Tv.E[i] - Tv.G[i]) / tv + 0.14 * Math.cos(2 * a0);
      FS[i] = -2 * Ts.F[i] / ts - 1.2 * Tl.F[i] / tl - 0.8 * Tv.F[i] / tv + 0.14 * Math.sin(2 * a0);
    }
    await job.tick(1);
    job.stage(0.04, 0.4);
    const radius = clamp(0.5 * bw * pim, 2, 6);
    job.mark('prep');
    const K = await kuwahara(job, P0, wi, hi, tangentField(Tk, n), radius, 8);
    job.mark('kuwahara ' + wi + 'x' + hi + ' r' + radius.toFixed(1));
    saturate(K, 1.15, 0.08);
    // карта деталей: где контраст на ширине кисти велик — кладём мелкие мазки поверх
    const Lk = lumaPlane(K.R, K.G, K.B);
    const D = gauss(sobelMag(Lk, wi, hi), wi, hi, Math.max(1, bw * pim * 0.5), tmp);
    for (let i = 0; i < n; i++) D[i] = sstep(0.06, 0.3, D[i] * pim * bw);
    await job.tick(1);

    // ---- мазки на полном разрешении ----
    job.stage(0.4, 1);
    const seed = o.seed;
    const BT = randTable(1024, seed);
    const xm = axisMap(W, wi), ym = axisMap(H, hi);
    const cell0 = 0.72 * bw, cell1 = 0.36 * bw;
    const marg = 2.2 * bw; // максимальная полудлина мазка, мм
    const relief = o.relief;
    const thick = 0.085 * bw * (0.1 + 1.7 * relief); // толщина пасты, мм на единицу высоты
    const kH = thick * ppm * 0.5;
    const Lx = -0.42, Ly = -0.58, Lz = 0.7; // свет сверху слева
    const ll = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz), lx = Lx / ll, ly = Ly / ll, lz = Lz / ll;
    let hx = lx, hy = ly, hz = lz + 1; const hl = Math.sqrt(hx * hx + hy * hy + hz * hz); hx /= hl; hy /= hl; hz /= hl;
    const specFlat = Math.pow(hz, 28), specK = 0.18 * relief;
    const shadeK = 0.55 + 0.45 * Math.min(1, relief * 2);
    const tau2 = 0.09; // насколько далёкий цвет мазка ещё «перетягивает» локальный (границы лица)
    const softMm = 0.15 + 0.07 * bw; // мягкость края мазка, мм (край пасты скруглён, а не ступенька)
    const grooveMm = 0.42; // шаг бороздок щетины, мм
    const lod = sstep(1.5, 3.5, grooveMm * ppm);

    function makeDab(L, ci, cj, out) {
      const r = rng(hash3(ci, cj, L + 11, seed));
      const cell = L ? cell1 : cell0;
      const x = (ci + r()) * cell, y = (cj + r()) * cell;
      const xi = x * pim - 0.5, yi = y * pim - 0.5;
      const det = samp(D, wi, hi, xi, yi);
      const r1 = r(), r2 = r(), r3 = r(), r4 = r(), r5 = r(), r6 = r(), r7 = r(), r8 = r(), r9 = r();
      if (L === 1 && r9 > det * 1.3 - 0.15) return false;
      const fc = samp(FC, wi, hi, xi, yi), fs = samp(FS, wi, hi, xi, yi);
      const coh = Math.min(1, Math.sqrt(fc * fc + fs * fs));
      const ang = 0.5 * Math.atan2(fs, fc) + (r1 - 0.5) * (0.25 + 0.5 * (1 - coh));
      let dx = Math.cos(ang), dy = Math.sin(ang);
      if (r2 < 0.5) { dx = -dx; dy = -dy; }
      const len = L ? bw * (1.0 + 0.8 * r3) : bw * (2.0 + 2.0 * r3) * (1 - 0.45 * det);
      const wid = L ? bw * (0.45 + 0.15 * r4) : bw * (0.8 + 0.35 * r4) * (1 - 0.25 * det);
      // своя «замешанная» краска у каждого мазка: чуть светлее/темнее, теплее/холоднее
      const jit = 1 + (r5 - 0.5) * 0.11, warm = (r6 - 0.5) * 0.035;
      out.cx = x * ppm - 0.5; out.cy = y * ppm - 0.5; out.dx = dx; out.dy = dy;
      out.hl = len * 0.5 * ppm; out.hw = wid * 0.5 * ppm;
      const cr = samp(K.R, wi, hi, xi, yi), cg = samp(K.G, wi, hi, xi, yi), cb = samp(K.B, wi, hi, xi, yi);
      out.r = clamp(cr * jit + warm + (r7 - 0.5) * 0.02, 0, 1);
      out.g = clamp(cg * jit + (r8 - 0.5) * 0.02, 0, 1);
      out.b = clamp(cb * jit - warm, 0, 1);
      out.z = L + r9 * 0.999;
      // пастозно в светах, жидко в тенях — как пишут маслом
      // детали пишут жиже и тоньше — иначе лицо «в бугорках»
      out.load = (0.7 + 0.35 * r1) * (0.5 + 0.75 * (0.299 * cr + 0.587 * cg + 0.114 * cb)) * (L ? 0.5 : 1 - 0.3 * det);
      out.ph = (r3 * 1024) | 0;
      out.tail = 0.1 + 0.35 * r2; // где начинается скругление хвоста
      out.dry = 0.35 + 0.6 * r4; // насколько «сухо» кончается мазок
      out.gF = wid / grooveMm; // число бороздок поперёк
      out.es = Math.min(0.6, softMm / (wid * 0.5));
      return true;
    }

    const rowW = W;
    let HB = null, CR = null, CG = null, CB = null, LR = null, LG = null, LB = null;
    const dabPool = [];

    await compose(job, src, out, W, H, o.amount, async function (d, y0, h) {
      const by0 = y0 - 1, rows = h + 2, np = rows * rowW;
      if (!HB || HB.length < np) {
        HB = new Float32Array(np); CR = new Float32Array(np); CG = new Float32Array(np); CB = new Float32Array(np);
        LR = new Float32Array(np); LG = new Float32Array(np); LB = new Float32Array(np);
      }
      HB.fill(0, 0, np);
      // локальный цвет (Кувахара, растянутая билинейно)
      const rowTmp = new Float32Array(W);
      for (let r = 0; r < rows; r++) {
        const y = clamp(by0 + r, 0, H - 1), o2 = r * W;
        upRow(K.R, wi, ym, y, xm, rowTmp); LR.set(rowTmp, o2);
        upRow(K.G, wi, ym, y, xm, rowTmp); LG.set(rowTmp, o2);
        upRow(K.B, wi, ym, y, xm, rowTmp); LB.set(rowTmp, o2);
      }
      CR.set(LR.subarray(0, np)); CG.set(LG.subarray(0, np)); CB.set(LB.subarray(0, np));
      // мазки, задевающие полосу (с запасом на длину мазка), по возрастанию z
      const ymm0 = by0 / ppm - marg, ymm1 = (by0 + rows) / ppm + marg, wmm = W / ppm;
      let cnt = 0;
      for (let L = 0; L < 2; L++) {
        const cell = L ? cell1 : cell0;
        const j0 = Math.floor(ymm0 / cell), j1 = Math.floor(ymm1 / cell);
        const i0 = Math.floor(-marg / cell), i1 = Math.floor((wmm + marg) / cell);
        for (let cj = j0; cj <= j1; cj++) {
          for (let ci = i0; ci <= i1; ci++) {
            let db = dabPool[cnt];
            if (!db) { db = {}; dabPool[cnt] = db; }
            if (makeDab(L, ci, cj, db)) cnt++;
          }
        }
      }
      const order = dabPool.slice(0, cnt).sort((a, b) => a.z - b.z);
      const yLo = by0, yHi = by0 + rows - 1;
      for (let q = 0; q < cnt; q++) {
        const db = order[q];
        const cx = db.cx, cy = db.cy, dx = db.dx, dy = db.dy, hlx = db.hl, hw = db.hw;
        const ext = Math.abs(dy) * hlx + Math.abs(dx) * hw;
        const ya = Math.max(yLo, Math.ceil(cy - ext)), yb = Math.min(yHi, Math.floor(cy + ext));
        if (ya > yb) continue;
        const ihl = 1 / hlx, ihw = 1 / hw, es = db.es, ies = 1 / es;
        const gF = db.gF * 0.5, ph = db.ph;
        const load = db.load, cr = db.r, cg = db.g, cb = db.b, dbZ = db.z;
        const tailU = db.tail, itail = 1 / (1 - db.tail), dryK = db.dry;
        const op = dbZ >= 1 ? 0.97 : 0.93;
        for (let py = ya; py <= yb; py++) {
          const ry = py - cy, Uy = ry * dy, Vy = ry * dx;
          let xa = -1e9, xb = 1e9;
          if (Math.abs(dx) > 1e-6) {
            const t1 = (-hlx - Uy) / dx, t2 = (hlx - Uy) / dx;
            xa = Math.max(xa, Math.min(t1, t2)); xb = Math.min(xb, Math.max(t1, t2));
          } else if (Math.abs(Uy) > hlx) continue;
          if (Math.abs(dy) > 1e-6) {
            const t1 = (Vy - hw) / dy, t2 = (Vy + hw) / dy;
            xa = Math.max(xa, Math.min(t1, t2)); xb = Math.min(xb, Math.max(t1, t2));
          } else if (Math.abs(Vy) > hw) continue;
          const pxa = Math.max(0, Math.ceil(cx + xa)), pxb = Math.min(W - 1, Math.floor(cx + xb));
          const ro = (py - by0) * W;
          for (let px = pxa; px <= pxb; px++) {
            const rx = px - cx;
            const un = (rx * dx + Uy) * ihl;
            let vn = (Vy - rx * dy) * ihw;
            // скруглённое начало мазка (полуэллипс) и более длинный скруглённый хвост
            let av;
            if (un < -0.55) {
              const t = (-0.55 - un) * 2.2222;
              av = 1 - Math.sqrt(t * t + vn * vn);
            } else if (un > tailU) {
              const t = (un - tailU) * itail;
              av = 1 - Math.sqrt(t * t + vn * vn);
            } else av = 1 - (vn < 0 ? -vn : vn);
            if (av <= 0) continue;
            let al = av >= es ? 1 : smooth01(av * ies);
            const along = (un + 1) * 0.5;
            // бороздки щетины вдоль мазка; к хвосту краска кончается — штрихи сухой кисти
            const gp = (vn + 1) * gF + ph, gi = gp | 0, gf = gp - gi, sg = gf * gf * (3 - 2 * gf);
            const g0 = BT[gi & 1023], gv = g0 + (BT[(gi + 1) & 1023] - g0) * sg;
            // штрихи сухой кисти только в цвете: рельеф от них — тонкие тёмные «царапины»
            const thr = along * along * dryK * 1.5 - 0.35;
            let ad = 1;
            if (thr > -0.34) {
              const st = (gv - thr) * 3;
              ad = (st <= 0 ? 0 : st >= 1 ? 1 : smooth01(st)) * lod + (1 - (thr + 0.35) * 0.4) * (1 - lod);
            }
            const groove = (gv - 0.5) * lod * (0.3 + 0.7 * along);
            const cross = av * (2 - av); // скруглённое «тело» пасты
            // у начала — валик краски, к хвосту паста истончается
            const hb = along - 0.12;
            const hd = (load * (0.9 + 0.18 * Math.exp(-hb * hb * 70)) * (1 - 0.7 * along * along) + groove * 0.3) * cross;
            const a = al * op, idx = ro + px;
            // новая паста частично сдвигает старую; у края мазка старая остаётся (без «канавок»)
            const ho = HB[idx];
            HB[idx] = ho + (ho * (1 - 0.55 * cross) + hd - ho) * a * (0.6 + 0.4 * ad);
            const ac = a * ad * (groove < 0 ? 1 + groove * 0.9 : 1);
            CR[idx] += (cr - CR[idx]) * ac; CG[idx] += (cg - CG[idx]) * ac; CB[idx] += (cb - CB[idx]) * ac;
          }
        }
        if ((q & 255) === 0) await job.tick((y0 + h * q / cnt) / H);
      }
      // освещение рельефа и запись
      for (let y = 0; y < h; y++) {
        const r = y + 1, ro = r * W, up = ro - W, dn = ro + W;
        for (let x = 0; x < W; x++) {
          const i = ro + x;
          const xl = x > 0 ? i - 1 : i, xr = x < W - 1 ? i + 1 : i;
          const gx = (HB[xr] - HB[xl]) * kH, gy = (HB[dn + x] - HB[up + x]) * kH;
          const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
          const nx = -gx * inv, ny = -gy * inv, nz = inv;
          const dif = (nx * lx + ny * ly + nz * lz) / lz;
          let sp = nx * hx + ny * hy + nz * hz;
          sp = sp > 0 ? Math.pow(sp, 28) - specFlat : 0;
          sp = sp > 0 ? sp * specK : 0;
          // цвет мазка уступает локальному там, где они сильно расходятся (контуры лица)
          const lr = LR[i], lg = LG[i], lb = LB[i];
          const er = CR[i] - lr, eg = CG[i] - lg, eb = CB[i] - lb;
          const we = Math.exp(-(er * er + eg * eg + eb * eb) / tau2);
          const sh = 1 + (dif - 1) * shadeK;
          const k4 = (y * W + x) * 4;
          d[k4] = ((lr + er * we) * sh + sp) * 255;
          d[k4 + 1] = ((lg + eg * we) * sh + sp) * 255;
          d[k4 + 2] = ((lb + eb * we) * sh + sp) * 255;
          d[k4 + 3] = 255;
        }
      }
    }, 2e6);
    HB = CR = CG = CB = LR = LG = LB = null;
  }

  /* Растянуть плоскость на другую сетку (билинейно). */
  function resizePlane(p, w, h, w2, h2) {
    const q = new Float32Array(w2 * h2), xm = axisMap(w2, w), ym = axisMap(h2, h), row = new Float32Array(w2);
    for (let y = 0; y < h2; y++) { upRow(p, w, ym, y, xm, row); q.set(row, y * w2); }
    return q;
  }

  /* Совместное билатеральное увеличение (joint bilateral upsampling): пятна цвета берём из
   * грубой стилизации K, а положение границ — по фото на более высоком разрешении G
   * (соседи, чей исходный цвет похож на цвет пикселя, весят больше). Иначе в печати края мыльные. */
  async function jbu(job, K, P0, wi, hi, G, wd, hd, sr) {
    const n = wd * hd, oR = new Float32Array(n), oG = new Float32Array(n), oB = new Float32Array(n);
    const EXP = new Float32Array(1025);
    for (let i = 0; i <= 1024; i++) EXP[i] = Math.exp(-i / 128);
    const ir = 128 / (2 * sr * sr), is = 128 / (2 * 0.75 * 0.75), sx = wi / wd, sy = hi / hd;
    for (let y = 0; y < hd; y++) {
      const fy = (y + 0.5) * sy - 0.5, jc = Math.round(fy);
      for (let x = 0; x < wd; x++) {
        const fx = (x + 0.5) * sx - 0.5, ic = Math.round(fx), p = y * wd + x;
        const gr = G.R[p], gg = G.G[p], gb = G.B[p];
        let sw = 0, ar = 0, ag = 0, ab = 0;
        for (let dj = -1; dj <= 1; dj++) {
          let j = jc + dj; j = j < 0 ? 0 : j >= hi ? hi - 1 : j;
          const ey = (j - fy) * (j - fy);
          for (let di = -1; di <= 1; di++) {
            let i = ic + di; i = i < 0 ? 0 : i >= wi ? wi - 1 : i;
            const q = j * wi + i;
            const dr = gr - P0.R[q], dg = gg - P0.G[q], db = gb - P0.B[q];
            const ts = ((i - fx) * (i - fx) + ey) * is, tr = (dr * dr + dg * dg + db * db) * ir;
            const ws = EXP[ts < 1024 ? ts | 0 : 1024];
            const w = ws * (EXP[tr < 1024 ? tr | 0 : 1024] + 1e-4);
            sw += w; ar += K.R[q] * w; ag += K.G[q] * w; ab += K.B[q] * w;
          }
        }
        oR[p] = ar / sw; oG[p] = ag / sw; oB[p] = ab / sw;
      }
      if ((y & 15) === 0) await job.tick(y / hd);
    }
    return { R: oR, G: oG, B: oB };
  }

  // ================= АКВАРЕЛЬ =================
  /* Прозрачные заливки: цвет переводится в «плотность пигмента» (оптическая плотность по
   * каналам), светлые места становятся чистой бумагой, у границ заливок пигмент скапливается
   * (тёмная кайма), края слегка «гуляют» (смещение по плавному шуму в мм), кое-где цвета
   * растекаются «по-сырому». Упрощение цвета — на грубом разрешении (кисть), заливки и края —
   * на «детальном» (~0.3 мм), на полном — зерно бумаги, в углублениях пигмента больше. */
  async function fxWatercolor(job, src, out, W, H, o) {
    const ppm = o.ppc / 10, sz = o.size, seed = o.seed;
    const { wi, hi, pim } = internalSize(W, H, ppm, sz, 5, CAP_HEAVY);
    const n = wi * hi, tmp = new Float32Array(n);
    job.stage(0, 0.05);
    const P0 = readPlanes(src, wi, hi);
    const T0 = tensor(P0.R, P0.G, P0.B, wi, hi);
    gauss(T0.E, wi, hi, 2, tmp); gauss(T0.F, wi, hi, 2, tmp); gauss(T0.G, wi, hi, 2, tmp);
    job.mark('prep');
    job.stage(0.05, 0.4);
    const K = await kuwahara(job, P0, wi, hi, tangentField(T0, n), clamp(0.5 * sz * pim, 2, 5), 8);
    job.mark('kuwahara ' + wi + 'x' + hi);
    // детальная сетка ~0.3 мм: границы заливок по фото, а не размытые из грубой сетки
    const dd = internalSize(W, H, ppm, 1, 3.3, CAP_LIGHT);
    const wd = Math.max(dd.wi, wi), hd = Math.max(dd.hi, hi), pid = wd / W * ppm, nd = wd * hd;
    job.stage(0.4, 0.6);
    let Kd;
    if (wd === wi && hd === hi) Kd = K;
    else {
      const Gd = readPlanes(src, wd, hd);
      Kd = await jbu(job, K, P0, wi, hi, Gd, wd, hd, 0.08);
    }
    job.mark('jbu ' + wd + 'x' + hd);
    job.stage(0.6, 0.7);
    // плавные поля шума считаем на грубой сетке и растягиваем — они низкочастотные
    const up = p => (wd === wi && hd === hi ? p : resizePlane(p, wi, hi, wd, hd));
    const NX = up(noisePlane(wi, hi, pim, sz * 3, 2, 21, seed)), NY = up(noisePlane(wi, hi, pim, sz * 3, 2, 22, seed));
    // неровные края: сдвиг выборки по плавному шуму (амплитуда ~0.3 размера кисти)
    const amp = 0.3 * sz * pid;
    const C = { R: new Float32Array(nd), G: new Float32Array(nd), B: new Float32Array(nd) };
    for (let y = 0; y < hd; y++) {
      for (let x = 0; x < wd; x++) {
        const i = y * wd + x, sx = x + NX[i] * amp, sy = y + NY[i] * amp;
        C.R[i] = samp(Kd.R, wd, hd, sx, sy); C.G[i] = samp(Kd.G, wd, hd, sx, sy); C.B[i] = samp(Kd.B, wd, hd, sx, sy);
      }
      if ((y & 15) === 0) await job.tick(y / hd * 0.4);
    }
    Kd = null;
    // «по-сырому»: местами цвета мягко перетекают друг в друга
    const tmpd = new Float32Array(nd), sb = Math.max(1, 0.6 * sz * pid);
    const M = up(noisePlane(wi, hi, pim, sz * 7, 2, 23, seed));
    for (const ch of ['R', 'G', 'B']) {
      const Bl = blurCopy(C[ch], wd, hd, sb, tmpd), c = C[ch];
      for (let i = 0; i < nd; i++) c[i] += (Bl[i] - c[i]) * sstep(0.25, 0.75, M[i]) * 0.7;
      await job.tick(0.5);
    }
    saturate(C, 1.12, 0);
    // тёмная кайма по границам заливок
    const L = lumaPlane(C.R, C.G, C.B);
    const ED = sobelMag(L, wd, hd);
    for (let i = 0; i < nd; i++) ED[i] = sstep(0.06, 0.45, ED[i] * pid * sz);
    gauss(ED, wd, hd, Math.max(0.6, 0.1 * sz * pid), tmpd);
    const TU = up(noisePlane(wi, hi, pim, sz * 4, 3, 24, seed));
    for (let i = 0; i < nd; i++) {
      // света — чистая бумага, остальное чуть прозрачнее фото
      const wht = sstep(0.93, 0.68, L[i] + 0.08 * TU[i]);
      const k = 0.52 * (1 + 0.22 * TU[i]) * (1 + 0.4 * ED[i]) * wht;
      // акварель не даёт глухого чёрного: плотность ограничена (плоскости C → плотности)
      C.R[i] = Math.min(2.2, -Math.log(Math.max(0.02, C.R[i]))) * k;
      C.G[i] = Math.min(2.2, -Math.log(Math.max(0.02, C.G[i]))) * k;
      C.B[i] = Math.min(2.2, -Math.log(Math.max(0.02, C.B[i]))) * k;
    }
    const DR = C.R, DG = C.G, DB = C.B;
    job.mark('washes');
    job.stage(0.7, 1);
    const tile = grainTile(ppm, seed, [[2.0, 0.6], [1.0, 0.9], [0.5, 0.45], [0.25, 0.15]]);
    const TT = tile.T, TG = tile.t, rel = o.relief;
    const xm = axisMap(W, wd), ym = axisMap(H, hd);
    const rr = new Float32Array(W), rg = new Float32Array(W), rb = new Float32Array(W);
    const pR = 0.985, pG = 0.975, pB = 0.95; // тёплая белая бумага
    await compose(job, src, out, W, H, o.amount, async function (d, y0, h) {
      for (let y = 0; y < h; y++) {
        const yy = y0 + y, to = (yy % TT) * TT;
        upRow(DR, wd, ym, yy, xm, rr); upRow(DG, wd, ym, yy, xm, rg); upRow(DB, wd, ym, yy, xm, rb);
        for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
          const g = TG[to + x % TT];
          // в углублениях бумаги пигмента больше (грануляция), на выступах меньше
          const gm = 1 - rel * 0.4 * g;
          const sh = 1 + rel * 0.03 * g; // лёгкая светотень зерна
          d[k] = pR * Math.exp(-rr[x] * gm) * sh * 255;
          d[k + 1] = pG * Math.exp(-rg[x] * gm) * sh * 255;
          d[k + 2] = pB * Math.exp(-rb[x] * gm) * sh * 255;
          d[k + 3] = 255;
        }
      }
    });
  }

  // ================= КАРАНДАШ (простой и цветной) =================
  /* Штриховка: параллельные линии в мм-координатах, разбитые на отдельные штрихи с нажимом
   * в середине и разрывами; линия «дрожит». Тоньше пикселя — заменяется средним тоном. */
  function hatch(u, v, sp, w, aa, salt, BT) {
    const li = Math.round(v / sp);
    const r1 = BT[(li * 31 + salt) & 1023], r2 = BT[(li * 57 + salt + 311) & 1023];
    const off = sp * (0.14 * Math.sin(u / (sp * 9) + r1 * 6.283) + (r2 - 0.5) * 0.3);
    const dist = Math.abs(v - li * sp - off);
    const segL = sp * (9 + 9 * r2);
    const sq = u / segL + r1 * 7.31, si = Math.floor(sq), sf = sq - si;
    const r3 = BT[(li * 13 + si * 71 + salt + 577) & 1023];
    if (r3 < 0.1) return 0; // пропуск штриха
    const press = sstep(0, 0.18, sf) * sstep(1, 0.75, sf) * (0.6 + 0.4 * r3);
    const hw = w * 0.5 * (0.55 + 0.45 * press);
    const cov = (hw - dist) / aa + 0.5;
    return (cov <= 0 ? 0 : cov >= 1 ? 1 : cov) * press;
  }

  async function fxPencil(job, src, out, W, H, o, colored) {
    const ppm = o.ppc / 10, lw = o.size, seed = o.seed;
    const { wi, hi, pim } = internalSize(W, H, ppm, lw, 2.5, CAP_LIGHT);
    const n = wi * hi, tmp = new Float32Array(n);
    job.stage(0, 0.3);
    const P0 = readPlanes(src, wi, hi);
    const L = lumaPlane(P0.R, P0.G, P0.B);
    gauss(L, wi, hi, 0.6, tmp);
    // растягиваем тон по процентилям, чтобы и тусклое фото дало полный диапазон штриховки
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[clamp((L[i] * 255) | 0, 0, 255)]++;
    let lo = 0, hi8 = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi8 = i; break; } }
    const l0 = lo / 255, l1 = Math.max(l0 + 0.2, hi8 / 255);
    for (let i = 0; i < n; i++) L[i] = clamp((L[i] - l0) / (l1 - l0), 0, 1);
    await job.tick(0.3);
    // контуры: «осветление основы» L / blur(L) — темнеет только у границ
    const B = blurCopy(L, wi, hi, Math.max(1, 1.8 * lw * pim), tmp);
    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = sstep(0.05, 0.5, 1 - L[i] / Math.max(B[i], 0.03));
    const T = gauss(L, wi, hi, Math.max(0.8, 1.2 * lw * pim), tmp);
    let CP = null;
    if (colored) {
      const s = Math.max(1, 1.5 * lw * pim);
      CP = { R: gauss(P0.R, wi, hi, s, tmp), G: gauss(P0.G, wi, hi, s, tmp), B: gauss(P0.B, wi, hi, s, tmp) };
      saturate(CP, 1.3, 0.05);
    }
    job.mark('prep ' + wi + 'x' + hi);
    job.stage(0.3, 1);
    const BT = randTable(1024, seed);
    const tile = grainTile(ppm, seed, [[1.0, 0.45], [0.5, 0.8], [0.26, 0.55]]);
    const TT = tile.T, TG = tile.t, rel = o.relief;
    const xm = axisMap(W, wi), ym = axisMap(H, hi);
    const rs = new Float32Array(W), rt = new Float32Array(W);
    const rr = colored ? new Float32Array(W) : null, rg = colored ? new Float32Array(W) : null, rb = colored ? new Float32Array(W) : null;
    const aa = Math.max(1 / ppm, 0.3 * lw); // край штриха мягкий, как у грифеля
    const sp = (colored ? 1.5 : 2.4) * lw, wl = lw * (colored ? 1.05 : 0.9);
    const lod = sstep(2, 4, sp * ppm), mean = wl / sp * 0.62; // средняя доля штриха
    const A1 = 0.95, A2 = -0.62, A3 = 0.18; // углы штриховки, рад
    const c1 = Math.cos(A1), s1 = Math.sin(A1), c2 = Math.cos(A2), s2 = Math.sin(A2), c3 = Math.cos(A3), s3 = Math.sin(A3);
    const pR = 0.975, pG = 0.965, pB = 0.94; // бумага
    await compose(job, src, out, W, H, o.amount, async function (d, y0, h) {
      for (let y = 0; y < h; y++) {
        const yy = y0 + y, to = (yy % TT) * TT, ymm = (yy + 0.5) / ppm;
        upRow(S, wi, ym, yy, xm, rs); upRow(T, wi, ym, yy, xm, rt);
        if (colored) { upRow(CP.R, wi, ym, yy, xm, rr); upRow(CP.G, wi, ym, yy, xm, rg); upRow(CP.B, wi, ym, yy, xm, rb); }
        for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
          const xmm = (x + 0.5) / ppm, t = rt[x], e = rs[x];
          const g = TG[to + x % TT];
          // грифель ложится на выступы бумаги, в ямках остаётся белое
          const gm = clamp(1 + rel * 0.95 * g, 0, 1.6);
          const a1 = sstep(0.85, 0.35, t), a2 = sstep(0.55, 0.12, t), a3 = sstep(0.28, 0.0, t);
          let h1 = 0, h2 = 0, h3 = 0;
          if (a1 > 0 || colored) h1 = lod > 0 ? hatch(xmm * c1 + ymm * s1, ymm * c1 - xmm * s1, sp, wl, aa, 11, BT) * lod + mean * (1 - lod) : mean;
          if (a2 > 0) h2 = lod > 0 ? hatch(xmm * c2 + ymm * s2, ymm * c2 - xmm * s2, sp, wl, aa, 222, BT) * lod + mean * (1 - lod) : mean;
          if (a3 > 0) h3 = lod > 0 ? hatch(xmm * c3 + ymm * s3, ymm * c3 - xmm * s3, sp * 0.8, wl, aa, 333, BT) * lod + mean * (1 - lod) : mean;
          if (!colored) {
            let v = (1 - 0.5 * h1 * a1) * (1 - 0.45 * h2 * a2) * (1 - 0.4 * h3 * a3);
            v *= 1 - 0.22 * (1 - t); // растушёванный тон под штрихами
            v *= 1 - 0.8 * e; // контурные линии
            const dk = clamp((1 - v) * gm, 0, 0.86); // графит не бывает глухо-чёрным
            d[k] = pR * (1 - dk) * 255;
            d[k + 1] = pG * (1 - dk) * 255;
            d[k + 2] = (pB * (1 - dk) + dk * 0.04) * 255; // графит чуть холоднее бумаги
          } else {
            const r = rr[x], gg = rg[x], b = rb[x], lc = 0.299 * r + 0.587 * gg + 0.114 * b;
            // сколько пигмента: в светах бумага просвечивает сильнее
            let cov = (0.42 + 0.58 * (1 - lc)) * (0.5 + 0.5 * h1) + 0.4 * h2 * a2 + 0.3 * h3 * a3;
            cov = clamp(cov * clamp(1 + rel * 0.55 * g, 0.25, 1.4), 0, 1);
            let or = pR + (r - pR) * cov, og = pG + (gg - pG) * cov, ob = pB + (b - pB) * cov;
            const dk = (0.15 * h2 * a2 + 0.15 * h3 * a3) * gm; // нажим в тенях
            const le = e * 0.8 * clamp(gm, 0.3, 1.2);
            or = or * (1 - dk) * (1 - le) + r * 0.3 * le; og = og * (1 - dk) * (1 - le) + gg * 0.3 * le; ob = ob * (1 - dk) * (1 - le) + b * 0.3 * le;
            d[k] = or * 255; d[k + 1] = og * 255; d[k + 2] = ob * 255;
          }
          d[k + 3] = 255;
        }
        if ((y & 15) === 0) await job.tick((y0 + y) / H);
      }
    });
  }

  // ================= КОМИКС =================
  /* Плоские сглаженные заливки (несколько ступеней яркости, цвет сохраняется) и чёрный
   * контур (разность гауссиан). Ступени и контур режутся на полном разрешении из плавных
   * полей — края чёткие и в печати. */
  async function fxCartoon(job, src, out, W, H, o) {
    const ppm = o.ppc / 10, ow = o.size;
    // сглаживание заливок не зависит от толщины контура: ~0.4 мм на внутренний пиксель
    const { wi, hi, pim } = internalSize(W, H, ppm, 1.5, 3, CAP_HEAVY * 0.6);
    const n = wi * hi, tmp = new Float32Array(n);
    job.stage(0, 0.05);
    const P0 = readPlanes(src, wi, hi);
    const T0 = tensor(P0.R, P0.G, P0.B, wi, hi);
    gauss(T0.E, wi, hi, 2, tmp); gauss(T0.F, wi, hi, 2, tmp); gauss(T0.G, wi, hi, 2, tmp);
    job.mark('prep');
    job.stage(0.05, 0.6);
    const K = await kuwahara(job, P0, wi, hi, tangentField(T0, n), clamp(1.3 * pim, 2, 5), 8);
    job.mark('kuwahara ' + wi + 'x' + hi);
    gauss(K.R, wi, hi, 0.7, tmp); gauss(K.G, wi, hi, 0.7, tmp); gauss(K.B, wi, hi, 0.7, tmp);
    // контур: разность гауссиан по яркости уже сглаженной картинки (тонкие линии), затем
    // размытие на толщину контура в мм — на полном разрешении режем по порогу, и толщина
    // линии в печати та же, что на превью
    const L = lumaPlane(K.R, K.G, K.B);
    saturate(K, 1.35, 0.1);
    const g1 = blurCopy(L, wi, hi, 0.7, tmp), g2 = gauss(L, wi, hi, 1.15, tmp);
    const DG = new Float32Array(n);
    for (let i = 0; i < n; i++) DG[i] = sstep(0.006, 0.02, g2[i] - g1[i]); // >0 — тёмная сторона края
    const se = Math.max(0.5, 0.42 * ow * pim);
    gauss(DG, wi, hi, se, tmp);
    const peak = Math.min(1, 1 / (2.2 * se)); // отклик размытой линии шириной ~1 px
    for (let i = 0; i < n; i++) DG[i] /= peak;
    job.stage(0.6, 1);
    const xm = axisMap(W, wi), ym = axisMap(H, hi);
    const rr = new Float32Array(W), rg = new Float32Array(W), rb = new Float32Array(W), rd = new Float32Array(W);
    const N = 5, PHI = 16, TH = Math.tanh(PHI * 0.5);
    await compose(job, src, out, W, H, o.amount, async function (d, y0, h) {
      for (let y = 0; y < h; y++) {
        const yy = y0 + y;
        upRow(K.R, wi, ym, yy, xm, rr); upRow(K.G, wi, ym, yy, xm, rg); upRow(K.B, wi, ym, yy, xm, rb); upRow(DG, wi, ym, yy, xm, rd);
        for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
          const r = rr[x], g = rg[x], b = rb[x], l = 0.299 * r + 0.587 * g + 0.114 * b;
          // мягкое квантование яркости (Winnemöller): ступени с узкой гладкой границей
          const lv = clamp(l, 0, 1) * (N - 1), base = Math.round(lv), fr = lv - base;
          const lq = (base + 0.5 * Math.tanh(PHI * fr) / TH) / (N - 1);
          const kq = (lq * 0.92 + 0.06) / Math.max(l, 0.03);
          const ink = sstep(0.3, 0.55, rd[x]);
          const m = 1 - ink;
          d[k] = clamp(r * kq, 0, 1) * m * 255 + ink * 22;
          d[k + 1] = clamp(g * kq, 0, 1) * m * 255 + ink * 20;
          d[k + 2] = clamp(b * kq, 0, 1) * m * 255 + ink * 28;
          d[k + 3] = 255;
        }
        if ((y & 31) === 0) await job.tick((y0 + y) / H);
      }
    });
  }

  // ================= ПОСТЕР =================
  /* Несколько смелых плоских цветов: сглаживание Кувахарой, палитра k-средних (детерминированно),
   * каждому пикселю — ближайший цвет палитры; граница сглаживается на полном разрешении. */
  async function fxPoster(job, src, out, W, H, o) {
    const ppm = o.ppc / 10, ds = o.size;
    const { wi, hi, pim } = internalSize(W, H, ppm, ds, 3, CAP_HEAVY);
    const n = wi * hi, tmp = new Float32Array(n);
    job.stage(0, 0.05);
    const P0 = readPlanes(src, wi, hi);
    const T0 = tensor(P0.R, P0.G, P0.B, wi, hi);
    gauss(T0.E, wi, hi, 2, tmp); gauss(T0.F, wi, hi, 2, tmp); gauss(T0.G, wi, hi, 2, tmp);
    job.mark('prep');
    job.stage(0.05, 0.6);
    const K = await kuwahara(job, P0, wi, hi, tangentField(T0, n), clamp(0.6 * ds * pim, 2, 5), 8);
    job.mark('kuwahara ' + wi + 'x' + hi);
    const sg = Math.max(0.8, 0.25 * ds * pim);
    gauss(K.R, wi, hi, sg, tmp); gauss(K.G, wi, hi, sg, tmp); gauss(K.B, wi, hi, sg, tmp);
    saturate(K, 1.2, 0.08);
    // палитра: k-средних в Oklab (цветность с весом — чтобы разные оттенки не сливались в один)
    const OL = new Float32Array(n), OA = new Float32Array(n), OB = new Float32Array(n);
    for (let i = 0; i < n; i++) oklab(K.R[i], K.G[i], K.B[i], OL, OA, OB, i);
    const NC = 8, step = Math.max(1, Math.floor(n / 60000)), idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    idx.sort((a, b) => OL[a] - OL[b]);
    const CW = 4; // вес цветности
    const dist = (i, c) => {
      const dl = OL[i] - pc[c * 3], da = OA[i] - pc[c * 3 + 1], db = OB[i] - pc[c * 3 + 2];
      return dl * dl + CW * (da * da + db * db);
    };
    // начальные центры: самый тёмный, затем каждый раз самый далёкий от уже выбранных —
    // так в палитру попадают и редкие яркие цвета, а не только оттенки преобладающего
    const pc = new Float64Array(NC * 3), dmin = new Float64Array(idx.length).fill(1e9);
    let pick = idx[0];
    for (let c = 0; c < NC; c++) {
      pc[c * 3] = OL[pick]; pc[c * 3 + 1] = OA[pick]; pc[c * 3 + 2] = OB[pick];
      let far = -1, fq = 0;
      for (let q = 0; q < idx.length; q++) {
        const dd = dist(idx[q], c);
        if (dd < dmin[q]) dmin[q] = dd;
        if (dmin[q] > far) { far = dmin[q]; fq = q; }
      }
      pick = idx[fq];
    }
    const sum = new Float64Array(NC * 7);
    for (let it = 0; it < 12; it++) {
      sum.fill(0);
      for (let q = 0; q < idx.length; q++) {
        const i = idx[q];
        let best = 0, bd = 1e9;
        for (let c = 0; c < NC; c++) { const dd = dist(i, c); if (dd < bd) { bd = dd; best = c; } }
        const o7 = best * 7;
        sum[o7] += OL[i]; sum[o7 + 1] += OA[i]; sum[o7 + 2] += OB[i];
        sum[o7 + 3] += K.R[i]; sum[o7 + 4] += K.G[i]; sum[o7 + 5] += K.B[i]; sum[o7 + 6]++;
      }
      for (let c = 0; c < NC; c++) if (sum[c * 7 + 6] > 0) for (let j = 0; j < 3; j++) pc[c * 3 + j] = sum[c * 7 + j] / sum[c * 7 + 6];
      await job.tick(it / 12);
    }
    // цвет палитры — средний RGB кластера, смелее по насыщенности
    // и с растянутой яркостью: постер должен быть контрастным даже из тусклого фото
    const P = new Float32Array(NC * 3), PL = new Float32Array(NC);
    let lmin = 1, lmax = 0;
    for (let c = 0; c < NC; c++) {
      const m = Math.max(1, sum[c * 7 + 6]);
      P[c * 3] = sum[c * 7 + 3] / m; P[c * 3 + 1] = sum[c * 7 + 4] / m; P[c * 3 + 2] = sum[c * 7 + 5] / m;
      PL[c] = 0.299 * P[c * 3] + 0.587 * P[c * 3 + 1] + 0.114 * P[c * 3 + 2];
      if (sum[c * 7 + 6] > 0) { lmin = Math.min(lmin, PL[c]); lmax = Math.max(lmax, PL[c]); }
    }
    for (let c = 0; c < NC; c++) {
      const l = PL[c], ln = lmax > lmin ? 0.07 + (l - lmin) / (lmax - lmin) * 0.88 : l;
      const lt = l + (ln - l) * 0.6;
      for (let j = 0; j < 3; j++) P[c * 3 + j] = clamp(lt + (P[c * 3 + j] - l) * 1.45, 0, 1);
    }
    job.stage(0.6, 1);
    const xm = axisMap(W, wi), ym = axisMap(H, hi);
    const rl = new Float32Array(W), ra = new Float32Array(W), rb = new Float32Array(W);
    const PC = Float32Array.from(pc);
    await compose(job, src, out, W, H, o.amount, async function (d, y0, h) {
      for (let y = 0; y < h; y++) {
        const yy = y0 + y;
        upRow(OL, wi, ym, yy, xm, rl); upRow(OA, wi, ym, yy, xm, ra); upRow(OB, wi, ym, yy, xm, rb);
        for (let x = 0, k = y * W * 4; x < W; x++, k += 4) {
          const l = rl[x], a = ra[x], b = rb[x];
          let c1 = 0, d1 = 1e9, c2 = 0, d2 = 1e9;
          for (let c = 0; c < NC; c++) {
            const dl = l - PC[c * 3], da = a - PC[c * 3 + 1], db = b - PC[c * 3 + 2];
            const dd = dl * dl + CW * (da * da + db * db);
            if (dd < d1) { d2 = d1; c2 = c1; d1 = dd; c1 = c; } else if (dd < d2) { d2 = dd; c2 = c; }
          }
          // узкая сглаженная граница между двумя ближайшими цветами
          const t = 0.5 + 0.5 * sstep(0, 0.003, Math.sqrt(d2) - Math.sqrt(d1));
          d[k] = (P[c1 * 3] * t + P[c2 * 3] * (1 - t)) * 255;
          d[k + 1] = (P[c1 * 3 + 1] * t + P[c2 * 3 + 1] * (1 - t)) * 255;
          d[k + 2] = (P[c1 * 3 + 2] * t + P[c2 * 3 + 2] * (1 - t)) * 255;
          d[k + 3] = 255;
        }
        if ((y & 31) === 0) await job.tick((y0 + y) / H);
      }
    });
  }

  const FX = {
    oil: fxOil,
    watercolor: fxWatercolor,
    pencil: (job, src, out, W, H, o) => fxPencil(job, src, out, W, H, o, false),
    colorpencil: (job, src, out, W, H, o) => fxPencil(job, src, out, W, H, o, true),
    cartoon: fxCartoon,
    poster: fxPoster
  };

  async function apply(src, opts) {
    opts = opts || {};
    const W = src.width, H = src.height;
    const out = A.makeCanvas(W, H);
    const def = EFFECTS.find(e => e.id === opts.effect);
    if (!def || def.id === 'none' || !FX[def.id]) {
      out.getContext('2d').drawImage(src, 0, 0);
      if (opts.onProgress) opts.onProgress(1);
      return out;
    }
    const job = makeJob(opts);
    job.check();
    const sz = def.size || { def: 1, min: 0.1, max: 100 };
    const o = {
      ppc: opts.ppc > 0 ? opts.ppc : 20,
      size: clamp(opts.size > 0 ? +opts.size : sz.def, sz.min, sz.max),
      relief: clamp(opts.relief != null ? +opts.relief : (def.reliefDef != null ? def.reliefDef : 50), 0, 100) / 100,
      amount: clamp(opts.amount != null ? +opts.amount : 100, 0, 100) / 100,
      seed: mix32((opts.seed | 0) + 0x5bd1e995)
    };
    try {
      await FX[def.id](job, src, out, W, H, o);
    } catch (e) {
      out.width = out.height = 0; // недоделанный холст не держим в памяти
      throw e;
    }
    job.mark('end');
    A.canvasFx.lastStats = { effect: def.id, w: W, h: H, stages: job.marks.join(', ') };
    if (opts.onProgress) { try { opts.onProgress(1); } catch (e) { /* ничего */ } }
    return out;
  }

  A.canvasFx = { EFFECTS: EFFECTS, apply: apply };
})(window.ALMAZ = window.ALMAZ || {});
