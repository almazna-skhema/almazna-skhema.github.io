/* Работа с файлами без сторонних библиотек: CRC32, DPI в PNG, ZIP-архив. */
(function (A) {
  'use strict';

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    const s = start || 0;
    const e = end === undefined ? bytes.length : end;
    for (let i = s; i < e; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* Записывает в PNG физическое разрешение (блок pHYs), чтобы файл
   * открывался в типографии сразу в нужном размере в сантиметрах. */
  function pngSetDpi(png, pxPerMm) {
    const IHDR_END = 33; // подпись (8) + блок IHDR (25)
    if (png.length < IHDR_END || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return png;
    const ppm = Math.round(pxPerMm * 1000);
    const chunk = new Uint8Array(21);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1; // единица — метр
    dv.setUint32(17, crc32(chunk, 4, 17));
    // если блок pHYs уже есть — перезаписываем его на месте
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    for (let pos = 8; pos + 12 <= png.length;) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
      if (type === 'pHYs' && len === 9) {
        const copy = png.slice();
        copy.set(chunk, pos);
        return copy;
      }
      if (type === 'IDAT') break;
      pos += 12 + len;
    }
    const out = new Uint8Array(png.length + 21);
    out.set(png.subarray(0, IHDR_END), 0);
    out.set(chunk, IHDR_END);
    out.set(png.subarray(IHDR_END), IHDR_END + 21);
    return out;
  }

  /* ZIP без сжатия (PNG уже сжаты). files: [{name, data: Uint8Array}] */
  function zipStore(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    files.forEach(function (f) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new Uint8Array(30 + name.length);
      const l = new DataView(lh.buffer);
      l.setUint32(0, 0x04034b50, true);
      l.setUint16(4, 20, true);
      l.setUint16(6, 0x0800, true); // имена в UTF-8
      l.setUint16(8, 0, true); // без сжатия
      l.setUint16(10, dosTime, true);
      l.setUint16(12, dosDate, true);
      l.setUint32(14, crc, true);
      l.setUint32(18, size, true);
      l.setUint32(22, size, true);
      l.setUint16(26, name.length, true);
      l.setUint16(28, 0, true);
      lh.set(name, 30);

      const ch = new Uint8Array(46 + name.length);
      const c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, dosTime, true);
      c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, size, true);
      c.setUint32(24, size, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      ch.set(name, 46);

      parts.push(lh, f.data);
      central.push(ch);
      offset += lh.length + size;
    });

    let centralSize = 0;
    central.forEach(function (c) { centralSize += c.length; });
    const end = new Uint8Array(22);
    const e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, files.length, true);
    e.setUint16(10, files.length, true);
    e.setUint32(12, centralSize, true);
    e.setUint32(16, offset, true);

    return parts.concat(central, [end]); // массив кусков для new Blob(...)
  }

  /* PDF из одной картинки JPEG на всю страницу. Размер страницы — в миллиметрах,
   * так что типография получает лист точного размера. Возвращает части для Blob. */
  function pdfFromJpeg(jpeg, wPx, hPx, wMm, hMm) {
    const enc = new TextEncoder();
    const pt = function (mm) { return ((mm * 72) / 25.4).toFixed(2); };
    const W = pt(wMm), H = pt(hMm);
    const content = 'q ' + W + ' 0 0 ' + H + ' 0 0 cm /Im0 Do Q';
    const heads = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /XObject /Subtype /Image /Width ' + wPx + ' /Height ' + hPx +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>',
      '<< /Length ' + content.length + ' >>'
    ];
    const parts = [], offsets = [];
    let pos = 0;
    const put = function (chunk) {
      const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
      parts.push(bytes);
      pos += bytes.length;
    };
    put('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
    heads.forEach(function (h, i) {
      offsets.push(pos);
      put((i + 1) + ' 0 obj\n' + h + '\n');
      if (i === 3) { put('stream\n'); put(jpeg); put('\nendstream\n'); }
      if (i === 4) put('stream\n' + content + '\nendstream\n');
      put('endobj\n');
    });
    const xref = pos;
    let table = 'xref\n0 6\n0000000000 65535 f \n';
    offsets.forEach(function (o) { table += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
    put(table + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return parts;
  }

  /* Записывает разрешение (точек на дюйм) в заголовок JPEG, чтобы файл открывался
   * в нужном физическом размере. Меняет массив на месте; чужой формат не трогает. */
  function jpegSetDpi(jpg, dpi) {
    const ok = jpg.length > 18 && jpg[0] === 0xff && jpg[1] === 0xd8 && jpg[2] === 0xff && jpg[3] === 0xe0 &&
      jpg[6] === 0x4a && jpg[7] === 0x46 && jpg[8] === 0x49 && jpg[9] === 0x46 && jpg[10] === 0; // «JFIF»
    if (!ok) return jpg;
    const d = Math.max(1, Math.min(65535, Math.round(dpi)));
    jpg[13] = 1; // единица — точки на дюйм
    jpg[14] = d >> 8; jpg[15] = d & 255;
    jpg[16] = d >> 8; jpg[17] = d & 255;
    return jpg;
  }

  /* Этикетки на пакетики в формате Word — как их набирают вручную: лента этикеток 24 × 14 мм,
   * по одной на страницу. Первая — артикул и название, дальше на каждый цвет: значок в рамке,
   * номер цвета крупно и количество страз. Возвращает части ZIP-файла (.docx) для Blob.
   * data: { article, title, unit, rows: [{ symbol, code, count }] } */
  function labelsDocx(data) {
    const enc = new TextEncoder();
    const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
    const SYM = '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>';
    const run = function (text, half, bold, extra) {
      return '<w:r><w:rPr>' + (extra || FONT) + (bold ? '<w:b/>' : '') + '<w:sz w:val="' + half + '"/><w:szCs w:val="' + half + '"/></w:rPr>' +
        '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
    };
    const para = function (inner, newPage) {
      return '<w:p><w:pPr>' + (newPage ? '<w:pageBreakBefore/>' : '') +
        '<w:spacing w:before="0" w:after="0" w:line="40" w:lineRule="atLeast"/><w:jc w:val="center"/></w:pPr>' + inner + '</w:p>';
    };
    const fit = function (chars, max) { // размер шрифта в полупунктах, чтобы строка влезла в 20 мм
      return Math.max(14, Math.min(max, Math.floor(210 / Math.max(1, chars))));
    };
    let body = '';
    const head = String(data.article || '').trim(), title = String(data.title || '').trim();
    if (head || title) {
      if (head) body += para(run(head, fit(head.length, 32), true), false);
      if (title) body += para(run(title, fit(title.length * 1.05, 16), true), false);
    }
    data.rows.forEach(function (r, i) {
      const sym = String(r.symbol).replace(/︎/g, ''), code = String(r.code);
      const half = fit(code.length + 2.2, 40);
      const plain = /^[0-9A-Za-z+=#%&@?*<>$]$/.test(sym); // буквы и цифры — обычным шрифтом, фигуры — шрифтом символов
      const box = (plain ? FONT : SYM) + '<w:bdr w:val="single" w:sz="6" w:space="0" w:color="000000"/>';
      body += para(run(sym, half, true, box) + run(' ' + code, half, true), i > 0 || !!(head || title));
      body += para(run(r.count + (data.unit || ''), 18, false), false);
    });
    const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="1361" w:h="794"/><w:pgMar w:top="0" w:right="85" w:bottom="0" w:left="113" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';
    const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(types) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'word/document.xml', data: enc.encode(doc) }
    ]);
  }

  /* Кодировщик JPEG в CMYK. Браузер сам такие файлы не пишет, а типография ждёт именно их.
   * Обычный (baseline) JPEG с четырьмя каналами без прореживания; по соглашению Adobe значения
   * красок хранятся перевёрнутыми. Картинка подаётся полосами по 8 строк RGBA, цвет переводится
   * по таблице lut (сетка n³, 4 байта на узел, порядок: синий, красный, зелёный).
   * Использование: const e = jpegCmyk(w, h, lut, quality, dpi); e.band(rgba, rows) …; parts = e.finish(). */
  function jpegCmyk(width, height, lut, quality, dpi) {
    const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
      35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
    const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
      18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
    const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
    const AC_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
      0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
      0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
      0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
    function huff(bits, vals) { // таблица: символ → [код, длина]
      const codes = [], lens = [];
      let code = 0, k = 0;
      for (let len = 1; len <= 16; len++) {
        for (let i = 0; i < bits[len - 1]; i++) { codes[vals[k]] = code++; lens[vals[k]] = len; k++; }
        code <<= 1;
      }
      return { c: codes, l: lens };
    }
    const DC = huff(DC_BITS, DC_VALS), AC = huff(AC_BITS, AC_VALS);
    const q = Math.max(1, Math.min(100, quality | 0)), scale = q < 50 ? 5000 / q : 200 - q * 2;
    const QT = QL.map(function (v) { return Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))); });
    const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];
    const FQ = new Float64Array(64); // делители для быстрого DCT с учётом квантования
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) FQ[r * 8 + c] = 1 / (QT[r * 8 + c] * AAN[r] * AAN[c] * 8);

    // поток: байты пишем в куски по 1 МБ
    const parts = [];
    let buf = new Uint8Array(1 << 20), pos = 0, acc = 0, nbits = 0;
    function byte(b) { if (pos === buf.length) { parts.push(buf); buf = new Uint8Array(1 << 20); pos = 0; } buf[pos++] = b; }
    function put(code, len) {
      acc = (acc << len) | code;
      nbits += len;
      while (nbits >= 8) {
        const b = (acc >>> (nbits - 8)) & 255;
        byte(b);
        if (b === 255) byte(0);
        nbits -= 8;
      }
      acc &= (1 << nbits) - 1;
    }
    function word(v) { byte(v >> 8); byte(v & 255); }
    function marker(m, payload) { byte(0xff); byte(m); word(payload.length + 2); payload.forEach(byte); }

    const d = Math.max(1, Math.min(65535, Math.round(dpi || 300)));
    byte(0xff); byte(0xd8);
    marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
    marker(0xee, [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]); // «Adobe», без преобразования цвета: это CMYK
    marker(0xdb, [0].concat(ZZ.map(function (i) { return QT[i]; })));
    marker(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]);
    marker(0xc4, [0x00].concat(DC_BITS, DC_VALS));
    marker(0xc4, [0x10].concat(AC_BITS, AC_VALS));
    marker(0xda, [4, 1, 0, 2, 0, 3, 0, 4, 0, 0, 63, 0]);

    const n = lut.n, T = lut.data, n1 = n - 1, bw = Math.ceil(width / 8);
    const planes = [0, 1, 2, 3].map(function () { return new Uint8Array(bw * 8 * 8); });
    const block = new Float64Array(64), pred = [0, 0, 0, 0];

    function fdct(p) { // быстрое DCT (алгоритм AAN), на месте
      for (let i = 0; i < 64; i += 8) {
        const t0 = p[i] + p[i + 7], t7 = p[i] - p[i + 7], t1 = p[i + 1] + p[i + 6], t6 = p[i + 1] - p[i + 6];
        const t2 = p[i + 2] + p[i + 5], t5 = p[i + 2] - p[i + 5], t3 = p[i + 3] + p[i + 4], t4 = p[i + 3] - p[i + 4];
        let a = t0 + t3, b = t1 + t2, c = t1 - t2, e = t0 - t3;
        p[i] = a + b; p[i + 4] = a - b;
        let z = (c + e) * 0.707106781; p[i + 2] = e + z; p[i + 6] = e - z;
        a = t4 + t5; b = t5 + t6; c = t6 + t7;
        const z5 = (a - c) * 0.382683433, z2 = 0.5411961 * a + z5, z4 = 1.306562965 * c + z5, z3 = b * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        p[i + 5] = z13 + z2; p[i + 3] = z13 - z2; p[i + 1] = z11 + z4; p[i + 7] = z11 - z4;
      }
      for (let i = 0; i < 8; i++) {
        const t0 = p[i] + p[i + 56], t7 = p[i] - p[i + 56], t1 = p[i + 8] + p[i + 48], t6 = p[i + 8] - p[i + 48];
        const t2 = p[i + 16] + p[i + 40], t5 = p[i + 16] - p[i + 40], t3 = p[i + 24] + p[i + 32], t4 = p[i + 24] - p[i + 32];
        let a = t0 + t3, b = t1 + t2, c = t1 - t2, e = t0 - t3;
        p[i] = a + b; p[i + 32] = a - b;
        let z = (c + e) * 0.707106781; p[i + 16] = e + z; p[i + 48] = e - z;
        a = t4 + t5; b = t5 + t6; c = t6 + t7;
        const z5 = (a - c) * 0.382683433, z2 = 0.5411961 * a + z5, z4 = 1.306562965 * c + z5, z3 = b * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        p[i + 40] = z13 + z2; p[i + 24] = z13 - z2; p[i + 8] = z11 + z4; p[i + 56] = z11 - z4;
      }
    }
    const coef = new Int32Array(64);
    function emit(comp) {
      fdct(block);
      for (let i = 0; i < 64; i++) { const v = block[ZZ[i]] * FQ[ZZ[i]]; coef[i] = v < 0 ? -((-v + 0.5) | 0) : (v + 0.5) | 0; }
      let diff = coef[0] - pred[comp];
      pred[comp] = coef[0];
      let a = diff < 0 ? -diff : diff, size = 0;
      while (a) { size++; a >>= 1; }
      put(DC.c[size], DC.l[size]);
      if (size) put(diff < 0 ? diff + (1 << size) - 1 : diff, size);
      let run = 0;
      for (let i = 1; i < 64; i++) {
        const v = coef[i];
        if (!v) { run++; continue; }
        while (run > 15) { put(AC.c[0xf0], AC.l[0xf0]); run -= 16; }
        a = v < 0 ? -v : v; size = 0;
        while (a) { size++; a >>= 1; }
        const sym = (run << 4) | size;
        put(AC.c[sym], AC.l[sym]);
        put(v < 0 ? v + (1 << size) - 1 : v, size);
        run = 0;
      }
      if (run) put(AC.c[0], AC.l[0]);
    }

    /* Полоса из rows строк (8, кроме последней): rgba — её точки подряд. */
    function band(rgba, rows) {
      const W8 = bw * 8;
      let pr = -1, pg = -1, pb = -1, c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let y = 0; y < 8; y++) {
        const sy = y < rows ? y : rows - 1; // недостающие строки повторяют последнюю
        for (let x = 0; x < W8; x++) {
          const o = (sy * width + (x < width ? x : width - 1)) * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
          if (r !== pr || g !== pg || b !== pb) {
            pr = r; pg = g; pb = b;
            const fr = (r * n1) / 255, fg = (g * n1) / 255, fb = (b * n1) / 255;
            const r0 = fr | 0, g0 = fg | 0, b0 = fb | 0, r1 = r0 < n1 ? r0 + 1 : r0, g1 = g0 < n1 ? g0 + 1 : g0, b1 = b0 < n1 ? b0 + 1 : b0;
            const dr = fr - r0, dg = fg - g0, db = fb - b0;
            const i000 = ((b0 * n + r0) * n + g0) * 4, i001 = ((b0 * n + r0) * n + g1) * 4, i010 = ((b0 * n + r1) * n + g0) * 4, i011 = ((b0 * n + r1) * n + g1) * 4;
            const i100 = ((b1 * n + r0) * n + g0) * 4, i101 = ((b1 * n + r0) * n + g1) * 4, i110 = ((b1 * n + r1) * n + g0) * 4, i111 = ((b1 * n + r1) * n + g1) * 4;
            const w000 = (1 - db) * (1 - dr) * (1 - dg), w001 = (1 - db) * (1 - dr) * dg, w010 = (1 - db) * dr * (1 - dg), w011 = (1 - db) * dr * dg;
            const w100 = db * (1 - dr) * (1 - dg), w101 = db * (1 - dr) * dg, w110 = db * dr * (1 - dg), w111 = db * dr * dg;
            c0 = T[i000] * w000 + T[i001] * w001 + T[i010] * w010 + T[i011] * w011 + T[i100] * w100 + T[i101] * w101 + T[i110] * w110 + T[i111] * w111;
            c1 = T[i000 + 1] * w000 + T[i001 + 1] * w001 + T[i010 + 1] * w010 + T[i011 + 1] * w011 + T[i100 + 1] * w100 + T[i101 + 1] * w101 + T[i110 + 1] * w110 + T[i111 + 1] * w111;
            c2 = T[i000 + 2] * w000 + T[i001 + 2] * w001 + T[i010 + 2] * w010 + T[i011 + 2] * w011 + T[i100 + 2] * w100 + T[i101 + 2] * w101 + T[i110 + 2] * w110 + T[i111 + 2] * w111;
            c3 = T[i000 + 3] * w000 + T[i001 + 3] * w001 + T[i010 + 3] * w010 + T[i011 + 3] * w011 + T[i100 + 3] * w100 + T[i101 + 3] * w101 + T[i110 + 3] * w110 + T[i111 + 3] * w111;
          }
          const k = y * W8 + x;
          planes[0][k] = 255 - c0; planes[1][k] = 255 - c1; planes[2][k] = 255 - c2; planes[3][k] = 255 - c3; // перевёрнуто, как пишет Adobe
        }
      }
      for (let bx = 0; bx < bw; bx++) {
        for (let comp = 0; comp < 4; comp++) {
          const pl = planes[comp];
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = pl[y * W8 + bx * 8 + x] - 128;
          emit(comp);
        }
      }
    }

    function finish() {
      if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
      byte(0xff); byte(0xd9);
      parts.push(buf.subarray(0, pos));
      return parts;
    }
    return { band: band, finish: finish };
  }

  A.jpegCmyk = jpegCmyk;
  A.labelsDocx = labelsDocx;
  A.jpegSetDpi = jpegSetDpi;
  A.pdfFromJpeg = pdfFromJpeg;
  A.crc32 = crc32;
  A.pngSetDpi = pngSetDpi;
  A.zipStore = zipStore;
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
