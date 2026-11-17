/* Готовый макет в PNG: чтение в плоскости R, G, B (тот же вид, что у JPEG-макета, чтобы работал
 * общий разбор сетки и легенды) и запись обратно в PNG. PNG сжимается без потерь, поэтому всё,
 * кроме перерисованных клеток, остаётся точка в точку. Цвета не пересчитываются: файл читается
 * без цветового профиля, а профиль, dpi и гамма переносятся из исходного файла как есть. */
(function (A) {
  'use strict';

  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const KEEP = ['pHYs', 'iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP']; // dpi и цвет — из исходного файла
  const BAND = 512;

  function fail(code) { const e = new Error(code); e.code = code; return e; }
  function isPng(b) { return !!b && b.length > 33 && SIG.every(function (v, i) { return b[i] === v; }); }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function typeAt(b, o) { return String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]); }

  /* Куски файла до картинки: [{type, start, end}] (end — после CRC). */
  function chunks(b) {
    const out = [];
    let o = 8;
    while (o + 12 <= b.length) {
      const len = u32(b, o), type = typeAt(b, o), end = o + 12 + len;
      if (end > b.length) break;
      out.push({ type: type, start: o, end: end });
      if (type === 'IEND') break;
      o = end;
    }
    return out;
  }

  /* bytes → { frame: { width, height, comps: [R, G, B] }, adobe: { transform: 0 }, png: true, alpha } */
  async function decode(bytes, opt) {
    if (!isPng(bytes)) throw fail('notpng');
    if (typeAt(bytes, 8) !== 'IHDR') throw fail('broken');
    const width = u32(bytes, 16), height = u32(bytes, 20);
    if (!width || !height) throw fail('broken');
    if (opt && opt.maxPixels && width * height > opt.maxPixels) throw fail('big');
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (e) { throw fail('broken'); }
    try {
      const dec = await fromBitmap(bmp, opt);
      dec.bits = bytes[24];
      return dec;
    } finally { bmp.close(); }
  }

  /* Любая картинка, уже открытая браузером, → плоскости R, G, B (картинку не закрывает). */
  async function fromBitmap(bmp, opt) {
    const W = bmp.width, H = bmp.height;
    const cv = A.makeCanvas(W, Math.min(BAND, H)), x = cv.getContext('2d', { willReadFrequently: true });
    if (!x) throw fail('big');
    const comps = [0, 1, 2].map(function (i) {
      return { id: i + 1, h: 1, v: 1, w: W, hgt: H, pw: W, plane: new Uint8Array(W * H) };
    });
    const r = comps[0].plane, g = comps[1].plane, bl = comps[2].plane;
    let alpha = null;
    for (let y0 = 0; y0 < H; y0 += BAND) {
      const bh = Math.min(BAND, H - y0);
      x.clearRect(0, 0, W, cv.height);
      x.drawImage(bmp, 0, -y0);
      const d = x.getImageData(0, 0, W, bh).data, base = y0 * W;
      for (let i = 0, p = base; i < d.length; i += 4, p++) {
        r[p] = d[i]; g[p] = d[i + 1]; bl[p] = d[i + 2];
        if (d[i + 3] !== 255) { if (!alpha) alpha = new Uint8Array(W * H).fill(255); alpha[p] = d[i + 3]; }
      }
      if (opt && opt.onStep) await opt.onStep();
    }
    cv.width = cv.height = 0;
    return {
      frame: { width: W, height: H, comps: comps, hmax: 1, vmax: 1 },
      adobe: { transform: 0 }, // для общего кода: составляющие уже RGB, пересчитывать не нужно
      png: true, alpha: alpha
    };
  }

  /* Плоскости → PNG; служебные куски с dpi и цветом берутся из исходного файла. Возвращает части файла. */
  async function encode(dec, orig, onStep) {
    const f = dec.frame, W = f.width, H = f.height, c = f.comps, alpha = dec.alpha;
    const cv = A.makeCanvas(W, H), x = cv.getContext('2d');
    if (!x) throw fail('big');
    for (let y0 = 0; y0 < H; y0 += BAND) {
      const bh = Math.min(BAND, H - y0), im = x.createImageData(W, bh), d = im.data, base = y0 * W;
      for (let i = 0, p = base; i < d.length; i += 4, p++) {
        d[i] = c[0].plane[p]; d[i + 1] = c[1].plane[p]; d[i + 2] = c[2].plane[p]; d[i + 3] = alpha ? alpha[p] : 255;
      }
      x.putImageData(im, 0, y0);
      if (onStep) await onStep();
    }
    const blob = await new Promise(function (resolve) { cv.toBlob(resolve, 'image/png'); });
    cv.width = cv.height = 0;
    if (!blob) throw fail('big');
    const out = new Uint8Array(await blob.arrayBuffer());
    const fresh = chunks(out), old = chunks(orig);
    if (!fresh.length || fresh[0].type !== 'IHDR') return [out];
    const keep = old.filter(function (k) { return KEEP.indexOf(k.type) >= 0; });
    const parts = [out.subarray(0, fresh[0].end)];
    keep.forEach(function (k) { parts.push(orig.subarray(k.start, k.end)); });
    fresh.slice(1).forEach(function (k) { if (KEEP.indexOf(k.type) < 0) parts.push(out.subarray(k.start, k.end)); });
    return parts;
  }

  /* dpi из куска pHYs (0 — не указан). */
  function dpiOf(bytes) {
    const k = chunks(bytes).filter(function (c) { return c.type === 'pHYs'; })[0];
    if (!k || bytes[k.start + 16] !== 1) return 0;
    return Math.round(u32(bytes, k.start + 8) * 0.0254);
  }

  A.pngEdit = { isPng: isPng, decode: decode, fromBitmap: fromBitmap, encode: encode, chunks: chunks, dpiOf: dpiOf };
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
