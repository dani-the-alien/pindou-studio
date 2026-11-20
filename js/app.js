(() => {
  'use strict';

  // ---------- small helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const fmt = (n) => n.toLocaleString();
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function download(name, blobOrUrl) {
    const a = document.createElement('a');
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeName = (s) => (s || 'pattern').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'pattern';

  const MAX_DIM = 624;
  const TRANSPARENT_RGB = [226, 236, 246];

  // ---------- state ----------
  const S = {
    name: 'Untitled',
    paletteId: 'mard221',
    palette: [],
    codeIndex: new Map(),
    w: 52, h: 52, tray: 52,
    cells: new Int16Array(52 * 52).fill(-1),
    color: 0,
    tool: 'pencil',
    guides: 10, showCodes: true, round: false,
    view: { scale: 10, ox: 0, oy: 0 },
    focus: null, // {r, c}
    owned: new Set(),
    editOwned: false,
    filter: 'all', search: '', sort: 'count',
    undo: [], redo: [],
    stroke: null,
    hover: null,
  };

  // ---------- palette ----------
  function buildPalette(id) {
    return PALETTES[id].colors.map((c, i) => {
      const rgb = Color.hexToRgb(c.hex);
      return {
        i, code: c.code, hex: c.hex, rgb,
        lab: Color.rgbToLab(rgb[0], rgb[1], rgb[2]),
        text: c.transparent ? '#333' : Color.contrastText(c.hex),
        transparent: !!c.transparent,
        group: c.code.match(/^[A-Z]+/)[0],
      };
    });
  }
  function setPalette(id, remapCells) {
    const old = S.palette;
    S.paletteId = id;
    S.palette = buildPalette(id);
    S.codeIndex = new Map(S.palette.map((c) => [c.code, c.i]));
    S.owned = new Set(store.get('pindou.owned.' + id, S.palette.map((c) => c.code)));
    if (remapCells && old.length) {
      const map = new Int16Array(old.length);
      old.forEach((c, i) => { map[i] = S.codeIndex.has(c.code) ? S.codeIndex.get(c.code) : nearest(c.lab, allSolid()); });
      for (let i = 0; i < S.cells.length; i++) if (S.cells[i] >= 0) S.cells[i] = map[S.cells[i]];
      const cur = old[S.color];
      S.color = cur && S.codeIndex.has(cur.code) ? S.codeIndex.get(cur.code) : 0;
      S.undo = []; S.redo = [];
    }
    if (!S.palette[S.color]) S.color = 0;
  }
  const allSolid = () => S.palette.filter((c) => !c.transparent).map((c) => c.i);
  function nearest(lab, candidates) {
    let best = -1, bd = Infinity;
    for (const i of candidates) {
      const d = Color.deltaE2000(lab, S.palette[i].lab);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------- theme ----------
  const T = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'empty', 'grid', 'guide', 'tray', 'dim']) {
      T[k] = cs.getPropertyValue('--' + k).trim();
    }
    T.emptyRgb = Color.hexToRgb(T.empty);
  }

  // ---------- pixmap (1px per bead, used for fast square rendering + thumbnails) ----------
  let pix, pixCtx, pixData, pixDirty = true;
  function rebuildPixmap() {
    pix = document.createElement('canvas');
    pix.width = S.w; pix.height = S.h;
    pixCtx = pix.getContext('2d');
    pixData = pixCtx.createImageData(S.w, S.h);
    for (let i = 0; i < S.cells.length; i++) writePix(i);
    pixDirty = true;
  }
  function writePix(i) {
    const v = S.cells[i], d = pixData.data, o = i * 4;
    let rgb;
    if (v < 0) rgb = T.emptyRgb;
    else { const c = S.palette[v]; rgb = c.transparent ? TRANSPARENT_RGB : c.rgb; }
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
  }
  function flushPix() { if (pixDirty) { pixCtx.putImageData(pixData, 0, 0); pixDirty = false; } }

  // ---------- trays ----------
  const traysAcross = () => Math.ceil(S.w / S.tray);
  const traysDown = () => Math.ceil(S.h / S.tray);
  const trayCount = () => traysAcross() * traysDown();
  function trayRect(r, c) {
    const x = c * S.tray, y = r * S.tray;
    return { x, y, w: Math.min(S.tray, S.w - x), h: Math.min(S.tray, S.h - y) };
  }
  const trayName = (r, c) => (trayCount() === 1 ? 'Tray' : `R${r + 1}·C${c + 1}`);

  // ---------- canvas / view ----------
  const viewport = $('#viewport');
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  let vw = 0, vh = 0, dpr = 1, drawQueued = false;

  function resizeCanvas() {
    const r = viewport.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    vw = r.width; vh = r.height;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    requestDraw();
  }
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function fitView() {
    const rect = S.focus ? trayRect(S.focus.r, S.focus.c) : { x: 0, y: 0, w: S.w, h: S.h };
    const pad = 36;
    const scale = clamp(Math.min((vw - pad * 2) / rect.w, (vh - pad * 2) / rect.h), 0.5, 80);
    S.view.scale = scale;
    S.view.ox = (vw - rect.w * scale) / 2 - rect.x * scale;
    S.view.oy = (vh - rect.h * scale) / 2 - rect.y * scale + 6;
    requestDraw();
  }
  function zoomAt(factor, sx, sy) {
    const v = S.view;
    const ns = clamp(v.scale * factor, 0.5, 80);
    const k = ns / v.scale;
    v.ox = sx - (sx - v.ox) * k;
    v.oy = sy - (sy - v.oy) * k;
    v.scale = ns;
    requestDraw();
  }

  function draw() {
    flushPix();
    const { scale: s, ox, oy } = S.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, vw, vh);

    const x0 = clamp(Math.floor(-ox / s), 0, S.w), x1 = clamp(Math.ceil((vw - ox) / s), 0, S.w);
    const y0 = clamp(Math.floor(-oy / s), 0, S.h), y1 = clamp(Math.ceil((vh - oy) / s), 0, S.h);

    // board shadow
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(ox + 3, oy + 3, S.w * s, S.h * s);

    if (S.round && s >= 5) {
      ctx.fillStyle = T.empty;
      ctx.fillRect(ox, oy, S.w * s, S.h * s);
      const paths = new Map();
      const rad = s * 0.46, hole = (!S.showCodes || s < 16) && s >= 10 ? s * 0.15 : 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const v = S.cells[y * S.w + x];
        if (v < 0) continue;
        let p = paths.get(v); if (!p) { p = new Path2D(); paths.set(v, p); }
        const cx = ox + (x + 0.5) * s, cy = oy + (y + 0.5) * s;
        p.moveTo(cx + rad, cy); p.arc(cx, cy, rad, 0, Math.PI * 2);
        if (hole) { p.moveTo(cx + hole, cy); p.arc(cx, cy, hole, 0, Math.PI * 2, true); }
      }
      for (const [v, p] of paths) {
        const c = S.palette[v];
        ctx.fillStyle = c.transparent ? 'rgba(226,236,246,0.9)' : c.hex;
        ctx.fill(p, 'evenodd');
      }
    } else {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pix, ox, oy, S.w * s, S.h * s);
    }

    // grid lines
    if (s >= 6) {
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) { const px = Math.round(ox + x * s) + 0.5; ctx.moveTo(px, oy + y0 * s); ctx.lineTo(px, oy + y1 * s); }
      for (let y = y0; y <= y1; y++) { const py = Math.round(oy + y * s) + 0.5; ctx.moveTo(ox + x0 * s, py); ctx.lineTo(ox + x1 * s, py); }
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.stroke();
    }
    // guides (relative to each tray's origin, so they line up with the physical board)
    if (S.guides && s >= 2.5) {
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) if ((x % S.tray) % S.guides === 0) { const px = Math.round(ox + x * s) + 0.5; ctx.moveTo(px, oy + y0 * s); ctx.lineTo(px, oy + y1 * s); }
      for (let y = y0; y <= y1; y++) if ((y % S.tray) % S.guides === 0) { const py = Math.round(oy + y * s) + 0.5; ctx.moveTo(ox + x0 * s, py); ctx.lineTo(ox + x1 * s, py); }
      ctx.strokeStyle = T.guide; ctx.lineWidth = 1; ctx.stroke();
    }
    // codes
    if (S.showCodes && s >= 16) {
      ctx.font = `600 ${Math.floor(s * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const v = S.cells[y * S.w + x];
        if (v < 0) continue;
        const c = S.palette[v];
        ctx.fillStyle = c.text;
        ctx.fillText(c.code, ox + (x + 0.5) * s, oy + (y + 0.5) * s + 0.5);
      }
    }
    // tray boundaries
    ctx.beginPath();
    for (let c = 0; c <= traysAcross(); c++) { const x = Math.min(c * S.tray, S.w); const px = Math.round(ox + x * s); ctx.moveTo(px, oy); ctx.lineTo(px, oy + S.h * s); }
    for (let r = 0; r <= traysDown(); r++) { const y = Math.min(r * S.tray, S.h); const py = Math.round(oy + y * s); ctx.moveTo(ox, py); ctx.lineTo(ox + S.w * s, py); }
    ctx.strokeStyle = T.tray; ctx.lineWidth = 2; ctx.stroke();

    // focus dimming
    if (S.focus) {
      const t = trayRect(S.focus.r, S.focus.c);
      const fx = ox + t.x * s, fy = oy + t.y * s, fw = t.w * s, fh = t.h * s;
      ctx.fillStyle = T.dim;
      ctx.beginPath();
      ctx.rect(0, 0, vw, vh);
      ctx.rect(fx, fy, fw, fh);
      ctx.fill('evenodd');
      ctx.strokeStyle = T.tray; ctx.lineWidth = 3; ctx.strokeRect(fx, fy, fw, fh);
    }

    // rulers: per-tray local peg numbers along the top and left edge
    if (s >= 8) drawRulers(s, ox, oy, x0, x1, y0, y1);

    // hover
    if (S.hover) {
      ctx.strokeStyle = T.accent; ctx.lineWidth = 2;
      ctx.strokeRect(ox + S.hover.x * s + 1, oy + S.hover.y * s + 1, s - 2, s - 2);
    }
  }

  function drawRulers(s, ox, oy, x0, x1, y0, y1) {
    let rx0 = 0, ry0 = 0, rx1 = S.w, ry1 = S.h;
    if (S.focus) { const t = trayRect(S.focus.r, S.focus.c); rx0 = t.x; ry0 = t.y; rx1 = t.x + t.w; ry1 = t.y + t.h; }
    const step = s >= 20 ? 1 : s >= 12 ? 5 : 10;
    const fs = Math.min(11, Math.max(9, s * 0.45));
    ctx.font = `500 ${fs}px system-ui, sans-serif`;
    ctx.fillStyle = T.muted;
    const top = Math.max(oy + ry0 * s - 4, fs + 2);
    const left = Math.max(ox + rx0 * s - 4, 22);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let x = Math.max(x0, rx0); x < Math.min(x1, rx1); x++) {
      const n = (x % S.tray) + 1;
      if (n === 1 || n % step === 0) ctx.fillText(String(n), ox + (x + 0.5) * s, top);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = Math.max(y0, ry0); y < Math.min(y1, ry1); y++) {
      const n = (y % S.tray) + 1;
      if (n === 1 || n % step === 0) ctx.fillText(String(n), left, oy + (y + 0.5) * s);
    }
  }

  // ---------- editing ----------
  function cellAt(sx, sy) {
    const x = Math.floor((sx - S.view.ox) / S.view.scale), y = Math.floor((sy - S.view.oy) / S.view.scale);
    if (x < 0 || y < 0 || x >= S.w || y >= S.h) return null;
    return { x, y, i: y * S.w + x };
  }
  function setCell(i, v) {
    const old = S.cells[i];
    if (old === v) return;
    if (S.stroke && !S.stroke.has(i)) S.stroke.set(i, old);
    S.cells[i] = v; writePix(i); pixDirty = true;
  }
  function beginStroke() { S.stroke = new Map(); }
  function endStroke() {
    const st = S.stroke; S.stroke = null;
    if (!st || !st.size) return;
    const ch = [];
    for (const [i, old] of st) if (S.cells[i] !== old) ch.push([i, old, S.cells[i]]);
    if (ch.length) { pushUndo({ type: 'cells', ch }); changed(); }
  }
  function cancelStroke() {
    if (!S.stroke) return;
    for (const [i, old] of S.stroke) { S.cells[i] = old; writePix(i); }
    S.stroke = null; pixDirty = true; requestDraw();
  }
  function snapshot() { return { w: S.w, h: S.h, cells: S.cells.slice() }; }
  function pushUndo(rec) {
    S.undo.push(rec);
    if (S.undo.length > 200) S.undo.shift();
    S.redo.length = 0;
  }
  function applyRec(rec, back) {
    if (rec.type === 'cells') {
      for (const [i, o, n] of rec.ch) { S.cells[i] = back ? o : n; writePix(i); }
      pixDirty = true;
    } else {
      loadGrid(back ? rec.before : rec.after);
    }
    changed();
  }
  function undo() { const r = S.undo.pop(); if (!r) return; applyRec(r, true); S.redo.push(r); }
  function redo() { const r = S.redo.pop(); if (!r) return; applyRec(r, false); S.undo.push(r); }

  function loadGrid(g) {
    const dimsChanged = g.w !== S.w || g.h !== S.h;
    S.w = g.w; S.h = g.h; S.cells = g.cells.slice();
    if (S.focus && (S.focus.r >= traysDown() || S.focus.c >= traysAcross())) S.focus = null;
    rebuildPixmap();
    if (dimsChanged) fitView();
  }
  function replaceGrid(next, label) {
    const before = snapshot();
    loadGrid(next);
    pushUndo({ type: 'snap', before, after: snapshot() });
    changed();
    fitView();
    if (label) toast(label);
  }

  function line(a, b, fn) {
    let x0 = a.x, y0 = a.y; const x1 = b.x, y1 = b.y;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function floodFill(start, v) {
    const target = S.cells[start];
    if (target === v) return;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (S.cells[i] !== target) continue;
      setCell(i, v);
      const x = i % S.w, y = (i / S.w) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < S.w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - S.w);
      if (y < S.h - 1) stack.push(i + S.w);
    }
  }
  function replaceAll(target, v) {
    if (target === v) return;
    for (let i = 0; i < S.cells.length; i++) if (S.cells[i] === target) setCell(i, v);
  }

  // ---------- pointer input ----------
  const pointers = new Map();
  let gesture = null; // {kind:'draw'|'pan'|'pinch', ...}
  let spaceDown = false;

  function localPt(e) { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  viewport.addEventListener('pointerdown', (e) => {
    viewport.setPointerCapture(e.pointerId);
    const p = localPt(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      // second finger: abandon any stroke and pinch-zoom instead
      cancelStroke();
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;
    if (e.button === 1 || S.tool === 'pan' || spaceDown) {
      gesture = { kind: 'pan', x: p.x, y: p.y };
      viewport.classList.add('panning');
      return;
    }
    const cell = cellAt(p.x, p.y);
    const erase = e.button === 2 || S.tool === 'eraser';
    if (S.tool === 'picker') {
      if (cell && S.cells[cell.i] >= 0) { selectColor(S.cells[cell.i]); setTool('pencil'); }
      return;
    }
    if (!cell) { gesture = { kind: 'pan', x: p.x, y: p.y }; viewport.classList.add('panning'); return; }
    if (S.focus && !inFocus(cell)) return;
    if (S.tool === 'fill' && !erase) { beginStroke(); floodFill(cell.i, S.color); endStroke(); requestDraw(); return; }
    if (S.tool === 'replace' && !erase) { beginStroke(); replaceAll(S.cells[cell.i], S.color); endStroke(); requestDraw(); return; }
    const v = erase ? -1 : S.color;
    beginStroke(); setCell(cell.i, v);
    gesture = { kind: 'draw', v, last: cell };
    requestDraw();
  });
  viewport.addEventListener('pointermove', (e) => {
    const p = localPt(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (gesture && gesture.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      S.view.ox += cx - gesture.cx; S.view.oy += cy - gesture.cy;
      if (gesture.dist > 0) zoomAt(dist / gesture.dist, cx, cy);
      Object.assign(gesture, { dist, cx, cy });
      requestDraw();
      return;
    }
    if (gesture && gesture.kind === 'pan') {
      S.view.ox += p.x - gesture.x; S.view.oy += p.y - gesture.y;
      gesture.x = p.x; gesture.y = p.y;
      requestDraw();
      return;
    }
    const cell = cellAt(p.x, p.y);
    setHover(cell);
    if (gesture && gesture.kind === 'draw' && cell) {
      line(gesture.last, cell, (x, y) => { const c = { x, y }; if (!S.focus || inFocus(c)) setCell(y * S.w + x, gesture.v); });
      gesture.last = cell;
      requestDraw();
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'draw') endStroke();
    if (gesture.kind === 'pinch' && pointers.size === 1) {
      const [p] = [...pointers.values()];
      gesture = { kind: 'pan', x: p.x, y: p.y }; // keep panning with the remaining finger
      return;
    }
    if (pointers.size === 0) { gesture = null; viewport.classList.remove('panning'); }
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', (e) => { if (gesture && gesture.kind === 'draw') cancelStroke(); endPointer(e); });
  viewport.addEventListener('pointerleave', () => { if (!gesture) setHover(null); });
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPt(e);
    const mouseNotch = !e.shiftKey && e.deltaX === 0 && (e.deltaMode === 1 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50));
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch (browsers report it as ctrl+wheel) or explicit ctrl+wheel
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)), p.x, p.y);
    } else if (mouseNotch) {
      // classic mouse wheel: zoom like most pixel editors
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
    } else {
      // trackpad two-finger scroll / shift+wheel: pan
      S.view.ox -= e.shiftKey ? e.deltaY : e.deltaX;
      S.view.oy -= e.shiftKey ? 0 : e.deltaY;
      requestDraw();
    }
  }, { passive: false });

  function inFocus(cell) {
    const t = trayRect(S.focus.r, S.focus.c);
    return cell.x >= t.x && cell.x < t.x + t.w && cell.y >= t.y && cell.y < t.y + t.h;
  }

  function setHover(cell) {
    const prev = S.hover;
    S.hover = cell;
    if ((prev && cell && prev.i === cell.i) || (!prev && !cell)) return;
    requestDraw();
    const st = $('#status');
    if (!cell) { st.innerHTML = '&nbsp;'; return; }
    const r = Math.floor(cell.y / S.tray), c = Math.floor(cell.x / S.tray);
    const v = S.cells[cell.i];
    const bead = v >= 0 ? `${S.palette[v].code} ${S.palette[v].hex}${S.palette[v].transparent ? ' (clear)' : ''}` : 'empty';
    st.textContent = `x ${cell.x + 1}, y ${cell.y + 1} · ${trayName(r, c)} peg ${(cell.x % S.tray) + 1}, ${(cell.y % S.tray) + 1} · ${bead}`;
  }

  // ---------- tools & color ----------
  function setTool(t) {
    S.tool = t;
    $$('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
    viewport.classList.toggle('pan', t === 'pan');
    viewport.classList.toggle('draw', t !== 'pan');
  }
  function selectColor(i) {
    S.color = i;
    const c = S.palette[i];
    const sw = $('#currentSwatch');
    sw.style.background = c.hex;
    sw.classList.toggle('clear', c.transparent);
    $('#currentCode').textContent = c.code;
    sw.title = `${c.code} ${c.hex}`;
    $$('#swatches .sw').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
  }

  // ---------- counts ----------
  function countRegion(rect) {
    const counts = new Int32Array(S.palette.length);
    const r = rect || { x: 0, y: 0, w: S.w, h: S.h };
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const v = S.cells[y * S.w + x];
      if (v >= 0) counts[v]++;
    }
    return counts;
  }
  function usedList(counts, sort) {
    const list = [];
    counts.forEach((n, i) => { if (n) list.push({ c: S.palette[i], n }); });
    if (sort === 'code') list.sort((a, b) => a.c.i - b.c.i); else list.sort((a, b) => b.n - a.n || a.c.i - b.c.i);
    return list;
  }

  // ---------- panels ----------
  let panelTimer;
  function changed() {
    requestDraw();
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => { refreshPanels(); autosave(); }, 120);
  }
  function refreshPanels() {
    renderSwatches();
    renderCounts();
    renderTrays();
    updateInfo();
  }
  function updateInfo() {
    const n = trayCount();
    const mm = (v) => (v * 2.6 / 10).toFixed(1);
    $('#sizeInfo').textContent = `${S.w}×${S.h} beads · ${traysAcross()}×${traysDown()} = ${n} tray${n > 1 ? 's' : ''} · ≈${mm(S.w)}×${mm(S.h)} cm`;
    const fb = $('#focusBanner');
    fb.hidden = !S.focus;
    if (S.focus) $('#focusLabel').textContent = `${trayName(S.focus.r, S.focus.c)} (${S.focus.r * traysAcross() + S.focus.c + 1}/${n})`;
  }

  function renderSwatches() {
    const box = $('#swatches');
    const counts = S.filter === 'used' ? countRegion() : null;
    const used = countRegion();
    const q = S.search.trim().toUpperCase();
    box.innerHTML = '';
    let group = null;
    const frag = document.createDocumentFragment();
    for (const c of S.palette) {
      if (q && !c.code.includes(q) && !c.hex.includes(q)) continue;
      if (S.filter === 'owned' && !S.owned.has(c.code)) continue;
      if (S.filter === 'used' && !counts[c.i]) continue;
      if (c.group !== group) {
        group = c.group;
        const g = document.createElement('div'); g.className = 'group-label'; g.textContent = group;
        frag.appendChild(g);
      }
      const b = document.createElement('button');
      b.className = 'sw' + (c.transparent ? ' clear' : '') + (S.owned.has(c.code) ? '' : ' unowned');
      b.style.background = c.hex; b.style.color = c.text;
      b.dataset.i = c.i;
      b.title = `${c.code} ${c.hex}${c.transparent ? ' (clear)' : ''}${used[c.i] ? ` · ${used[c.i]} in design` : ''}${S.owned.has(c.code) ? '' : ' · not in my collection'}`;
      b.setAttribute('aria-pressed', String(c.i === S.color));
      b.textContent = c.code;
      if (used[c.i]) { const d = document.createElement('span'); d.className = 'used-dot'; b.appendChild(d); }
      frag.appendChild(b);
    }
    box.appendChild(frag);
    if (!box.children.length) box.innerHTML = '<p class="hint">No colors match.</p>';
  }

  function renderCounts() {
    const rect = S.focus ? trayRect(S.focus.r, S.focus.c) : null;
    const counts = countRegion(rect);
    const list = usedList(counts, S.sort);
    const total = list.reduce((a, b) => a + b.n, 0);
    $('#countTotal').textContent = `${fmt(total)} beads · ${list.length} colors`;
    $('#countScope').textContent = S.focus ? `Showing ${trayName(S.focus.r, S.focus.c)} only. Close tray focus to see the whole design.` : 'Whole design.';
    const body = $('#countBody');
    body.innerHTML = '';
    for (const { c, n } of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="swatch${c.transparent ? ' clear' : ''}" style="display:inline-block;vertical-align:middle;background:${c.hex}"></span></td><td><strong>${c.code}</strong></td><td class="muted">${c.hex}</td><td class="n">${fmt(n)}</td><td class="n muted">${(n / total * 100).toFixed(1)}%</td>`;
      tr.addEventListener('click', () => selectColor(c.i));
      body.appendChild(tr);
    }
    if (!list.length) body.innerHTML = '<tr><td class="muted">Nothing placed yet.</td></tr>';
  }

  function renderTrays() {
    flushPix();
    const grid = $('#trayGrid');
    const across = traysAcross(), down = traysDown();
    grid.style.gridTemplateColumns = `repeat(${Math.min(across, 6)}, 1fr)`;
    grid.innerHTML = '';
    $('#trayInfo').textContent = `${across} across × ${down} down, ${S.tray}×${S.tray} pegs each.` + (S.w % S.tray || S.h % S.tray ? ' Edge trays are only partly used.' : '');
    for (let r = 0; r < down; r++) for (let c = 0; c < across; c++) {
      const t = trayRect(r, c);
      const b = document.createElement('button');
      b.className = 'tray-cell';
      b.setAttribute('aria-pressed', String(!!S.focus && S.focus.r === r && S.focus.c === c));
      const cv = document.createElement('canvas');
      cv.width = S.tray; cv.height = S.tray;
      const g = cv.getContext('2d');
      g.fillStyle = T.empty; g.fillRect(0, 0, S.tray, S.tray);
      g.drawImage(pix, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      if (t.w < S.tray || t.h < S.tray) { g.fillStyle = 'rgba(128,128,128,0.35)'; g.fillRect(t.w, 0, S.tray - t.w, S.tray); g.fillRect(0, t.h, t.w, S.tray - t.h); }
      let n = 0; for (const v of countRegion(t)) n += v;
      const lab = document.createElement('span');
      lab.textContent = `${trayName(r, c)} · ${fmt(n)}`;
      b.append(cv, lab);
      b.addEventListener('click', () => focusTray(r, c));
      grid.appendChild(b);
    }
  }

  function focusTray(r, c) {
    if (r == null) S.focus = null;
    else S.focus = { r, c };
    fitView();
    refreshPanels();
  }
  function stepTray(d) {
    const across = traysAcross(), n = trayCount();
    const cur = S.focus ? S.focus.r * across + S.focus.c : (d > 0 ? -1 : n);
    const k = (cur + d + n) % n;
    focusTray(Math.floor(k / across), k % across);
  }

  // ---------- persistence ----------
  function serialize() {
    const used = new Map(); const legend = [];
    const cells = new Array(S.cells.length);
    for (let i = 0; i < S.cells.length; i++) {
      const v = S.cells[i];
      if (v < 0) { cells[i] = -1; continue; }
      if (!used.has(v)) { used.set(v, legend.length); legend.push(S.palette[v].code); }
      cells[i] = used.get(v);
    }
    return { format: 'pindou-studio', version: 1, name: S.name, palette: S.paletteId, tray: S.tray, w: S.w, h: S.h, legend, cells };
  }
  function deserialize(d) {
    if (!d || d.format !== 'pindou-studio' || !Array.isArray(d.cells)) throw new Error('Not a Pindou Studio project file');
    const w = d.w | 0, h = d.h | 0;
    if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM || d.cells.length !== w * h) throw new Error('Project size is invalid');
    if (PALETTES[d.palette] && d.palette !== S.paletteId) setPalette(d.palette, false);
    const map = d.legend.map((code) => {
      if (S.codeIndex.has(code)) return S.codeIndex.get(code);
      return -1;
    });
    const missing = d.legend.filter((code) => !S.codeIndex.has(code));
    const cells = new Int16Array(w * h);
    for (let i = 0; i < cells.length; i++) { const v = d.cells[i]; cells[i] = v >= 0 && v < map.length ? map[v] : -1; }
    S.name = String(d.name || 'Untitled');
    S.tray = clamp(d.tray | 0 || 52, 5, 300);
    S.undo = []; S.redo = []; S.focus = null;
    loadGrid({ w, h, cells });
    return missing;
  }
  let saveTimer;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('pindou.autosave', serialize()), 300);
  }

  // ---------- rendering for export / print ----------
  function renderRegion(rect, cs, opts = {}) {
    const pad = opts.rulers ? Math.max(20, Math.round(cs * 1.1)) : 2;
    const cv = document.createElement('canvas');
    cv.width = pad + rect.w * cs + 2; cv.height = pad + rect.h * cs + 2;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    const ox = pad, oy = pad;
    for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
      const v = S.cells[(rect.y + y) * S.w + rect.x + x];
      if (v < 0) { g.fillStyle = '#f1f1f1'; g.fillRect(ox + x * cs, oy + y * cs, cs, cs); continue; }
      const c = S.palette[v];
      g.fillStyle = c.transparent ? 'rgb(226,236,246)' : c.hex;
      g.fillRect(ox + x * cs, oy + y * cs, cs, cs);
    }
    if (cs >= 4) {
      g.beginPath();
      for (let x = 0; x <= rect.w; x++) { g.moveTo(ox + x * cs + 0.5, oy); g.lineTo(ox + x * cs + 0.5, oy + rect.h * cs); }
      for (let y = 0; y <= rect.h; y++) { g.moveTo(ox, oy + y * cs + 0.5); g.lineTo(ox + rect.w * cs, oy + y * cs + 0.5); }
      g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 1; g.stroke();
    }
    const gs = S.guides || 10;
    g.beginPath();
    for (let x = 0; x <= rect.w; x++) if (((rect.x + x) % S.tray) % gs === 0) { g.moveTo(ox + x * cs + 0.5, oy); g.lineTo(ox + x * cs + 0.5, oy + rect.h * cs); }
    for (let y = 0; y <= rect.h; y++) if (((rect.y + y) % S.tray) % gs === 0) { g.moveTo(ox, oy + y * cs + 0.5); g.lineTo(ox + rect.w * cs, oy + y * cs + 0.5); }
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke();
    g.beginPath();
    for (let x = 0; x <= rect.w; x++) if ((rect.x + x) % S.tray === 0 || x === rect.w) { g.moveTo(ox + x * cs, oy); g.lineTo(ox + x * cs, oy + rect.h * cs); }
    for (let y = 0; y <= rect.h; y++) if ((rect.y + y) % S.tray === 0 || y === rect.h) { g.moveTo(ox, oy + y * cs); g.lineTo(ox + rect.w * cs, oy + y * cs); }
    g.strokeStyle = '#2f6fde'; g.lineWidth = Math.max(2, cs / 8); g.stroke();
    if (opts.codes && cs >= 12) {
      g.font = `700 ${Math.floor(cs * 0.36)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
        const v = S.cells[(rect.y + y) * S.w + rect.x + x];
        if (v < 0) continue;
        const c = S.palette[v];
        g.fillStyle = c.text;
        g.fillText(c.code, ox + (x + 0.5) * cs, oy + (y + 0.5) * cs + 0.5);
      }
    }
    if (opts.rulers) {
      const step = cs >= 18 ? 1 : cs >= 9 ? 5 : 10;
      g.font = `500 ${Math.min(12, Math.max(8, cs * 0.45))}px system-ui, sans-serif`;
      g.fillStyle = '#555';
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      for (let x = 0; x < rect.w; x++) { const n = ((rect.x + x) % S.tray) + 1; if (n === 1 || n % step === 0) g.fillText(String(n), ox + (x + 0.5) * cs, oy - 3); }
      g.textAlign = 'right'; g.textBaseline = 'middle';
      for (let y = 0; y < rect.h; y++) { const n = ((rect.y + y) % S.tray) + 1; if (n === 1 || n % step === 0) g.fillText(String(n), ox - 3, oy + (y + 0.5) * cs); }
    }
    if (opts.trayLabels && trayCount() > 1) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 ${Math.max(12, Math.min(40, S.tray * cs / 5))}px system-ui, sans-serif`;
      for (let r = 0; r < traysDown(); r++) for (let c = 0; c < traysAcross(); c++) {
        const t = trayRect(r, c);
        const cx = ox + (t.x + t.w / 2) * cs, cy = oy + (t.y + t.h / 2) * cs;
        g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.strokeText(trayName(r, c), cx, cy);
        g.fillStyle = '#1d4fb8'; g.fillText(trayName(r, c), cx, cy);
      }
    }
    return cv;
  }

  function exportPng() {
    const cs = clamp(Math.floor(5000 / Math.max(S.w, S.h)), 4, 24);
    const pattern = renderRegion({ x: 0, y: 0, w: S.w, h: S.h }, cs, { codes: true, rulers: true });
    const list = usedList(countRegion(), 'code');
    const total = list.reduce((a, b) => a + b.n, 0);
    const colW = 150, rowH = 24;
    const cols = Math.max(1, Math.floor((pattern.width - 20) / colW));
    const rows = Math.ceil(list.length / cols);
    const head = 56;
    const out = document.createElement('canvas');
    out.width = Math.max(pattern.width, 480); out.height = head + pattern.height + 30 + rows * rowH + 20;
    const g = out.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
    g.fillStyle = '#111'; g.font = '700 20px system-ui, sans-serif'; g.textBaseline = 'top';
    g.fillText(S.name, 12, 10);
    g.font = '13px system-ui, sans-serif'; g.fillStyle = '#555';
    g.fillText(`${S.w}×${S.h} beads · ${traysAcross()}×${traysDown()} trays of ${S.tray} · ${fmt(total)} beads · ${list.length} colors · ${PALETTES[S.paletteId].name}`, 12, 34);
    g.drawImage(pattern, 0, head);
    let y0 = head + pattern.height + 20;
    g.font = '600 13px system-ui, sans-serif'; g.textBaseline = 'middle';
    list.forEach(({ c, n }, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const x = 12 + col * colW, y = y0 + row * rowH;
      g.fillStyle = c.transparent ? 'rgb(226,236,246)' : c.hex; g.fillRect(x, y, 18, 18);
      g.strokeStyle = '#999'; g.strokeRect(x + 0.5, y + 0.5, 17, 17);
      g.fillStyle = '#111'; g.fillText(`${c.code}  × ${fmt(n)}`, x + 26, y + 9);
    });
    out.toBlob((b) => download(safeName(S.name) + '.png', b), 'image/png');
  }

  function exportCsv() {
    const across = traysAcross(), down = traysDown();
    const trays = [];
    for (let r = 0; r < down; r++) for (let c = 0; c < across; c++) trays.push({ name: trayName(r, c), counts: countRegion(trayRect(r, c)) });
    const total = countRegion();
    const lines = [['code', 'hex', 'total', ...(trays.length > 1 ? trays.map((t) => t.name) : [])].join(',')];
    for (const { c, n } of usedList(total, 'code')) {
      lines.push([c.code, c.hex, n, ...(trays.length > 1 ? trays.map((t) => t.counts[c.i]) : [])].join(','));
    }
    download(safeName(S.name) + '-beads.csv', new Blob(['﻿' + lines.join('\n') + '\n'], { type: 'text/csv' }));
  }

  async function printTrays() {
    const root = $('#printRoot');
    root.innerHTML = '';
    const total = countRegion();
    const totalList = usedList(total, 'code');
    const legendHtml = (list) => list.map(({ c, n }) => `<div><span class="chip" style="background:${c.transparent ? 'rgb(226,236,246)' : c.hex}"></span><b>${c.code}</b> × ${fmt(n)}</div>`).join('');
    const addSheet = (title, sub, canvasEl, list) => {
      const sec = document.createElement('section'); sec.className = 'sheet';
      const img = new Image(); img.src = canvasEl.toDataURL('image/png');
      sec.innerHTML = `<h2>${escapeHtml(title)}</h2><div style="font-size:12px;color:#555;margin-bottom:6px">${escapeHtml(sub)}</div>`;
      sec.appendChild(img);
      const lg = document.createElement('div'); lg.className = 'legend'; lg.innerHTML = legendHtml(list);
      sec.appendChild(lg);
      root.appendChild(sec);
      return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
    };
    const waits = [];
    const ovCs = clamp(Math.floor(1400 / Math.max(S.w, S.h)), 2, 16);
    waits.push(addSheet(`${S.name} — overview`,
      `${S.w}×${S.h} beads · ${traysAcross()}×${traysDown()} trays of ${S.tray}×${S.tray} · ${fmt(totalList.reduce((a, b) => a + b.n, 0))} beads · ${PALETTES[S.paletteId].name}`,
      renderRegion({ x: 0, y: 0, w: S.w, h: S.h }, ovCs, { trayLabels: true, codes: trayCount() === 1 && ovCs >= 14, rulers: trayCount() === 1 }), totalList));
    if (trayCount() > 1 || ovCs < 14) {
      const cs = S.tray > 80 ? 14 : 20;
      for (let r = 0; r < traysDown(); r++) for (let c = 0; c < traysAcross(); c++) {
        const t = trayRect(r, c);
        const list = usedList(countRegion(t), 'code');
        const n = list.reduce((a, b) => a + b.n, 0);
        waits.push(addSheet(`${S.name} — ${trayName(r, c)}`,
          `Tray ${r * traysAcross() + c + 1} of ${trayCount()} · columns ${t.x + 1}–${t.x + t.w}, rows ${t.y + 1}–${t.y + t.h} of the full design · ${fmt(n)} beads`,
          renderRegion(t, cs, { codes: true, rulers: true }), list));
      }
    }
    await Promise.all(waits);
    window.print();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- image → pattern ----------
  const imgState = { img: null, aspect: 1, result: null, timer: null };

  function openImageDialog() {
    const dlg = $('#imageDialog');
    const q = $('#imgQuick'); q.innerHTML = '';
    [1, 2, 3, 4].forEach((k) => {
      const b = document.createElement('button'); b.type = 'button';
      b.textContent = `${k} tray${k > 1 ? 's' : ''} wide (${k * S.tray})`;
      b.addEventListener('click', () => { $('#imgW').value = k * S.tray; syncImgDims('w'); scheduleConvert(); });
      q.appendChild(b);
    });
    $('#imgOwned').disabled = S.owned.size === 0;
    dlg.showModal();
  }
  function syncImgDims(from) {
    if (!$('#imgLock').checked || !imgState.img) return;
    if (from === 'w') $('#imgH').value = clamp(Math.round(+$('#imgW').value / imgState.aspect), 1, MAX_DIM);
    else $('#imgW').value = clamp(Math.round(+$('#imgH').value * imgState.aspect), 1, MAX_DIM);
  }
  function scheduleConvert() {
    clearTimeout(imgState.timer);
    $('#imgStats').textContent = 'Converting…';
    imgState.timer = setTimeout(runConvert, 150);
  }
  function downscale(img, w, h) {
    // step down by halves so large reductions average pixels instead of skipping them
    let src = img, sw = img.naturalWidth, sh = img.naturalHeight;
    while (sw / 2 > w && sh / 2 > h) {
      const c = document.createElement('canvas');
      c.width = Math.max(w, Math.floor(sw / 2)); c.height = Math.max(h, Math.floor(sh / 2));
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
  }
  function convert(opts) {
    const { w, h } = opts;
    const data = downscale(imgState.img, w, h);
    let cand = S.palette.filter((c) => !c.transparent && (!opts.owned || S.owned.has(c.code))).map((c) => c.i);
    if (!cand.length) cand = allSolid();
    const run = (candidates) => {
      const cache = new Map();
      const match = (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        let v = cache.get(key);
        if (v === undefined) { v = nearest(Color.rgbToLab(r, g, b), candidates); cache.set(key, v); }
        return v;
      };
      const out = new Int16Array(w * h);
      const buf = new Float32Array(w * h * 3);
      for (let i = 0; i < w * h; i++) { buf[i * 3] = data[i * 4]; buf[i * 3 + 1] = data[i * 4 + 1]; buf[i * 3 + 2] = data[i * 4 + 2]; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (opts.clear && data[i * 4 + 3] < 128) { out[i] = -1; continue; }
        const r = clamp(Math.round(buf[i * 3]), 0, 255), g = clamp(Math.round(buf[i * 3 + 1]), 0, 255), b = clamp(Math.round(buf[i * 3 + 2]), 0, 255);
        const v = match(r, g, b);
        out[i] = v;
        if (opts.dither) {
          const p = S.palette[v].rgb;
          const er = r - p[0], eg = g - p[1], eb = b - p[2];
          const push = (xx, yy, f) => {
            if (xx < 0 || xx >= w || yy >= h) return;
            const j = yy * w + xx;
            if (opts.clear && data[j * 4 + 3] < 128) return;
            buf[j * 3] += er * f; buf[j * 3 + 1] += eg * f; buf[j * 3 + 2] += eb * f;
          };
          push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
        }
      }
      return out;
    };
    let out = run(cand);
    if (opts.max > 0) {
      const counts = new Map();
      for (const v of out) if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1);
      if (counts.size > opts.max) out = run(reduceColors(counts, opts.max));
    }
    if (opts.bg) removeBackground(out, w, h);
    return { w, h, cells: out };
  }
  // Drop colors one at a time, always removing the one that is cheapest to lose
  // (bead count × distance to its nearest surviving color). Unlike "keep the most
  // common N", this keeps small but distinct details such as eyes and outlines.
  function reduceColors(counts, max) {
    const kept = new Map(counts);
    while (kept.size > max) {
      let worst = -1, into = -1, best = Infinity;
      for (const [a, na] of kept) {
        let nd = Infinity, ni = -1;
        for (const b of kept.keys()) {
          if (a === b) continue;
          const d = Color.deltaE2000(S.palette[a].lab, S.palette[b].lab);
          if (d < nd) { nd = d; ni = b; }
        }
        const cost = na * nd;
        if (cost < best) { best = cost; worst = a; into = ni; }
      }
      kept.set(into, kept.get(into) + kept.get(worst));
      kept.delete(worst);
    }
    return [...kept.keys()];
  }

  function removeBackground(cells, w, h) {
    const edge = new Map();
    const note = (i) => { const v = cells[i]; if (v >= 0) edge.set(v, (edge.get(v) || 0) + 1); };
    for (let x = 0; x < w; x++) { note(x); note((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { note(y * w); note(y * w + w - 1); }
    if (!edge.size) return;
    const bg = [...edge.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
    for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (cells[i] !== bg) continue;
      cells[i] = -1;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - w);
      if (y < h - 1) stack.push(i + w);
    }
  }
  function runConvert() {
    if (!imgState.img) return;
    const w = clamp(+$('#imgW').value | 0, 1, MAX_DIM), h = clamp(+$('#imgH').value | 0, 1, MAX_DIM);
    const res = convert({
      w, h,
      max: clamp(+$('#imgMax').value | 0, 0, 999),
      owned: $('#imgOwned').checked,
      dither: $('#imgDither').checked,
      bg: $('#imgBg').checked,
      clear: $('#imgClear').checked,
    });
    imgState.result = res;
    // preview
    const pv = $('#imgPreview');
    const cs = Math.max(1, Math.floor(480 / Math.max(w, h)));
    pv.width = w * cs; pv.height = h * cs;
    const g = pv.getContext('2d');
    const used = new Set(); let beads = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = res.cells[y * w + x];
      if (v < 0) { g.fillStyle = ((x + y) & 1) ? '#ddd' : '#eee'; } else { g.fillStyle = S.palette[v].hex; used.add(v); beads++; }
      g.fillRect(x * cs, y * cs, cs, cs);
    }
    const ta = Math.ceil(w / S.tray), td = Math.ceil(h / S.tray);
    $('#imgStats').textContent = `${w}×${h} · ${fmt(beads)} beads · ${used.size} colors · ${ta}×${td} tray${ta * td > 1 ? 's' : ''} of ${S.tray}`;
    $('#imgApply').disabled = false;
  }

  // ---------- new / resize ----------
  function openNewDialog() {
    const T0 = S.tray;
    $('#newTray').value = [52, 72, 78, 104].includes(T0) ? String(T0) : '52';
    $('#newAcross').value = traysAcross(); $('#newDown').value = traysDown();
    $('#newW').value = S.w; $('#newH').value = S.h;
    $('#newKeep').checked = false;
    updateNewSummary();
    $('#newDialog').showModal();
  }
  function updateNewSummary() {
    const w = +$('#newW').value | 0, h = +$('#newH').value | 0, t = +$('#newTray').value;
    $('#newSummary').textContent = `${w}×${h} beads → ${Math.ceil(w / t)}×${Math.ceil(h / t)} trays · ${fmt(w * h)} pegs · ≈${(w * 0.26).toFixed(1)}×${(h * 0.26).toFixed(1)} cm`;
  }

  // ---------- wiring ----------
  function setTraySize(n) {
    S.tray = n;
    const sel = $('#traySize');
    if ([...sel.options].some((o) => o.value === String(n))) sel.value = String(n);
    else {
      let o = sel.querySelector('option[data-custom]');
      if (!o) { o = document.createElement('option'); o.dataset.custom = '1'; sel.insertBefore(o, sel.lastElementChild); }
      o.value = String(n); o.textContent = `${n} × ${n}`; sel.value = String(n);
    }
    S.focus = null;
    changed(); refreshPanels(); requestDraw();
  }

  function bind() {
    // top actions
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      const menu = $('#exportMenu');
      if (!b) { if (!e.target.closest('.menu')) { menu.hidden = true; } return; }
      const a = b.dataset.action;
      if (a !== 'toggle-export') menu.hidden = true;
      switch (a) {
        case 'new': openNewDialog(); break;
        case 'import-image': openImageDialog(); break;
        case 'open': $('#openFile').click(); break;
        case 'save': download(safeName(S.name) + '.pindou.json', new Blob([JSON.stringify(serialize())], { type: 'application/json' })); break;
        case 'toggle-export': menu.hidden = !menu.hidden; b.setAttribute('aria-expanded', String(!menu.hidden)); break;
        case 'export-png': exportPng(); break;
        case 'export-csv': exportCsv(); break;
        case 'print-trays': printTrays(); break;
        case 'undo': undo(); break;
        case 'redo': redo(); break;
        case 'zoom-in': zoomAt(1.25, vw / 2, vh / 2); break;
        case 'zoom-out': zoomAt(0.8, vw / 2, vh / 2); break;
        case 'zoom-fit': fitView(); break;
        case 'tray-prev': stepTray(-1); break;
        case 'tray-next': stepTray(1); break;
        case 'tray-unfocus': focusTray(null); break;
      }
    });
    $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

    $('#projectName').addEventListener('input', (e) => { S.name = e.target.value; autosave(); });

    $('#traySize').addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        const v = parseInt(prompt('Pegs per side for one tray (5–300):', String(S.tray)), 10);
        if (v >= 5 && v <= 300) setTraySize(v); else e.target.value = String(S.tray);
      } else setTraySize(+e.target.value);
    });
    $('#guides').addEventListener('change', (e) => { S.guides = +e.target.value; savePrefs(); requestDraw(); });
    $('#showCodes').addEventListener('change', (e) => { S.showCodes = e.target.checked; savePrefs(); requestDraw(); });
    $('#roundBeads').addEventListener('change', (e) => { S.round = e.target.checked; savePrefs(); requestDraw(); });

    // tabs
    $$('.tabs [role=tab]').forEach((t) => t.addEventListener('click', () => {
      $$('.tabs [role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    }));

    // palette panel
    const ps = $('#paletteSelect');
    for (const [id, p] of Object.entries(PALETTES)) {
      const o = document.createElement('option'); o.value = id; o.textContent = p.name; ps.appendChild(o);
    }
    ps.value = S.paletteId;
    ps.addEventListener('change', () => {
      setPalette(ps.value, true);
      rebuildPixmap(); selectColor(S.color); changed(); refreshPanels();
      toast(`Switched to ${PALETTES[ps.value].name}`);
    });
    $('#paletteSearch').addEventListener('input', (e) => { S.search = e.target.value; renderSwatches(); });
    $$('#paletteFilter button').forEach((b) => b.addEventListener('click', () => {
      S.filter = b.dataset.filter;
      $$('#paletteFilter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderSwatches();
    }));
    $('#editOwned').addEventListener('change', (e) => {
      S.editOwned = e.target.checked;
      $('#ownAll').hidden = $('#ownNone').hidden = $('#ownedHint').hidden = !S.editOwned;
    });
    const saveOwned = () => store.set('pindou.owned.' + S.paletteId, [...S.owned]);
    $('#ownAll').addEventListener('click', () => { S.owned = new Set(S.palette.map((c) => c.code)); saveOwned(); renderSwatches(); });
    $('#ownNone').addEventListener('click', () => { S.owned.clear(); saveOwned(); renderSwatches(); });
    $('#swatches').addEventListener('click', (e) => {
      const b = e.target.closest('.sw'); if (!b) return;
      const c = S.palette[+b.dataset.i];
      if (S.editOwned) {
        if (S.owned.has(c.code)) S.owned.delete(c.code); else S.owned.add(c.code);
        saveOwned(); b.classList.toggle('unowned', !S.owned.has(c.code));
      } else {
        selectColor(c.i);
        if (S.tool === 'eraser' || S.tool === 'picker' || S.tool === 'pan') setTool('pencil');
      }
    });

    $$('#countSort button').forEach((b) => b.addEventListener('click', () => {
      S.sort = b.dataset.sort;
      $$('#countSort button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderCounts();
    }));

    // open file
    $('#openFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const missing = deserialize(JSON.parse(await f.text()));
        $('#projectName').value = S.name; $('#paletteSelect').value = S.paletteId;
        setTraySize(S.tray); selectColor(S.color); fitView(); refreshPanels(); autosave();
        toast(missing.length ? `Opened. Codes not in this palette were left empty: ${missing.join(', ')}` : `Opened ${S.name}`);
      } catch (err) { toast('Could not open: ' + err.message); }
    });

    // new dialog
    const nd = $('#newDialog');
    const fromTrays = () => { const t = +$('#newTray').value; $('#newW').value = (+$('#newAcross').value || 1) * t; $('#newH').value = (+$('#newDown').value || 1) * t; updateNewSummary(); };
    ['#newTray', '#newAcross', '#newDown'].forEach((s) => $(s).addEventListener('input', fromTrays));
    ['#newW', '#newH'].forEach((s) => $(s).addEventListener('input', updateNewSummary));
    nd.addEventListener('close', () => {
      if (nd.returnValue !== 'ok') return;
      const w = clamp(+$('#newW').value | 0, 1, MAX_DIM), h = clamp(+$('#newH').value | 0, 1, MAX_DIM);
      const keep = $('#newKeep').checked;
      const cells = new Int16Array(w * h).fill(-1);
      if (keep) for (let y = 0; y < Math.min(h, S.h); y++) for (let x = 0; x < Math.min(w, S.w); x++) cells[y * w + x] = S.cells[y * S.w + x];
      S.focus = null;
      setTraySize(+$('#newTray').value);
      replaceGrid({ w, h, cells }, keep ? `Resized to ${w}×${h}` : `New ${w}×${h} design (Undo brings back the old one)`);
      if (!keep) { S.name = 'Untitled'; $('#projectName').value = S.name; }
    });

    // image dialog
    const idlg = $('#imageDialog');
    $('#imgFile').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image();
      img.onload = () => {
        imgState.img = img; imgState.aspect = img.naturalWidth / img.naturalHeight;
        const w0 = Math.min(img.naturalWidth, S.tray);
        $('#imgW').value = w0; syncImgDims('w');
        if (+$('#imgH').value > MAX_DIM) { $('#imgH').value = MAX_DIM; syncImgDims('h'); }
        scheduleConvert();
      };
      img.onerror = () => toast('That file could not be read as an image');
      img.src = URL.createObjectURL(f);
    });
    $('#imgW').addEventListener('input', () => { syncImgDims('w'); scheduleConvert(); });
    $('#imgH').addEventListener('input', () => { syncImgDims('h'); scheduleConvert(); });
    ['#imgMax', '#imgOwned', '#imgDither', '#imgBg', '#imgClear', '#imgLock'].forEach((s) => $(s).addEventListener('change', scheduleConvert));
    $('#imgMax').addEventListener('input', scheduleConvert);
    idlg.addEventListener('close', () => {
      if (idlg.returnValue !== 'ok' || !imgState.result) return;
      S.focus = null;
      replaceGrid(imgState.result, 'Pattern created. Undo restores the previous design.');
    });

    // keyboard
    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea, dialog')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); download(safeName(S.name) + '.pindou.json', new Blob([JSON.stringify(serialize())], { type: 'application/json' })); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { if (!spaceDown) { spaceDown = true; viewport.classList.add('pan'); } e.preventDefault(); return; }
      const tools = { p: 'pencil', b: 'pencil', e: 'eraser', f: 'fill', g: 'fill', i: 'picker', r: 'replace', h: 'pan' };
      if (tools[k]) { setTool(tools[k]); return; }
      if (k === '+' || k === '=') zoomAt(1.25, vw / 2, vh / 2);
      else if (k === '-') zoomAt(0.8, vw / 2, vh / 2);
      else if (k === '0') fitView();
      else if (k === '[') stepTray(-1);
      else if (k === ']') stepTray(1);
      else if (k === 'escape' && S.focus) focusTray(null);
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; viewport.classList.toggle('pan', S.tool === 'pan'); } });

    new ResizeObserver(resizeCanvas).observe(viewport);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); rebuildPixmap(); refreshPanels(); requestDraw(); });
    window.addEventListener('afterprint', () => { $('#printRoot').innerHTML = ''; });
  }

  function savePrefs() { store.set('pindou.prefs', { guides: S.guides, showCodes: S.showCodes, round: S.round }); }

  // ---------- boot ----------
  function boot() {
    readTheme();
    const prefs = store.get('pindou.prefs', {});
    if (prefs.guides != null) S.guides = prefs.guides;
    if (prefs.showCodes != null) S.showCodes = prefs.showCodes;
    if (prefs.round != null) S.round = prefs.round;
    $('#guides').value = String(S.guides); $('#showCodes').checked = S.showCodes; $('#roundBeads').checked = S.round;

    setPalette(S.paletteId, false);
    bind();
    const saved = store.get('pindou.autosave', null);
    let restored = false;
    if (saved) { try { deserialize(saved); restored = true; } catch { /* ignore bad autosave */ } }
    if (!restored) rebuildPixmap();
    $('#projectName').value = S.name;
    $('#paletteSelect').value = S.paletteId;
    setTraySize(S.tray);
    const h7 = S.codeIndex.get('H7');
    selectColor(h7 != null ? h7 : 0);
    setTool('pencil');
    resizeCanvas();
    fitView();
    refreshPanels();
  }

  // Exposed for automated tests only.
  window.__pindou = { S, convert, serialize, deserialize, countRegion, undo, redo, imgState, runConvert };
  boot();
})();
