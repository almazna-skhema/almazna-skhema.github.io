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

  A.labelsDocx = labelsDocx;
  A.jpegSetDpi = jpegSetDpi;
  A.pdfFromJpeg = pdfFromJpeg;
  A.crc32 = crc32;
  A.pngSetDpi = pngSetDpi;
  A.zipStore = zipStore;
})(typeof window !== 'undefined' ? (window.ALMAZ = window.ALMAZ || {}) : module.exports);
