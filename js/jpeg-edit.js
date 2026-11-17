/* Правка готового JPEG без потери качества там, где ничего не меняется.
 * Файл раскладывается до коэффициентов DCT (как он хранится внутри), меняются только блоки 8×8
 * с изменёнными клетками, остальные записываются обратно точно такими же. Цвет не пересчитывается:
 * CMYK остаётся CMYK со своими значениями красок, RGB — RGB. Поддерживается обычный (baseline) JPEG. */
(function (A) {
  'use strict';

  const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

  // косинусы для преобразования 8×8 в обе стороны: COS[u*8+x] = c(u)/2 · cos((2x+1)uπ/16)
  const COS = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) COS[u * 8 + x] = (u ? 0.5 : Math.SQRT1_2 / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

  function fail(code) { const e = new Error(code); e.code = code; return e; }

  // ---------- таблицы Хаффмана для чтения ----------
  function huffDecTable(bits, vals) {
    const lookup = new Uint16Array(512), maxcode = new Int32Array(18).fill(-1), valptr = new Int32Array(17), mincode = new Int32Array(17);
    let code = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      valptr[len] = k;
      mincode[len] = code;
      for (let i = 0; i < bits[len - 1]; i++) {
        if (len <= 9) {
          const shift = 9 - len, base = code << shift;
          for (let j = 0; j < (1 << shift); j++) lookup[base + j] = (len << 8) | vals[k];
        }
        code++; k++;
      }
      maxcode[len] = bits[len - 1] ? code - 1 : -1;
      code <<= 1;
    }
    return { lookup: lookup, maxcode: maxcode, valptr: valptr, mincode: mincode, vals: vals };
  }

  /* Разбирает JPEG до коэффициентов. Возвращает описание кадра, таблицы и служебные блоки. */
  /* opt.maxPixels — отказать сразу, ещё до выделения памяти под огромный файл. */
  function decode(data, opt) {
    const maxPixels = (opt && opt.maxPixels) || Infinity;
    if (data[0] !== 0xff || data[1] !== 0xd8) throw fail('notjpeg');
    const segs = [], qt = [], dcT = [], acT = [];
    let frame = null, restart = 0, adobe = null, pos = 2;
    const u16 = function (p) { return (data[p] << 8) | data[p + 1]; };
    while (pos < data.length - 1) {
      if (data[pos] !== 0xff) { pos++; continue; }
      const m = data[pos + 1];
      if (m === 0xff) { pos++; continue; }
      pos += 2;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
      if (m === 0xd9) break;
      const len = u16(pos), seg = data.subarray(pos + 2, pos + len);
      if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) {
        segs.push(data.slice(pos - 2, pos + len)); // служебные блоки (профиль, разрешение, Adobe) переносим как есть
        if (m === 0xee && seg.length >= 12 && seg[0] === 0x41 && seg[1] === 0x64 && seg[2] === 0x6f && seg[3] === 0x62 && seg[4] === 0x65) adobe = { transform: seg[11] };
      } else if (m === 0xdb) {
        for (let p = 0; p < seg.length;) {
          const pq = seg[p] >> 4, tq = seg[p] & 15, t = new Uint16Array(64);
          p++;
          for (let k = 0; k < 64; k++) { t[ZZ[k]] = pq ? u16(pos + 2 + p) : seg[p]; p += pq ? 2 : 1; }
          qt[tq] = t;
        }
      } else if (m === 0xc4) {
        for (let p = 0; p < seg.length;) {
          const tc = seg[p] >> 4, th = seg[p] & 15, bits = seg.subarray(p + 1, p + 17);
          let total = 0;
          for (let i = 0; i < 16; i++) total += bits[i];
          const t = huffDecTable(bits, seg.slice(p + 17, p + 17 + total));
          if (tc) acT[th] = t; else dcT[th] = t;
          p += 17 + total;
        }
      } else if (m === 0xc0 || m === 0xc1) {
        if (seg[0] !== 8) throw fail('bits');
        const height = u16(pos + 3), width = u16(pos + 5), n = seg[5], comps = [];
        if (!width || !height) throw fail('size');
        if (width * height > maxPixels) throw fail('big');
        let hmax = 1, vmax = 1;
        for (let i = 0; i < n; i++) {
          const c = { id: seg[6 + i * 3], h: seg[7 + i * 3] >> 4, v: seg[7 + i * 3] & 15, tq: seg[8 + i * 3] };
          hmax = Math.max(hmax, c.h); vmax = Math.max(vmax, c.v);
          comps.push(c);
        }
        const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
        comps.forEach(function (c) {
          c.w = Math.ceil((width * c.h) / hmax); c.hgt = Math.ceil((height * c.v) / vmax); // размер в своих точках
          c.bpl = mcusX * c.h; c.bpc = mcusY * c.v;                                     // блоков с запасом под MCU
          c.coefs = new Int16Array(c.bpl * c.bpc * 64);
        });
        frame = { width: width, height: height, comps: comps, hmax: hmax, vmax: vmax, mcusX: mcusX, mcusY: mcusY };
      } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        throw fail(m === 0xc2 ? 'progressive' : 'unsupported');
      } else if (m === 0xdd) {
        restart = u16(pos + 2);
      } else if (m === 0xda) {
        if (!frame) throw fail('broken');
        const ns = seg[0], sc = [];
        for (let i = 0; i < ns; i++) {
          const c = frame.comps.find(function (x) { return x.id === seg[1 + i * 2]; });
          if (!c) throw fail('broken');
          c.dc = dcT[seg[2 + i * 2] >> 4]; c.ac = acT[seg[2 + i * 2] & 15];
          if (!c.dc || !c.ac) throw fail('broken');
          sc.push(c);
        }
        pos = decodeScan(data, pos + len, frame, sc, restart);
        continue;
      }
      pos += len;
    }
    if (!frame) throw fail('broken');
    frame.comps.forEach(function (c) { if (!qt[c.tq]) throw fail('broken'); c.q = qt[c.tq]; });
    return { frame: frame, qt: qt, segs: segs, adobe: adobe };
  }

  function decodeScan(data, start, frame, sc, restart) {
    let p = start, buf = 0, cnt = 0, marker = false;
    function fill() {
      while (cnt <= 24) {
        let b = 0;
        if (!marker) {
          b = data[p];
          if (b === 0xff) {
            const nx = data[p + 1];
            if (nx === 0) p += 2; else { marker = true; b = 0; }
          } else p++;
          if (p > data.length) { marker = true; b = 0; }
        }
        buf = (buf << 8) | b;
        cnt += 8;
      }
    }
    function huff(t) {
      fill();
      const e = t.lookup[(buf >>> (cnt - 9)) & 511];
      if (e) { cnt -= e >> 8; return e & 255; }
      for (let len = 10; len <= 16; len++) {
        const code = (buf >>> (cnt - len)) & ((1 << len) - 1);
        if (code <= t.maxcode[len]) { cnt -= len; return t.vals[t.valptr[len] + code - t.mincode[len]]; }
      }
      throw fail('broken');
    }
    function extend(s) {
      fill();
      const v = (buf >>> (cnt - s)) & ((1 << s) - 1);
      cnt -= s;
      return v < (1 << (s - 1)) ? v - (1 << s) + 1 : v;
    }
    function block(c, off) {
      const co = c.coefs, s = huff(c.dc);
      c.pred += s ? extend(s) : 0;
      co[off] = c.pred;
      for (let k = 1; k < 64;) {
        const rs = huff(c.ac), r = rs >> 4, s2 = rs & 15;
        if (!s2) { if (r === 15) { k += 16; continue; } break; }
        k += r;
        if (k > 63) throw fail('broken');
        co[off + ZZ[k]] = extend(s2);
        k++;
      }
    }
    sc.forEach(function (c) { c.pred = 0; });
    let total, run;
    if (sc.length === 1) { // отдельный проход для одной составляющей: только блоки внутри картинки
      const c = sc[0], bw = Math.ceil(c.w / 8), bh = Math.ceil(c.hgt / 8);
      total = bw * bh;
      run = function (i) { block(c, ((Math.floor(i / bw)) * c.bpl + (i % bw)) * 64); };
    } else {
      total = frame.mcusX * frame.mcusY;
      run = function (i) {
        const my = Math.floor(i / frame.mcusX), mx = i % frame.mcusX;
        for (let k = 0; k < sc.length; k++) {
          const c = sc[k];
          for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, ((my * c.v + v) * c.bpl + mx * c.h + h) * 64);
        }
      };
    }
    for (let i = 0; i < total; i++) {
      if (restart && i && i % restart === 0) { // метка перезапуска: обнуляем предсказание и выравниваемся
        cnt = 0; buf = 0;
        while (p < data.length - 1 && !(data[p] === 0xff && data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7)) p++;
        p += 2; marker = false;
        sc.forEach(function (c) { c.pred = 0; });
      }
      run(i);
    }
    while (p < data.length - 1 && !(data[p] === 0xff && data[p + 1] !== 0 && !(data[p + 1] >= 0xd0 && data[p + 1] <= 0xd7))) p++;
    return p;
  }

  // ---------- точки ↔ коэффициенты ----------
  /* Блок коэффициентов → 64 точки (0…255). */
  const scratch = new Float64Array(64); // общий черновик: блоков миллионы, новый массив на каждый — лишняя работа
  function idctBlock(co, off, q, out) {
    const t = scratch;
    for (let x = 0; x < 8; x++) { // по столбцам: пропускаем пустые
      let any = false;
      for (let u = 1; u < 8; u++) if (co[off + u * 8 + x]) { any = true; break; }
      if (!any) {
        const d = co[off + x] * q[x] * COS[0];
        for (let y = 0; y < 8; y++) t[y * 8 + x] = d;
        continue;
      }
      for (let y = 0; y < 8; y++) {
        let s = 0;
        for (let u = 0; u < 8; u++) { const v = co[off + u * 8 + x]; if (v) s += v * q[u * 8 + x] * COS[u * 8 + y]; }
        t[y * 8 + x] = s;
      }
    }
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) s += t[y * 8 + u] * COS[u * 8 + x];
        const v = Math.round(s + 128);
        out[y * 8 + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  /* 64 точки → квантованные коэффициенты блока. */
  function fdctBlock(px, q, co, off) {
    const t = scratch;
    for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += (px[y * 8 + x] - 128) * COS[u * 8 + x];
      t[y * 8 + u] = s;
    }
    for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += t[y * 8 + u] * COS[v * 8 + y];
      co[off + v * 8 + u] = Math.round(s / q[v * 8 + u]);
    }
  }

  /* Все составляющие в точки: плоскости в собственном разрешении каждой. Можно по кусочкам с паузами. */
  /* dropCoefs — коэффициенты составляющей больше не нужны (при сохранении файл читается заново):
   * освобождаем сразу, так на большом макете памяти нужно заметно меньше. */
  async function toPlanes(dec, onStep, dropCoefs) {
    const out = new Uint8Array(64);
    for (const c of dec.frame.comps) {
      const W = c.bpl * 8, plane = new Uint8Array(W * c.bpc * 8);
      for (let by = 0; by < c.bpc; by++) {
        for (let bx = 0; bx < c.bpl; bx++) {
          idctBlock(c.coefs, (by * c.bpl + bx) * 64, c.q, out);
          for (let y = 0; y < 8; y++) plane.set(out.subarray(y * 8, y * 8 + 8), (by * 8 + y) * W + bx * 8);
        }
        if (onStep && by % 16 === 15) await onStep();
      }
      c.plane = plane; c.pw = W;
      if (dropCoefs) c.coefs = null;
    }
  }

  /* Пересчитать в коэффициенты только перечисленные блоки (после правки точек в плоскости). */
  function repack(c, blocks) {
    const px = new Uint8Array(64), W = c.pw;
    blocks.forEach(function (bi) {
      const bx = bi % c.bpl, by = Math.floor(bi / c.bpl);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = c.plane[(by * 8 + y) * W + bx * 8 + x];
      fdctBlock(px, c.q, c.coefs, bi * 64);
    });
  }

  // ---------- запись ----------
  /* Оптимальные длины кодов Хаффмана по частотам (приложение K стандарта JPEG). */
  function optimalTable(freq) {
    const f = Array.from(freq);
    f[256] = 1; // зарезервированный код, чтобы ни один код не состоял из одних единиц
    const codesize = new Array(257).fill(0), others = new Array(257).fill(-1);
    for (;;) {
      let c1 = -1, v = Infinity;
      for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
      let c2 = -1; v = Infinity;
      for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
      if (c2 < 0) break;
      f[c1] += f[c2]; f[c2] = 0;
      codesize[c1]++;
      while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
      others[c1] = c2;
      codesize[c2]++;
      while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
    }
    const bits = new Array(33).fill(0);
    for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
    for (let i = 32; i > 16; i--) {
      while (bits[i] > 0) {
        let j = i - 2;
        while (bits[j] === 0) j--;
        bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
      }
    }
    let i = 16;
    while (bits[i] === 0) i--;
    bits[i]--; // убираем зарезервированный код
    const vals = [];
    for (let len = 1; len <= 32; len++) for (let s = 0; s <= 255; s++) if (codesize[s] === len) vals.push(s);
    return { bits: bits.slice(1, 17), vals: vals };
  }

  function encTable(t) {
    const code = new Uint16Array(256), size = new Uint8Array(256);
    let c = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      for (let i = 0; i < t.bits[len - 1]; i++) { code[t.vals[k]] = c; size[t.vals[k]] = len; c++; k++; }
      c <<= 1;
    }
    return { code: code, size: size };
  }

  function catOf(v) { let a = v < 0 ? -v : v, s = 0; while (a) { s++; a >>= 1; } return s; }

  /* Обходит все блоки в порядке записи и вызывает fn(компонента, смещение блока). */
  function eachBlock(frame, fn) {
    const comps = frame.comps;
    for (let my = 0; my < frame.mcusY; my++) for (let mx = 0; mx < frame.mcusX; mx++) {
      for (let k = 0; k < comps.length; k++) {
        const c = comps[k];
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) fn(c, ((my * c.v + v) * c.bpl + mx * c.h + h) * 64);
      }
    }
  }

  /* Собирает файл обратно: служебные блоки и таблицы квантования — исходные, коэффициенты — текущие. */
  function encode(dec) {
    const frame = dec.frame, comps = frame.comps;
    // не больше двух наборов таблиц Хаффмана (так требует обычный JPEG): по таблицам квантования
    const groups = [];
    comps.forEach(function (c) { if (groups.indexOf(c.tq) < 0) groups.push(c.tq); });
    const multi = groups.length <= 2;
    comps.forEach(function (c) { c.tbl = multi ? groups.indexOf(c.tq) : 0; });
    const nt = multi ? groups.length : 1;
    const dcF = [], acF = [];
    for (let i = 0; i < nt; i++) { dcF.push(new Array(256).fill(0)); acF.push(new Array(256).fill(0)); }
    comps.forEach(function (c) { c.pred = 0; });
    eachBlock(frame, function (c, off) { // первый проход: считаем, какие коды нужны
      const co = c.coefs, d = co[off] - c.pred;
      c.pred = co[off];
      dcF[c.tbl][catOf(d)]++;
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = co[off + ZZ[k]];
        if (!v) { run++; continue; }
        while (run > 15) { acF[c.tbl][0xf0]++; run -= 16; }
        acF[c.tbl][(run << 4) | catOf(v)]++;
        run = 0;
      }
      if (run) acF[c.tbl][0]++;
    });
    const dcTabs = dcF.map(optimalTable), acTabs = acF.map(optimalTable);
    const dcE = dcTabs.map(encTable), acE = acTabs.map(encTable);

    const parts = [];
    let buf = new Uint8Array(1 << 20), pos = 0, acc = 0, nb = 0;
    function byte(b) { if (pos === buf.length) { parts.push(buf); buf = new Uint8Array(1 << 20); pos = 0; } buf[pos++] = b; }
    function bytes(arr) { for (let i = 0; i < arr.length; i++) byte(arr[i]); }
    function put(code, len) {
      acc = (acc << len) | (code & ((1 << len) - 1));
      nb += len;
      while (nb >= 8) {
        const b = (acc >>> (nb - 8)) & 255;
        byte(b);
        if (b === 255) byte(0);
        nb -= 8;
      }
      acc &= (1 << nb) - 1;
    }
    function seg(m, payload) { byte(0xff); byte(m); byte((payload.length + 2) >> 8); byte((payload.length + 2) & 255); bytes(payload); }

    byte(0xff); byte(0xd8);
    dec.segs.forEach(bytes);
    dec.qt.forEach(function (t, id) {
      if (!t) return;
      const p = [id];
      for (let k = 0; k < 64; k++) p.push(Math.min(255, t[ZZ[k]]));
      seg(0xdb, p);
    });
    const sof = [8, frame.height >> 8, frame.height & 255, frame.width >> 8, frame.width & 255, comps.length];
    comps.forEach(function (c) { sof.push(c.id, (c.h << 4) | c.v, c.tq); });
    seg(0xc0, sof);
    for (let i = 0; i < nt; i++) {
      seg(0xc4, [0x00 | i].concat(dcTabs[i].bits, dcTabs[i].vals));
      seg(0xc4, [0x10 | i].concat(acTabs[i].bits, acTabs[i].vals));
    }
    const sos = [comps.length];
    comps.forEach(function (c) { sos.push(c.id, (c.tbl << 4) | c.tbl); });
    sos.push(0, 63, 0);
    seg(0xda, sos);
    comps.forEach(function (c) { c.pred = 0; });
    eachBlock(frame, function (c, off) {
      const co = c.coefs, d = co[off] - c.pred, de = dcE[c.tbl], ae = acE[c.tbl];
      c.pred = co[off];
      const s = catOf(d);
      put(de.code[s], de.size[s]);
      if (s) put(d < 0 ? d - 1 : d, s);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = co[off + ZZ[k]];
        if (!v) { run++; continue; }
        while (run > 15) { put(ae.code[0xf0], ae.size[0xf0]); run -= 16; }
        const sz = catOf(v), sym = (run << 4) | sz;
        put(ae.code[sym], ae.size[sym]);
        put(v < 0 ? v - 1 : v, sz);
        run = 0;
      }
      if (run) put(ae.code[0], ae.size[0]);
    });
    if (nb) put((1 << (8 - nb)) - 1, 8 - nb);
    byte(0xff); byte(0xd9);
    parts.push(buf.subarray(0, pos));
    return parts;
  }

  A.jpegEdit = { decode: decode, toPlanes: toPlanes, repack: repack, encode: encode, idctBlock: idctBlock, fdctBlock: fdctBlock };
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
