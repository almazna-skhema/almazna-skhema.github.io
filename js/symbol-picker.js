/* Выбор нового значка для позначки — общий для разделов «Готовые макеты» и «Макет из схемы».
 * Окно #symDialog (#symThumb, #symSub, #symWarn, #symList, #symKeep, #symDone, #symClose) одинаковое
 * на обеих страницах. Раздел передаёт ctx(): { scan, edits, crops, size, used? } и onApply(k, symbol | null). */
(function (A) {
  'use strict';

  const T = A.T;
  const $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

  /* Покрытие значком области w×h (0…1): рисуем в 4 раза крупнее и усредняем — края получаются мягкими. */
  function maskFor(w, h, sym, frac) {
    const Q = 4, W4 = w * Q, H4 = h * Q, cv = A.makeCanvas(W4, H4), x = cv.getContext('2d', { willReadFrequently: true });
    A.drawSymbol(x, { symbol: sym, dark: false }, W4 / 2, H4 / 2, frac * Math.max(W4, H4));
    const a = x.getImageData(0, 0, W4, H4).data, m = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      let s = 0;
      for (let dy = 0; dy < Q; dy++) for (let dx = 0; dx < Q; dx++) s += a[((y * Q + dy) * W4 + xx * Q + dx) * 4 + 3];
      m[y * w + xx] = s / (Q * Q * 255);
    }
    cv.width = cv.height = 0;
    return m;
  }

  let ctx = null, onApply = null, pickFor = -1, pickSym = null;

  /* Похожий значок уже есть в макете: сравниваем форму с образцами клеток. */
  function similarTo(sym, except) {
    const c0 = ctx(), sc = c0.scan, grid = sc.grid, n = 10, w = Math.round(grid.pitch * 0.8), m = maskFor(w, w, sym, (grid.pitch * c0.size) / w);
    const small = new Float32Array(n * n), cnt = new Float32Array(n * n);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const i = Math.floor((y * n) / w) * n + Math.floor((x * n) / w); small[i] += m[y * w + x]; cnt[i]++; }
    for (let i = 0; i < n * n; i++) small[i] /= cnt[i];
    let best = -1, bd = Infinity;
    sc.classes.forEach(function (c, k) {
      if (k === except || c0.edits.has(k)) return;
      let s = 0;
      for (let i = 0; i < n * n; i++) { const q = small[i] - c.mask[i]; s += q * q; }
      if (s < bd) { bd = s; best = k; }
    });
    return bd < 1.6 ? best : -1;
  }

  function fill() {
    const c0 = ctx(), list = $('symList'), edits = c0.edits, taken = new Map();
    list.textContent = '';
    edits.forEach(function (s, k) { if (k !== pickFor) taken.set(s, k); });
    // значки, которые уже стоят в схеме у других цветов (если раздел их знает): used — Map значок → позначка
    if (c0.used) c0.used.forEach(function (k, s) { if (k !== pickFor && !edits.has(k)) taken.set(s, k); });
    A.SHAPES.concat(A.MORE_SHAPES, A.SYMBOLS, A.MORE_LETTERS, A.MORE_GLYPHS).forEach(function (sym) {
      const b = el('button', 'sym-item' + (sym === pickSym ? ' current' : '') + (taken.has(sym) ? ' used' : ''), sym);
      b.type = 'button';
      b.disabled = taken.has(sym);
      b.title = taken.has(sym) ? T('Уже выбран для другого значка') : T('Поставить этот значок');
      b.addEventListener('click', function () { pickSym = sym; fill(); warn(); });
      list.appendChild(b);
    });
  }

  function warn() {
    const w = $('symWarn'), k = pickSym ? similarTo(pickSym, pickFor) : -1;
    w.hidden = k < 0;
    if (k < 0) return;
    w.textContent = T('Похожий значок уже есть в макете — клетки будет легко перепутать при выкладке. Он показан ниже.');
    w.appendChild(ctx().crops[k].cloneNode());
  }

  function open(k) {
    const c0 = ctx(), c = c0.scan.classes[k], th = $('symThumb');
    pickFor = k;
    pickSym = c0.edits.get(k) || null;
    th.textContent = '';
    th.appendChild(c0.crops[k].cloneNode());
    $('symSub').textContent = fmt(c.count) + ' ' + T('клеток получат новый значок') + (c.legend >= 0 ? '' : ' · ' + T('этого значка нет в легенде'));
    fill();
    warn();
    const d = $('symDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }

  function close(apply) {
    const d = $('symDialog'), k = pickFor;
    if (d.close) d.close(); else d.removeAttribute('open');
    pickFor = -1;
    if (apply && k >= 0) onApply(k, pickSym);
  }

  function init(getCtx, apply) {
    ctx = getCtx;
    onApply = apply;
    $('symClose').addEventListener('click', function () { close(false); });
    $('symDone').addEventListener('click', function () { close(true); });
    $('symKeep').addEventListener('click', function () { pickSym = null; close(true); });
    $('symDialog').addEventListener('click', function (e) { if (e.target === e.currentTarget) close(false); });
    $('symDialog').addEventListener('close', function () { pickFor = -1; });
  }

  A.symbolPicker = { init: init, open: open, maskFor: maskFor, similarTo: function (s, k) { return similarTo(s, k); } };
})(window.ALMAZ = window.ALMAZ || {});
