(() => {
  'use strict';

  // ---------- small helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }, // false: storage full or unavailable
  };
  const fmt = (n) => n.toLocaleString();
  // Messages. The toast is a popover so it sits in the browser's top layer, above
  // open dialogs, and role="status" makes screen readers announce it. Long messages
  // stay longer; { sticky: true } (warnings, errors) stays until dismissed.
  let toastTimer;
  // A modal dialog makes everything outside it inert (unclickable), so while one
  // is open the toast lives inside it, and moves back out when it closes.
  function moveToast(host) {
    const t = $('#toast');
    if (t.parentElement === host) return;
    const visible = !t.hidden;
    if (t.hidePopover) { try { t.hidePopover(); } catch { /* not open */ } }
    host.appendChild(t);
    if (visible) { if (t.showPopover) { try { t.showPopover(); } catch { /* unsupported */ } } t.hidden = false; }
  }
  function showDialog(dlg) {
    dlg.showModal();
    moveToast(dlg);
  }
  function toast(msg, opts = {}) {
    const t = $('#toast');
    moveToast(document.querySelector('dialog[open]') || document.body);
    $('#toastText').textContent = msg;
    $('#toastClose').hidden = !opts.sticky;
    if (t.showPopover) { try { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); } catch { t.hidden = false; } }
    t.hidden = false;
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(hideToast, clamp(2500 + msg.length * 45, 2500, 9000));
  }
  function hideToast() {
    const t = $('#toast');
    clearTimeout(toastTimer);
    if (t.hidePopover) { try { t.hidePopover(); } catch { /* not open */ } }
    t.hidden = true;
  }
  function download(name, blobOrUrl) {
    const a = document.createElement('a');
    const url = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const safeName = (s) => (s || 'pattern').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'pattern';

  const VERSION = '1.3.2'; // keep in sync with index.html (tools/bump-version.sh)
  const MAX_DIM = 624;
  // Printed on exports and sheets so people who see a pattern can find the app.
  const CREDIT = 'Made with Pindou Studio · dani-the-alien.github.io/pindou-studio';
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
    recent: [], // codes of recently picked colors, newest first
    editOwned: false,
    filter: 'all', search: '', sort: 'count', pview: 'family',
    undo: [], redo: [],
    stroke: null,
    hover: null,
  };

  // ---------- palette ----------
  function buildPalette(id) {
    return PALETTES[id].colors.map((c, i) => {
      const rgb = Color.hexToRgb(c.hex);
      const col = {
        i, code: c.code, hex: c.hex, rgb,
        lab: Color.rgbToLab(rgb[0], rgb[1], rgb[2]),
        ok: Color.rgbToOklch(rgb[0], rgb[1], rgb[2]),
        text: c.transparent ? '#333' : Color.contrastText(c.hex),
        transparent: !!c.transparent,
        series: c.code.match(/^[A-Z]+/)[0],
      };
      col.family = colorFamily(col);
      return col;
    });
  }

  // ---------- palette views (sorting / grouping) ----------
  // Family boundaries were tuned by eye against the MARD 291 set; colors right
  // on an edge (peach vs pink, olive vs yellow) are judgment calls either way.
  const FAMILIES = ['Whites, grays & blacks', 'Browns & tans', 'Reds', 'Oranges & peaches', 'Yellows', 'Greens', 'Teals & aquas', 'Blues', 'Purples', 'Pinks & magentas', 'Clear'];
  function colorFamily(c) {
    if (c.transparent) return 'Clear';
    const { L, C, H } = c.ok;
    if (C < 0.036 || (C < 0.045 && (L > 0.93 || L < 0.3))) return FAMILIES[0];
    if (H >= 20 && H < 95 && C < 0.135 && L < 0.52) return FAMILIES[1];
    if (H >= 58 && H < 108 && C < 0.08 && L < 0.88) return FAMILIES[1];
    if (H >= 20 && H < 58 && C < 0.05 && L < 0.82) return FAMILIES[1];
    if (H >= 330 || H < 12) return FAMILIES[9];
    if (H < 30) return L > 0.77 ? FAMILIES[9] : FAMILIES[2];
    if (H < 45) return L > 0.8 ? FAMILIES[3] : FAMILIES[2];
    if (H < 80) return FAMILIES[3];
    if (H < 120) return L < 0.65 ? FAMILIES[5] : FAMILIES[4];
    if (H < 170) return FAMILIES[5];
    if (H < 215) return FAMILIES[6];
    if (H < 285) return FAMILIES[7];
    return FAMILIES[8];
  }
  const hueKey = (c) => (c.ok.H - 12 + 360) % 360; // start the wheel at red rather than pink
  const isNeutral = (c) => c.family === FAMILIES[0] || c.transparent;
  const PALETTE_VIEWS = {
    series: { label: 'Series (code)', group: (c) => c.series, sort: (a, b) => a.i - b.i },
    family: {
      label: 'Color families', group: (c) => c.family,
      sort: (a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || b.ok.L - a.ok.L,
    },
    hue: {
      label: 'Hue (rainbow)', group: (c) => (isNeutral(c) ? 'Neutrals' : 'Colors'),
      // 15° hue bands, light → dark inside each band: the rainbow still flows,
      // without a pure hue sort's pale/dark/pale zig-zag.
      sort: (a, b) => isNeutral(a) - isNeutral(b)
        || (isNeutral(a) ? b.ok.L - a.ok.L : Math.floor(hueKey(a) / 15) - Math.floor(hueKey(b) / 15) || b.ok.L - a.ok.L),
    },
    value: { label: 'Value (light → dark)', group: () => null, sort: (a, b) => b.ok.L - a.ok.L },
    chroma: { label: 'Saturation (vivid → muted)', group: () => null, sort: (a, b) => b.ok.C - a.ok.C || b.ok.L - a.ok.L },
  };
  function sortedPalette(view) {
    return S.palette.slice().sort(PALETTE_VIEWS[view].sort);
  }
  // Make `id` the active palette. This does NOT touch the design: callers hand
  // applyState() cells that already refer to the new palette (see switchPalette).
  function setPalette(id) {
    const keep = S.palette[S.color] && S.palette[S.color].code;
    S.paletteId = id;
    S.palette = buildPalette(id);
    S.codeIndex = new Map(S.palette.map((c) => [c.code, c.i]));
    S.owned = new Set(store.get('pindou.owned.' + id, S.palette.map((c) => c.code)));
    S.color = keep && S.codeIndex.has(keep) ? S.codeIndex.get(keep) : 0;
    imgState.result = null; // a conversion made with the old palette must never be applied
    imgState.caches = new Map();
    cancelConvert();
  }
  // Switch palettes as one undoable step. Colors the new palette lacks are replaced
  // by their nearest match, after asking, since that changes the design.
  function switchPalette(id) {
    if (id === S.paletteId) return;
    const target = buildPalette(id);
    const index = new Map(target.map((c) => [c.code, c.i]));
    const solid = target.filter((c) => !c.transparent);
    const used = countRegion();
    const map = new Int16Array(S.palette.length);
    const lost = []; let lostBeads = 0;
    S.palette.forEach((c, i) => {
      if (index.has(c.code)) { map[i] = index.get(c.code); return; }
      let best = solid[0].i, bd = Infinity;
      for (const t of solid) { const d = Color.deltaE2000(c.lab, t.lab); if (d < bd) { bd = d; best = t.i; } }
      map[i] = best;
      if (used[i]) { lost.push(c.code); lostBeads += used[i]; }
    });
    const name = PALETTES[id].name;
    if (lost.length) saveBeforeDialog();
    if (lost.length && !confirm(`${name} doesn't have ${lost.length} of the colors in this design (${lost.slice(0, 12).join(', ')}${lost.length > 12 ? ', …' : ''}).\n\nSwitching replaces those ${fmt(lostBeads)} beads with the closest ${name} colors. You can undo it afterwards.`)) {
      $('#paletteSelect').value = S.paletteId;
      return;
    }
    if (!tab.editing) { $('#paletteSelect').value = S.paletteId; return; } // handed over while the confirm() was open
    const cells = S.cells.map((v) => (v < 0 ? -1 : map[v]));
    replaceState({ ...snapshot(), paletteId: id, cells },
      lost.length ? `Switched to ${name}: ${fmt(lostBeads)} beads changed to the closest colors. Undo switches back.` : `Switched to ${name}`);
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
    updateBelowCanvas();
    // Hidden (printing, a collapsed layout): keep the view as it is for when it's back.
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1;
    // When the canvas changes size (rotating, folding or unfolding, opening the bottom
    // sheet): a design (or focused tray) that was fully in view is fitted again;
    // otherwise the zoom stays and whatever was in the middle stays in the middle.
    let refit = false;
    if (vw > 0 && vh > 0) {
      const v = S.view, t = S.focus ? trayRect(S.focus.r, S.focus.c) : { x: 0, y: 0, w: S.w, h: S.h };
      const x0 = v.ox + t.x * v.scale, y0 = v.oy + t.y * v.scale, x1 = x0 + t.w * v.scale, y1 = y0 + t.h * v.scale;
      refit = x0 >= -1 && y0 >= -1 && x1 <= vw + 1 && y1 <= vh + 1;
      S.view.ox += (r.width - vw) / 2; S.view.oy += (r.height - vh) / 2;
    }
    vw = r.width; vh = r.height;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    if (refit) fitView(); else requestDraw();
  }
  // Messages on phones sit just above the controls at the bottom of the screen.
  let belowCanvas = -1;
  function updateBelowCanvas() {
    const bar = $('.workspace').classList.contains('sheet-open') ? null : $('.sheet-bar'), tb = $('.toolbar');
    const tops = [bar, tb].map((el) => el && el.getBoundingClientRect()).filter((r) => r && r.height).map((r) => r.top);
    const v = tops.length ? Math.max(0, Math.round(innerHeight - Math.min(...tops))) : 0;
    if (v !== belowCanvas) { belowCanvas = v; document.documentElement.style.setProperty('--below-canvas', v + 'px'); }
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
    // keyboard cursor: a thick outline with a light inner line, visible on any bead color
    if (cursorShown()) {
      const c = S.cursor, px = ox + c.x * s, py = oy + c.y * s;
      ctx.lineWidth = 3; ctx.strokeStyle = T.accent; ctx.strokeRect(px - 1.5, py - 1.5, s + 3, s + 3);
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
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
    const idx = [], olds = [];
    for (const [i, old] of st) if (S.cells[i] !== old) { idx.push(i); olds.push(old); }
    if (!idx.length) return;
    // Typed arrays keep a whole-board fill to ~8 bytes per bead in the undo history.
    const rec = { type: 'cells', idx: Int32Array.from(idx), old: Int16Array.from(olds), now: new Int16Array(idx.length) };
    for (let k = 0; k < idx.length; k++) rec.now[k] = S.cells[idx[k]];
    pushUndo(rec);
    changed();
  }
  function cancelStroke() {
    if (!S.stroke) return;
    for (const [i, old] of S.stroke) { S.cells[i] = old; writePix(i); }
    S.stroke = null; pixDirty = true; requestDraw();
    designChanged(); // a link made mid-stroke has beads that are now gone
  }
  // Everything Undo needs to restore a whole-design change (New, resize, Open, image import, palette switch).
  function snapshot() { return { paletteId: S.paletteId, tray: S.tray, name: S.name, w: S.w, h: S.h, cells: S.cells.slice() }; }
  const UNDO_STEPS = 200, UNDO_BYTES = 64 * 1024 * 1024;
  const recBytes = (r) => (r.type === 'cells' ? r.idx.length * 8 : (r.before.cells.length + r.after.cells.length) * 2);
  function pushUndo(rec) {
    S.undo.push(rec);
    S.redo.length = 0;
    let bytes = 0;
    for (const r of S.undo) bytes += recBytes(r);
    while (S.undo.length > 1 && (S.undo.length > UNDO_STEPS || bytes > UNDO_BYTES)) bytes -= recBytes(S.undo.shift());
    updateUndoButtons();
  }
  function applyRec(rec, back) {
    if (rec.type === 'cells') {
      const src = back ? rec.old : rec.now;
      for (let k = 0; k < rec.idx.length; k++) { S.cells[rec.idx[k]] = src[k]; writePix(rec.idx[k]); }
      pixDirty = true;
    } else {
      applyState(back ? rec.before : rec.after);
      refreshPanels();
    }
    changed();
  }
  function undo() { const r = S.undo.pop(); if (!r) return; applyRec(r, true); S.redo.push(r); updateUndoButtons(); }
  function redo() { const r = S.redo.pop(); if (!r) return; applyRec(r, false); S.undo.push(r); updateUndoButtons(); }
  function updateUndoButtons() {
    const u = $('[data-action=undo]'), r = $('[data-action=redo]');
    if (u) u.disabled = !S.undo.length;
    if (r) r.disabled = !S.redo.length;
  }

  function loadGrid(g) {
    const dimsChanged = g.w !== S.w || g.h !== S.h;
    S.w = g.w; S.h = g.h; S.cells = g.cells.slice();
    if (S.focus && (S.focus.r >= traysDown() || S.focus.c >= traysAcross())) S.focus = null;
    rebuildPixmap();
    if (dimsChanged) fitView();
  }
  // Restore a whole-design state, switching palette and tray size if it needs them.
  function applyState(st) {
    designChanged();
    if (st.paletteId && st.paletteId !== S.paletteId) {
      setPalette(st.paletteId);
      $('#paletteSelect').value = st.paletteId;
      selectColor(S.color);
    }
    if (st.tray && st.tray !== S.tray) { S.tray = st.tray; S.focus = null; syncTraySelect(); }
    if (typeof st.name === 'string' && st.name !== S.name) { S.name = st.name; $('#projectName').value = st.name; }
    loadGrid(st); // refits the view only if the size changed
  }
  function replaceState(next, label) {
    if (!tab.editing) return; // e.g. a file picker or confirm() that finished after another tab took over
    const before = snapshot();
    applyState(next);
    pushUndo({ type: 'snap', before, after: snapshot() });
    changed(); refreshPanels();
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
  function floodFill(start, v, rect) {
    const target = S.cells[start];
    if (target === v) return;
    const r = rect || { x: 0, y: 0, w: S.w, h: S.h };
    const xMin = r.x, yMin = r.y, xMax = r.x + r.w - 1, yMax = r.y + r.h - 1;
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      if (S.cells[i] !== target) continue;
      setCell(i, v);
      const x = i % S.w, y = (i / S.w) | 0;
      if (x > xMin) stack.push(i - 1);
      if (x < xMax) stack.push(i + 1);
      if (y > yMin) stack.push(i - S.w);
      if (y < yMax) stack.push(i + S.w);
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
  let keyboardFocus = null; // the element that last received focus from the keyboard

  function localPt(e) { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  viewport.addEventListener('contextmenu', (e) => e.preventDefault());
  viewport.addEventListener('pointerdown', (e) => {
    if (!tab.editing) return; // another tab is editing (or this one is still starting)
    const closingMenu = $('#fileActions').classList.contains('open');
    if (closingMenu) setMore(false); // this touch only closes the menu…
    viewport.setPointerCapture(e.pointerId);
    const p = localPt(e);
    pointers.set(e.pointerId, p);
    if (closingMenu && pointers.size === 1) { gesture = { kind: 'none' }; return; } // …but a second finger still makes it a pinch
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
    if ((S.tool === 'fill' || S.tool === 'replace') && !erase) {
      // Act when the finger or button lifts. If a second finger lands first, this was
      // the start of a pinch-zoom, so nothing changes.
      gesture = { kind: 'tap', tool: S.tool, cell, id: e.pointerId };
      return;
    }
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
  function runTapTool(g) {
    if (!tab.editing) return;
    beginStroke();
    if (g.tool === 'fill') floodFill(g.cell.i, S.color, S.focus ? trayRect(S.focus.r, S.focus.c) : null);
    else replaceAll(S.cells[g.cell.i], S.color);
    endStroke();
    requestDraw();
  }
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'tap') {
      const g = gesture; gesture = null;
      if (e.type === 'pointerup' && g.id === e.pointerId && pointers.size === 0) runTapTool(g);
      return;
    }
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
      S.view.ox -= e.shiftKey ? (e.deltaX || e.deltaY) : e.deltaX; // browsers report shift+wheel as deltaX or deltaY
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
    renderStatus();
  }
  function renderStatus() {
    const st = $('#status'), cell = S.hover;
    if (!cell || cell.i >= S.cells.length) { st.textContent = `Pindou Studio v${VERSION}`; return; }
    const r = Math.floor(cell.y / S.tray), c = Math.floor(cell.x / S.tray);
    const v = S.cells[cell.i];
    const bead = v >= 0 ? `${S.palette[v].code} ${S.palette[v].hex}${S.palette[v].transparent ? ' (clear)' : ''}` : 'empty';
    st.textContent = `x ${cell.x + 1}, y ${cell.y + 1} · ${trayName(r, c)} peg ${(cell.x % S.tray) + 1}, ${(cell.y % S.tray) + 1} · ${bead}`;
  }

  // ---------- drawing from the keyboard ----------
  // The canvas takes keyboard focus. Arrows move a cursor cell (Shift: 10 beads), Home/End
  // go to the ends of the row, Enter uses the current tool there and Delete/Backspace
  // erases; each is one undo step. A live region says where the cursor is. The cursor
  // only shows once a key is used on the canvas, so mouse and touch drawing look as before.
  let cursorOn = false;
  function cursorShown() {
    return cursorOn && S.cursor && document.activeElement === viewport && S.cursor.x < S.w && S.cursor.y < S.h;
  }
  function cursorBounds() {
    return S.focus ? trayRect(S.focus.r, S.focus.c) : { x: 0, y: 0, w: S.w, h: S.h };
  }
  function placeCursor(x, y) {
    const b = cursorBounds();
    S.cursor = { x: clamp(x, b.x, b.x + b.w - 1), y: clamp(y, b.y, b.y + b.h - 1) };
    keepCursorInView();
    requestDraw();
    announceCursor();
  }
  function keepCursorInView() {
    const s = S.view.scale, c = S.cursor, m = Math.min(s * 2, 40);
    const px = S.view.ox + c.x * s, py = S.view.oy + c.y * s;
    if (px < m) S.view.ox += m - px; else if (px + s > vw - m) S.view.ox -= px + s - (vw - m);
    if (py < m) S.view.oy += m - py; else if (py + s > vh - m) S.view.oy -= py + s - (vh - m);
  }
  function announceCursor(done) {
    const c = S.cursor; if (!c) return;
    const v = S.cells[c.y * S.w + c.x];
    const bead = v >= 0 ? S.palette[v].code : 'empty';
    const where = trayCount() > 1 ? `${trayName(Math.floor(c.y / S.tray), Math.floor(c.x / S.tray))}, ` : '';
    $('#canvasLive').textContent = `${done ? done + ' ' : ''}${where}column ${c.x + 1}, row ${c.y + 1}: ${bead}`;
  }
  function applyAtCursor(erase) {
    if (!tab.editing || !S.cursor) return;
    const cell = { x: S.cursor.x, y: S.cursor.y, i: S.cursor.y * S.w + S.cursor.x };
    if (S.focus && !inFocus(cell)) return;
    if (!erase && S.tool === 'pan') { $('#canvasLive').textContent = 'The pan tool is selected: press P for the pencil to draw.'; return; }
    if (!erase && S.tool === 'picker') {
      const v = S.cells[cell.i];
      if (v >= 0) { selectColor(v); setTool('pencil'); announceCursor(`Picked ${S.palette[v].code}.`); }
      return;
    }
    if (!erase && (S.tool === 'fill' || S.tool === 'replace')) {
      runTapTool({ tool: S.tool, cell });
      announceCursor(S.tool === 'fill' ? 'Filled.' : 'Swapped.');
      return;
    }
    const v = erase || S.tool === 'eraser' ? -1 : S.color;
    beginStroke(); setCell(cell.i, v); endStroke(); requestDraw();
    announceCursor(v < 0 ? 'Erased.' : 'Placed.');
  }
  function onCanvasKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const first = !cursorOn || !S.cursor;
    if (moves[e.key] || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      cursorOn = true;
      if (first) { const b = cursorBounds(); const c = S.cursor && S.cursor.x < S.w && S.cursor.y < S.h ? S.cursor : { x: b.x, y: b.y }; placeCursor(c.x, c.y); return; }
      const b = cursorBounds();
      if (e.key === 'Home') placeCursor(b.x, S.cursor.y);
      else if (e.key === 'End') placeCursor(b.x + b.w - 1, S.cursor.y);
      else placeCursor(S.cursor.x + moves[e.key][0], S.cursor.y + moves[e.key][1]);
      return;
    }
    if (cursorOn && S.cursor && (e.key === 'Enter' || e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      applyAtCursor(e.key !== 'Enter');
    }
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
    sw.setAttribute('aria-label', `Current color ${c.code}`);
    $$('#swatches .sw').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === i)));
    S.recent = [c.code, ...S.recent.filter((k) => k !== c.code)].slice(0, 8);
    renderQuick();
  }

  // ---------- quick colors (phone layouts) ----------
  // The current color, then a few recent picks, then the colors in the design (most
  // used first), so switching colors doesn't mean opening the full palette. One Tab
  // stop; arrow keys move along it.
  let quickCounts = null;
  function renderQuick(recount) {
    if (recount || !quickCounts || quickCounts.length !== S.palette.length) quickCounts = countRegion();
    const box = $('#quickColors'), had = box.contains(document.activeElement);
    keepFocus(box, 'data-q', buildQuick);
    if (had && !box.contains(document.activeElement)) { const cur = $('[data-q=current]', box); if (cur) cur.focus(); }
  }
  function quickSwatch(c, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw' + (c.transparent ? ' clear' : '') + (extra || '');
    b.style.background = c.hex; b.style.color = c.text;
    b.textContent = c.code;
    return b;
  }
  function buildQuick() {
    const box = $('#quickColors');
    box.innerHTML = '';
    const cur = S.palette[S.color];
    if (!cur) return;
    const cb = quickSwatch(cur, ' current');
    cb.dataset.q = 'current';
    cb.setAttribute('aria-label', sheetMode() ? `Current color ${cur.code}. Show all colors` : `Current color ${cur.code}`);
    cb.title = `${cur.code} ${cur.hex}`;
    box.appendChild(cb);
    const add = (i, label) => {
      const c = S.palette[i];
      const b = quickSwatch(c);
      b.dataset.q = String(i);
      b.setAttribute('aria-pressed', String(i === S.color));
      b.setAttribute('aria-label', `${c.code}${label}`);
      b.title = `${c.code} ${c.hex}`;
      box.appendChild(b);
    };
    const n = (i) => (quickCounts[i] ? `, ${fmt(quickCounts[i])} in design` : '');
    const recent = S.recent.map((k) => S.codeIndex.get(k)).filter((i) => i != null && i !== S.color).slice(0, 6);
    recent.forEach((i) => add(i, `, recently used${n(i)}`));
    const used = [];
    for (let i = 0; i < quickCounts.length; i++) if (quickCounts[i] && i !== S.color && !recent.includes(i)) used.push(i);
    used.sort((a, b) => quickCounts[b] - quickCounts[a]);
    if (recent.length && used.length) { const sep = document.createElement('span'); sep.className = 'quick-sep'; sep.setAttribute('aria-hidden', 'true'); box.appendChild(sep); }
    used.slice(0, 30).forEach((i) => add(i, n(i)));
    $$('button', box).forEach((b, k) => { b.tabIndex = k === 0 ? 0 : -1; });
    if (sheetMode()) { cb.setAttribute('aria-expanded', String($('#sidebar').classList.contains('expanded'))); cb.setAttribute('aria-controls', 'sidebar'); }
  }
  // Choose a color to draw with (palette, quick row, counts): drawing tools come back.
  function pickColor(i) {
    selectColor(i);
    if (S.tool === 'eraser' || S.tool === 'picker' || S.tool === 'pan') setTool('pencil');
  }
  const phoneMQ = matchMedia('(max-width: 599.98px)'), foldedMQ = matchMedia('(vertical-viewport-segments: 2), (horizontal-viewport-segments: 2)');
  // Is the sidebar a bottom sheet right now? (phones, except when folded at the hinge,
  // where it's always open). Checked separately: browsers that don't know the
  // segments feature would make a combined "not (...)" query false altogether.
  const sheetMode = () => phoneMQ.matches && !foldedMQ.matches;
  function setSheet(open) {
    const sb = $('#sidebar'), t = $('#sheetToggle');
    sb.classList.toggle('expanded', open);
    $('.workspace').classList.toggle('sheet-open', open);
    requestAnimationFrame(updateBelowCanvas);
    t.setAttribute('aria-expanded', String(open));
    t.setAttribute('aria-label', open ? 'Hide colors and panels' : 'Show all colors and panels');
    const cur = $('#quickColors [data-q=current]');
    if (cur) cur.setAttribute('aria-expanded', String(open));
  }
  function setMore(open, moveFocus) {
    const fa = $('#fileActions'), more = $('#moreBtn');
    if (!open && !fa.classList.contains('open')) return;
    fa.classList.toggle('open', open);
    more.setAttribute('aria-expanded', String(open));
    if (!open && !$('#exportMenu').hidden) closeMenu(false);
    if (moveFocus) (open ? fa.querySelector('button') : more).focus();
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
    if (sort === 'code') list.sort((a, b) => a.c.i - b.c.i);
    else if (sort === 'color') list.sort((a, b) => PALETTE_VIEWS.family.sort(a.c, b.c));
    else list.sort((a, b) => b.n - a.n || a.c.i - b.c.i);
    return list;
  }

  // ---------- panels ----------
  let panelTimer;
  function changed() {
    if (booted && tab.editing) { dirty = true; tab.everEdited = true; }
    designChanged();
    requestDraw();
    renderStatus();
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => { refreshPanels(); autosave(); }, 120);
  }
  function refreshPanels() {
    renderQuick(true);
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

  // Panels are rebuilt after edits; put keyboard focus back on the same item.
  function keepFocus(box, attr, rebuild) {
    const a = document.activeElement;
    const key = a && box.contains(a) ? a.getAttribute(attr) : null;
    rebuild();
    if (key != null) { const el = box.querySelector(`[${attr}="${key}"]`); if (el) el.focus(); }
  }
  function renderSwatches() { keepFocus($('#swatches'), 'data-i', buildSwatches); }
  function buildSwatches() {
    const box = $('#swatches');
    const counts = S.filter === 'used' ? countRegion() : null;
    const used = countRegion();
    const q = S.search.trim().toUpperCase();
    box.innerHTML = '';
    let group;
    const view = PALETTE_VIEWS[S.pview];
    const frag = document.createDocumentFragment();
    for (const c of sortedPalette(S.pview)) {
      if (q && !c.code.includes(q) && !c.hex.includes(q)) continue;
      if (S.filter === 'owned' && !S.owned.has(c.code)) continue;
      if (S.filter === 'used' && !counts[c.i]) continue;
      const cg = view.group(c);
      if (cg !== group) {
        group = cg;
        if (cg) { const g = document.createElement('div'); g.className = 'group-label'; g.textContent = cg; frag.appendChild(g); }
      }
      const b = document.createElement('button');
      b.className = 'sw' + (c.transparent ? ' clear' : '') + (S.owned.has(c.code) ? '' : ' unowned');
      b.style.background = c.hex; b.style.color = c.text;
      b.dataset.i = c.i;
      b.title = `${c.code} ${c.hex}${c.transparent ? ' (clear)' : ''}${used[c.i] ? ` · ${used[c.i]} in design` : ''}${S.owned.has(c.code) ? '' : ' · not in my collection'}`;
      if (S.editOwned) {
        b.setAttribute('aria-pressed', String(S.owned.has(c.code)));
        b.setAttribute('aria-label', `${c.code}, ${S.owned.has(c.code) ? 'in my collection' : 'not in my collection'}`);
      } else {
        b.setAttribute('aria-pressed', String(c.i === S.color));
      }
      b.textContent = c.code;
      if (used[c.i]) { const d = document.createElement('span'); d.className = 'used-dot'; b.appendChild(d); }
      frag.appendChild(b);
    }
    box.appendChild(frag);
    if (!box.children.length) box.innerHTML = '<p class="hint">No colors match.</p>';
  }

  function renderCounts() { keepFocus($('#countBody'), 'data-i', buildCounts); }
  function buildCounts() {
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
      tr.innerHTML = `<td><span class="swatch${c.transparent ? ' clear' : ''}" style="display:inline-block;vertical-align:middle;background:${c.hex}"></span></td><td><button type="button" class="code-btn" data-i="${c.i}" title="Use ${c.code}">${c.code}</button></td><td class="muted">${c.hex}</td><td class="n">${fmt(n)}</td><td class="n muted">${(n / total * 100).toFixed(1)}%</td>`;
      tr.addEventListener('click', () => { pickColor(c.i); if (sheetMode() && $('#sidebar').classList.contains('expanded')) setSheet(false); });
      body.appendChild(tr);
    }
    if (!list.length) body.innerHTML = '<tr><td class="muted">Nothing placed yet.</td></tr>';
  }

  function renderTrays() { keepFocus($('#trayGrid'), 'data-tray', buildTrays); }
  function buildTrays() {
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
      b.dataset.tray = `${r},${c}`;
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
      b.addEventListener('click', () => focusTray(r, c, true));
      grid.appendChild(b);
    }
  }

  function focusTray(r, c, fromPanel) {
    if (r == null) S.focus = null;
    else S.focus = { r, c };
    fitView();
    refreshPanels();
    if (fromPanel && sheetMode() && $('#sidebar').classList.contains('expanded')) {
      const hadFocus = $('#trayGrid').contains(document.activeElement);
      setSheet(false); // the canvas then grows and the tray is fitted again
      if (hadFocus) $('#sheetToggle').focus();
    }
  }
  function stepTray(d) {
    const across = traysAcross(), n = trayCount();
    const cur = S.focus ? S.focus.r * across + S.focus.c : (d > 0 ? -1 : n);
    const k = (cur + d + n) % n;
    focusTray(Math.floor(k / across), k % across);
  }

  // ---------- persistence ----------
  function serialize(from = S.cells) {
    const used = new Map(); const legend = [];
    const cells = new Array(from.length);
    for (let i = 0; i < from.length; i++) {
      const v = from[i];
      if (v < 0) { cells[i] = -1; continue; }
      if (!used.has(v)) { used.set(v, legend.length); legend.push(S.palette[v].code); }
      cells[i] = used.get(v);
    }
    return { format: 'pindou-studio', version: 1, name: S.name, palette: S.paletteId, tray: S.tray, w: S.w, h: S.h, legend, cells };
  }
  // Check a project file completely and turn it into a design state, without
  // changing anything. Throws a readable error for anything malformed.
  function parseProject(d) {
    if (!d || typeof d !== 'object' || d.format !== 'pindou-studio') throw new Error("it isn't a Pindou Studio project file");
    const { w, h } = d;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) throw new Error('its size is invalid');
    if (!Array.isArray(d.cells) || d.cells.length !== w * h) throw new Error("its beads don't match its size");
    if (!Array.isArray(d.legend) || !d.legend.every((c) => typeof c === 'string')) throw new Error('its color list is missing or invalid');
    const paletteId = Object.prototype.hasOwnProperty.call(PALETTES, d.palette) ? d.palette : S.paletteId;
    const pal = paletteId === S.paletteId ? S.palette : buildPalette(paletteId);
    const index = new Map(pal.map((c) => [c.code, c.i]));
    const map = d.legend.map((code) => (index.has(code) ? index.get(code) : -1));
    const missing = [...new Set(d.legend.filter((code) => !index.has(code)))];
    const cells = new Int16Array(w * h);
    for (let i = 0; i < cells.length; i++) {
      const v = d.cells[i];
      cells[i] = Number.isInteger(v) && v >= 0 && v < map.length ? map[v] : -1;
    }
    const tray = Number.isInteger(d.tray) ? clamp(d.tray, 5, 300) : 52;
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.slice(0, 200) : 'Untitled';
    return { state: { paletteId, tray, w, h, cells }, name, missing };
  }
  function listCodes(codes) {
    return codes.length <= 20 ? codes.join(', ') : `${codes.slice(0, 20).join(', ')} and ${codes.length - 20} more`;
  }
  // Load without an undo step (restoring the autosave at startup).
  function loadProject(d) {
    const { state, name, missing } = parseProject(d);
    S.focus = null;
    applyState(state);
    S.name = name;
    changed();
    return missing;
  }
  function saveProject() {
    download(safeName(S.name) + '.pindou.json', new Blob([JSON.stringify(serialize())], { type: 'application/json' }));
  }

  // ---------- sharing a design as a link ----------
  // The design rides in the address's #fragment, which browsers never send to a server.
  // Inside (deflated, then base64url): a format number, name, palette, tray size, width,
  // height, the legend's color codes, then one number per bead (0 = empty, otherwise
  // 1 + its place in the legend), all as unsigned varints / length-prefixed UTF-8.
  // A link is untrusted input like a file: it ends up in parseProject().
  const LINK_KEY = 'pattern=', LINK_FORMAT = 1;
  const LINK_MAX = 32000;  // longest link offered; past this, "save the file"
  const LINK_LONG = 2000;  // past this, warn that some chat apps cut links short
  const LINK_UNPACKED_MAX = 2 * 1024 * 1024; // decompression stops here (624² beads need < 1 MB)
  // Older browsers (Safari < 16.4, Firefox < 113, Chrome < 103) can't (de)compress this way.
  const linkCodec = (() => {
    try { new CompressionStream('deflate-raw'); new DecompressionStream('deflate-raw'); return true; } catch { return false; }
  })();
  async function packDesign(d) {
    const out = [];
    const num = (v) => { do { const b = v % 128; v = Math.floor(v / 128); out.push(v ? b | 128 : b); } while (v); };
    const str = (s) => { const u = new TextEncoder().encode(s); num(u.length); for (const b of u) out.push(b); };
    num(LINK_FORMAT); str(d.name); str(d.palette); num(d.tray); num(d.w); num(d.h);
    num(d.legend.length); d.legend.forEach(str);
    for (const v of d.cells) num(v + 1);
    const zipped = new Uint8Array(await new Response(new Blob([new Uint8Array(out)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = '';
    for (let i = 0; i < zipped.length; i += 0x8000) bin += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function unpackDesign(text) {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('the link is incomplete or has been changed');
    let zipped;
    try { zipped = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); }
    catch { throw new Error('the link is incomplete or has been changed'); }
    // Unzip a piece at a time, and stop if it grows past anything a real design needs.
    const reader = new Blob([zipped]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = []; let size = 0, tooBig = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > LINK_UNPACKED_MAX) { tooBig = true; reader.cancel().catch(() => {}); break; }
        parts.push(value);
      }
    } catch { throw new Error('the link is incomplete or has been changed'); }
    if (tooBig) throw new Error('it holds far more than any design could');
    const buf = new Uint8Array(size); let at = 0;
    for (const p of parts) { buf.set(p, at); at += p.length; }
    let i = 0;
    const bad = () => new Error('the link is incomplete or has been changed');
    const num = () => {
      let v = 0, mul = 1, b;
      do {
        if (i >= buf.length || mul > 2 ** 28) throw bad();
        b = buf[i++]; v += (b & 127) * mul; mul *= 128;
      } while (b & 128);
      return v;
    };
    const str = () => {
      const n = num();
      if (n > buf.length - i) throw bad();
      const s = new TextDecoder().decode(buf.subarray(i, i + n)); i += n;
      return s;
    };
    const format = num();
    if (format !== LINK_FORMAT) throw Object.assign(new Error('it was made by a newer version of Pindou Studio. Reload this page to get the newest version (Ctrl+Shift+R, or ⌘⇧R); the link is still in the address bar'), { keepLink: true });
    const name = str(), palette = str(), tray = num(), w = num(), h = num();
    if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) throw new Error('its size is invalid');
    const count = num();
    if (count > buf.length - i) throw bad();
    const legend = [];
    for (let k = 0; k < count; k++) legend.push(str());
    const cells = new Array(w * h);
    for (let k = 0; k < cells.length; k++) cells[k] = num() - 1;
    if (i !== buf.length) throw bad();
    return parseProject({ format: 'pindou-studio', version: 1, name, palette, tray, w, h, legend, cells });
  }
  function linkInAddress() {
    const h = location.hash;
    return h.startsWith('#' + LINK_KEY) ? h.slice(1 + LINK_KEY.length) : null;
  }
  // The address switch writes this tab's own design into the address. That copy can be
  // a moment behind the autosave (and "Duplicate tab" copies it), so it's remembered and
  // never treated as a link someone gave us: the autosave is newer.
  const OWN_LINK_KEY = 'pindou.linkLive.hash';
  function ownLink() { try { return sessionStorage.getItem(OWN_LINK_KEY); } catch { return null; } }
  function setOwnLink(v) { try { if (v) sessionStorage.setItem(OWN_LINK_KEY, v); else sessionStorage.removeItem(OWN_LINK_KEY); } catch { /* not kept */ } }
  function incomingLink() {
    const data = linkInAddress();
    return data != null && data !== ownLink() ? data : null;
  }
  // Where links (and QR codes) for other people point: this address, unless it only works
  // on this computer (a local copy or the desktop install), then the public site.
  const PUBLIC_URL = 'https://dani-the-alien.github.io/pindou-studio/';
  // Addresses that only work on this computer: localhost (and *.localhost), 0.0.0.0 (as
  // python -m http.server prints it), 127.x.x.x, ::1 and its IPv4-mapped form, [::] (as servers listening on all addresses print it), file:.
  function isLocalAddress(host, protocol) {
    return protocol === 'file:'
      || /^(localhost\.?|.*\.localhost\.?|0\.0\.0\.0|\[::\]|127(\.\d+){3}|\[::1\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i.test(host);
  }
  function shareBase() {
    return isLocalAddress(location.hostname, location.protocol) ? PUBLIC_URL : location.href.split('#')[0];
  }
  // A link to the current design for others, kept ready for exports (the browser's own
  // Ctrl+P prints at once, while making a link takes a moment). null if it can't be made.
  let designRev = 0, linkWarmTimer = null;
  const linkCache = { rev: -1, url: null, pendingRev: -1, pending: null };
  function currentLink() {
    const rev = designRev;
    if (linkCache.rev === rev) return Promise.resolve(linkCache.url);
    if (linkCache.pendingRev === rev) return linkCache.pending;
    const d = serialize();
    linkCache.pendingRev = S.stroke ? -1 : rev;
    const midStroke = !!S.stroke; // not kept: the stroke may yet be cancelled
    linkCache.pending = packDesign(d).then((p) => shareBase() + '#' + LINK_KEY + p, () => null).then((url) => {
      if (designRev === rev && !midStroke) { linkCache.rev = rev; linkCache.url = url; }
      return url;
    });
    return linkCache.pending;
  }
  function freshLink() { return linkCache.rev === designRev ? linkCache.url : undefined; } // undefined: not ready
  function designChanged() {
    designRev++;
    if (S.qrExport) { clearTimeout(linkWarmTimer); linkWarmTimer = setTimeout(currentLink, 700); }
  }

  // ---------- QR codes ----------
  // Encoded by js/qrcodegen.js (Project Nayuki, MIT). A QR code holds at most ~2,950
  // bytes, so longer links get none.
  function makeQr(url) {
    if (!url || typeof qrcodegen === 'undefined') return null;
    try { return qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.LOW); } catch { return null; }
  }
  // Black on white with the standard 4-module quiet zone, `px` pixels per module.
  function qrCanvas(qr, px) {
    const n = qr.size + 8, c = document.createElement('canvas');
    c.width = c.height = n * px;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) g.fillRect((x + 4) * px, (y + 4) * px, px, px);
    return c;
  }
  const QR_MAX_NOTE = 'QR codes hold links up to about 2,900 characters';
  function clearLinkFromAddress() { history.replaceState(history.state, '', location.pathname + location.search); }

  // What the Share dialog is offering: the design as it is, and (for long links) a
  // simpler version with fewer colors and/or no stray single beads.
  const share = { orig: null, simple: null, seq: 0, timer: null };
  const linkFor = async (cells) => shareBase() + '#' + LINK_KEY + await packDesign(serialize(cells));
  async function shareLink() {
    if (!tab.editing) return;
    let url;
    try { url = await linkFor(S.cells); }
    catch { toast("This browser can't make pattern links. Use Save and share the file instead.", { sticky: true }); return; }
    if (!tab.editing) return;
    share.orig = url; share.simple = null; share.dropped = null; share.dist = null; share.busy = false; share.failed = false; share.seq++;
    $('#linkText').value = ''; // so the first showLinkChoice() below fills everything in
    const long = url.length > LINK_LONG;
    $('#linkSimpler').hidden = !long;
    $('#linkLive').checked = linkLive;
    $('#linkLiveRow').hidden = !linkCodec;
    if (long) {
      const tooLong = url.length > LINK_MAX;
      $('#linkWhyText').textContent = tooLong
        ? `This design is too detailed for a link (${url.length.toLocaleString()} characters; links hold up to ${LINK_MAX.toLocaleString()}). A simpler version can fit, or use Save and share the file.`
        : `This link is long (${url.length.toLocaleString()} characters): some chat apps and forms cut long links short, and QR codes hold up to about 2,900. A simpler version makes a shorter link.`;
      $('#linkWhichOrig').disabled = tooLong;
      $('#linkOrigLen').textContent = tooLong ? '(too long for a link)' : `(${url.length.toLocaleString()} characters)`;
      $('#linkSimpleLen').textContent = '(working it out…)';
      (tooLong ? $('#linkWhichSimple') : $('#linkWhichOrig')).checked = true;
      const n = solidCounts(S.cells).size;
      $('#linkColors').max = String(Math.max(2, n)); $('#linkColors').value = String(Math.max(2, n));
      share.busy = true; showColorsValue();
      $('#linkClean').checked = true;
      drawBeads($('#linkPrevA'), S.cells, S.w, S.h);
    }
    showLinkChoice();
    showDialog($('#linkDialog'));
    if (long) suggestSimpler();
    $('#linkText').select();
  }
  // "Keep this design's link in the address bar": then the browser's own bookmark
  // (Ctrl+D, the star) saves the design, since pages can't add bookmarks themselves.
  // Per tab (sessionStorage), so it lasts through a reload of that tab only.
  let linkLive = (() => { try { return sessionStorage.getItem('pindou.linkLive') === '1'; } catch { return false; } })();
  let addressTimer = null, addressSeq = 0;
  function setLinkLive(on) {
    linkLive = on;
    try { if (on) sessionStorage.setItem('pindou.linkLive', '1'); else sessionStorage.removeItem('pindou.linkLive'); } catch { /* not kept past a reload */ }
    clearTimeout(addressTimer); addressSeq++;
    if (on) syncAddress();
    else { if (linkInAddress() != null && linkInAddress() === ownLink()) clearLinkFromAddress(); setOwnLink(null); }
  }
  function scheduleAddressSync() {
    if (!linkLive) return;
    clearTimeout(addressTimer);
    addressTimer = setTimeout(syncAddress, 600);
  }
  async function syncAddress() {
    if (!linkLive || !tab.editing || linkBusy) return;
    const seq = ++addressSeq;
    let url;
    try { url = location.href.split('#')[0] + '#' + LINK_KEY + await packDesign(serialize()); } catch { return; }
    // a newer change, things moved on, or a link just arrived (its hashchange is on the way)
    if (seq !== addressSeq || !linkLive || !tab.editing || linkBusy || incomingLink() != null) return;
    if (url.length > LINK_MAX) {
      setLinkLive(false);
      toast('This design is now too detailed for a link, so "Keep this design\'s link in the address bar" is off. Use Save to keep it as a file.', { sticky: true });
      return;
    }
    setOwnLink(url.slice(url.indexOf('#') + 1 + LINK_KEY.length));
    if (location.href !== url) history.replaceState(history.state, '', url);
  }
  // This tab stopped editing: its address would be an old copy, so take the design out.
  function dropLiveAddress() {
    clearTimeout(addressTimer); addressSeq++;
    const own = ownLink();
    if (own != null && linkInAddress() === own) clearLinkFromAddress();
    setOwnLink(null); // from now on, any link in this tab's address is one it was given
  }
  function sameAsCurrent(state, name) {
    if (state.w !== S.w || state.h !== S.h || state.paletteId !== S.paletteId || state.tray !== S.tray || name !== S.name) return false;
    for (let i = 0; i < state.cells.length; i++) if (state.cells[i] !== S.cells[i]) return false;
    return true;
  }
  // Show whichever link is chosen in the dialog (Copy, Share… and the QR code use it).
  function showLinkChoice() {
    const simple = !$('#linkSimpler').hidden && $('#linkWhichSimple').checked;
    $('#linkSimpleCtl').hidden = !simple;
    const url = simple ? (share.simple && share.simple.url) : share.orig;
    const ok = !!url && url.length <= LINK_MAX;
    $('#linkApply').disabled = !(simple && share.simple && !share.busy);
    if (ok && url === $('#linkText').value) return; // same link: leave Copied ✓ and an open QR alone
    $('#linkText').value = ok ? url : '';
    $('#linkCopy').disabled = !ok;
    $('#linkHint').textContent = !ok
      ? (!simple ? ''
        : share.failed ? "Couldn't make a simpler version here. Use Save and share the file instead."
          : share.simple ? 'Still too long for a link: try fewer colors, or use Save and share the file.'
            : 'Working out a simpler version…')
      : url.length > LINK_LONG
        ? `This link is long (${url.length.toLocaleString()} characters). Some chat apps and forms cut long links short; if it arrives broken, use Save and send the file instead.`
        : `${url.length.toLocaleString()} characters.`;
    $('#linkShare').hidden = !ok || !(navigator.share && (!navigator.canShare || navigator.canShare({ url })));
    $('#linkCopyLabel').textContent = 'Copy link';
    const canQr = ok && !!makeQr(url);
    $('#linkQrBox').hidden = true; $('#linkQrBox').replaceChildren();
    $('#linkQrBtn').disabled = !canQr;
    $('#linkQrBtn').textContent = !ok || canQr ? 'Show QR code' : 'Too long for a QR code';
    $('#linkQrBtn').title = canQr ? 'Show this link as a QR code to scan with a phone' : QR_MAX_NOTE;
  }
  // One bead per pixel, scaled up by CSS.
  function drawBeads(cv, cells, w, h) {
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = cells[i], o = i * 4;
      const rgb = v >= 0 ? (S.palette[v].transparent ? TRANSPARENT_RGB : S.palette[v].rgb) : (((i % w) + ((i / w) | 0)) & 1 ? [221, 221, 221] : [238, 238, 238]);
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  // A simpler copy of a design: at most `max` colors (merging the ones that cost least to
  // lose, as image conversion does, then moving each dropped color to its nearest kept
  // one), and optionally without stray single beads.
  // Clear (transparent) beads are left as they are: they look like white on screen, but
  // swapping clear plastic for white (or back) changes the piece.
  function solidCounts(cells) {
    const counts = new Map();
    for (const v of cells) if (v >= 0 && !S.palette[v].transparent) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  }
  function simplifyCells(cells, w, h, max, clean, dropped, dist) {
    let out = Int16Array.from(cells);
    const counts = solidCounts(out);
    if (counts.size > max) {
      const gone = new Set((dropped || mergeOrder(counts)).slice(0, counts.size - max));
      const kept = [...counts.keys()].filter((v) => !gone.has(v));
      const d = dist || ((a, b) => Color.deltaE2000(S.palette[a].lab, S.palette[b].lab));
      const to = new Map();
      for (const v of counts.keys()) {
        if (!gone.has(v)) { to.set(v, v); continue; }
        let best = Infinity, into = v;
        for (const k of kept) { const e = d(v, k); if (e < best) { best = e; into = k; } }
        to.set(v, into);
      }
      for (let i = 0; i < out.length; i++) if (to.has(out[i])) out[i] = to.get(out[i]);
    }
    if (clean) out = removeStrays(out, w, h);
    return out;
  }
  // A bead (or empty spot) unlike all of its up-to-8 neighbors takes their most common value.
  function removeStrays(cells, w, h) {
    const out = Int16Array.from(cells);
    const vals = new Int16Array(8), ns = new Uint8Array(8); // up to 8 neighbors: no Map per bead
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = cells[i];
      let kinds = 0, same = false;
      for (let dy = -1; dy <= 1 && !same; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const u = cells[ny * w + nx];
        if (u === v) { same = true; break; }
        let k = 0;
        while (k < kinds && vals[k] !== u) k++;
        if (k === kinds) { vals[k] = u; ns[k] = 0; kinds++; }
        ns[k]++;
      }
      if (same || !kinds) continue;
      let best = 0;
      for (let k = 1; k < kinds; k++) if (ns[k] > ns[best]) best = k;
      out[i] = vals[best];
    }
    return out;
  }
  function mergeOrder(counts) { const d = []; reduceColors(counts, 1, d); return d; }
  async function makeSimpler(max, clean) {
    if (!share.dropped) {
      const counts = solidCounts(S.cells);
      share.dropped = mergeOrder(counts);
      // distances between the design's colors, worked out once for every try
      const memo = new Map();
      share.dist = (a, b) => { const key = a * 1024 + b; let e = memo.get(key); if (e === undefined) { e = Color.deltaE2000(S.palette[a].lab, S.palette[b].lab); memo.set(key, e); } return e; };
    }
    const cells = simplifyCells(S.cells, S.w, S.h, max, clean, share.dropped, share.dist);
    return { cells, max, clean, url: await linkFor(cells), colors: new Set(cells.filter((v) => v >= 0)).size };
  }
  const breathe = () => new Promise((r) => setTimeout(r, 0)); // let the page draw between tries
  // The color counts tried for a suggestion, most first.
  function simplerTries(n) {
    const tries = new Set([n]);
    for (let k = n; k > 8; k = Math.floor(k * 0.75)) tries.add(k);
    for (let k = Math.min(n, 8); k >= 2; k--) tries.add(k);
    return [...tries].sort((a, b) => b - a);
  }
  // On opening: the most colors that still give a link under LINK_LONG (with clean-up on).
  // Fewer colors doesn't always mean a shorter link (merging can make more ragged edges),
  // so a spread of counts is tried, most colors first; if none fits, the shortest is offered.
  async function suggestSimpler() {
    const seq = share.seq;
    const n = +$('#linkColors').max;
    let best = null, shortest = null;
    share.busy = true;
    try {
      for (const k of simplerTries(n)) {
        await breathe();
        if (seq !== share.seq) return;
        const r = await makeSimpler(k, true);
        if (seq !== share.seq) return;
        if (!shortest || r.url.length < shortest.url.length) shortest = r;
        if (r.url.length <= LINK_LONG) { best = r; break; }
      }
    } catch {
      if (seq === share.seq) { share.busy = false; share.failed = true; $('#linkSimpleLen').textContent = "(couldn't make one)"; showLinkChoice(); }
      return;
    }
    share.busy = false;
    best = best || shortest;
    if (seq !== share.seq || !tab.editing) return;
    $('#linkColors').value = String(best.max);
    showSimpler(best);
  }
  function showColorsValue() {
    const v = $('#linkColors').value;
    $('#linkColorsOut').textContent = v;
    $('#linkColors').setAttribute('aria-valuetext', `at most ${v} colors`);
  }
  function showSimpler(r) {
    share.simple = r; share.busy = false;
    showColorsValue();
    const used = `${r.colors} color${r.colors === 1 ? '' : 's'}`;
    $('#linkSimpleLen').textContent = r.url.length > LINK_MAX ? `(${used}; still too long for a link)` : `(${used}, ${r.url.length.toLocaleString()} characters)`;
    drawBeads($('#linkPrevB'), r.cells, S.w, S.h);
    showLinkChoice();
  }
  function onSimplerControls() {
    clearTimeout(share.timer);
    const seq = ++share.seq;
    showColorsValue();
    // the version on show no longer matches the controls: nothing may copy or apply it
    share.simple = null; share.busy = true; share.failed = false;
    $('#linkSimpleLen').textContent = '(working it out…)';
    showLinkChoice();
    share.timer = setTimeout(async () => {
      let r;
      try { r = await makeSimpler(+$('#linkColors').value, $('#linkClean').checked); }
      catch { if (seq === share.seq) { share.busy = false; share.failed = true; showLinkChoice(); } return; }
      if (seq === share.seq && tab.editing && $('#linkDialog').open) showSimpler(r);
    }, 120);
  }
  function applySimpler() {
    const r = share.simple;
    // only the version that matches the controls as they are now
    if (!r || share.busy || !tab.editing || r.max !== +$('#linkColors').value || r.clean !== $('#linkClean').checked) return;
    S.focus = null;
    replaceState({ paletteId: S.paletteId, tray: S.tray, name: S.name, w: S.w, h: S.h, cells: r.cells }, 'Your design now uses the simpler version. Undo brings back the original.');
    autosave();
    $('#linkDialog').close();
    shareLink(); // the design as it is now is the simpler one
  }
  function toggleLinkQr() {
    const box = $('#linkQrBox');
    if (!box.hidden) { box.hidden = true; box.replaceChildren(); $('#linkQrBtn').textContent = 'Show QR code'; return; }
    const qr = makeQr($('#linkText').value);
    if (!qr) return;
    box.hidden = false;
    // Every module the same whole number of screen pixels: a stretched code scans badly.
    const dpr = window.devicePixelRatio || 1, n = qr.size + 8;
    const room = Math.min(480, box.clientWidth || 340);
    const k = Math.max(1, Math.floor(room * dpr / n));
    const c = qrCanvas(qr, k);
    c.style.width = c.style.height = `${(n * k) / dpr}px`;
    c.className = 'qr'; c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'QR code of the link');
    const note = document.createElement('p'); note.className = 'hint'; note.textContent = 'Scan it with a phone camera to open this design in Pindou Studio.';
    box.replaceChildren(c, note);
    $('#linkQrBtn').textContent = 'Hide QR code';
  }
  async function copyLink() {
    const input = $('#linkText');
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch {
      input.focus(); input.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    if (ok) { $('#linkCopyLabel').textContent = 'Copied ✓'; toast('Link copied.'); }
    else { input.focus(); input.select(); toast('Copying was blocked here: the link is selected, so copy it with Ctrl+C (⌘C), or long-press it.'); }
  }

  // Open the pattern in the address, if there is one. Waits while this tab is paused
  // (becomeEditor calls this again), and asks before replacing a design with beads in it.
  let linkBusy = false, linkAgain = false, linkAsking = null;
  async function openLinkFromAddress() {
    if (linkBusy) { linkAgain = true; return; }
    const data = incomingLink();
    if (data == null) { scheduleAddressSync(); return; } // nothing given, or this tab's own copy
    if (!tab.editing) return;
    if (!linkCodec) {
      // keep the link in the address, so it can be copied into another browser
      toast("This browser is too old to open pattern links. The link is still in the address bar: open it in an up-to-date browser (or ask for the saved file instead).", { sticky: true });
      return;
    }
    linkBusy = true;
    try {
      let parsed;
      try { parsed = await unpackDesign(data); }
      catch (err) {
        if (!err.keepLink) clearLinkFromAddress();
        toast(`Couldn't open the pattern in this link: ${err.message}. Your design wasn't changed.`, { sticky: true });
        return;
      }
      if (!tab.editing) return; // editing moved away while unpacking: the link waits for it to come back
      if (incomingLink() !== data) return; // another link arrived meanwhile: that one is next
      const { state, name, missing } = parsed;
      if (sameAsCurrent(state, name)) { clearLinkFromAddress(); return; } // already open here
      // dialogs open from before (Share would show the old design's link) go first
      $$('dialog[open]').forEach((d) => { if (d.id !== 'tabDialog' && d.id !== 'linkOpenDialog') d.close('cancel'); });
      const hadBeads = S.cells.some((v) => v >= 0);
      let choice = 'open';
      if (hadBeads) {
        const used = new Set(); let beads = 0;
        for (const v of state.cells) if (v >= 0) { used.add(v); beads++; }
        $('#linkOpenText').textContent = `“${name}”: ${state.w} × ${state.h}, ${beads.toLocaleString()} bead${beads === 1 ? '' : 's'} in ${used.size} color${used.size === 1 ? '' : 's'}.`;
        linkAsking = data;
        choice = await new Promise((done) => {
          const d = $('#linkOpenDialog');
          d.returnValue = '';
          d.addEventListener('close', () => done(d.returnValue), { once: true });
          saveBeforeDialog();
          showDialog(d);
        });
      }
      if (!tab.editing) return; // editing moved away meanwhile: the link waits for it to come back
      if (incomingLink() !== data) return; // a newer link replaced this one while asking
      clearLinkFromAddress(); // with the switch on, the address is set again from the design below
      if (choice !== 'open' && choice !== 'save-open') { toast('Kept your design. The shared pattern was not opened.'); return; }
      if (choice === 'save-open') saveProject();
      S.focus = null;
      const undoNote = hadBeads ? ' Undo brings back your previous design.' : '';
      replaceState({ ...state, name }, missing.length ? null : `Opened “${name}” from a link.${undoNote}`);
      if (missing.length) {
        toast(`Opened “${name}” from a link, but ${missing.length} color code${missing.length > 1 ? 's' : ''} aren't in ${PALETTES[state.paletteId].name} and were left empty: ${listCodes(missing)}.${undoNote}`, { sticky: true });
      }
      autosave();
    } finally {
      linkBusy = false; linkAsking = null;
      if (linkAgain) { linkAgain = false; openLinkFromAddress(); } else scheduleAddressSync();
    }
  }
  let saveTimer;
  // Only a tab that changed something writes the autosave: otherwise closing an
  // untouched second tab would overwrite work saved by the tab that was used.
  let dirty = false, booted = false;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushAutosave, 300);
  }
  // A blocking dialog (confirm, prompt, print) can end with the tab being closed
  // without the usual pagehide save, so save first.
  function saveBeforeDialog() { if (tab.state === 'editing') saveNow(); }
  function flushAutosave() {
    clearTimeout(saveTimer);
    if (!dirty || !tab.editing) return;
    saveNow();
  }

  // ---------- one editing tab at a time ----------
  // All tabs share one autosave. The rule: the tab holding the "editor" Web Lock is
  // the only one that changes the design or writes the autosave, and it always does.
  // Every other tab shows a notice that can't be dismissed.
  //
  // Editing only ever moves by hand-over, never by taking the lock away: the paused
  // tab asks; the editing tab stops, saves, sends its design over the BroadcastChannel
  // and lets go. If the editing tab can't answer (a dialog is open in it, or it's
  // frozen), the paused tab waits and says so; it takes over as soon as the other
  // tab answers or is closed. So a live editing tab always saves before editing
  // moves; what a crash or a killed tab hadn't saved yet (at most the last moment,
  // and nothing from before a dialog opened) can't be recovered.
  //
  // Each editor gets a new generation number, stored next to the autosave; when
  // taking over, copies (from storage or by message) are ranked by generation. While
  // a tab is asking, the other paused tabs step out of the queue, so the lock goes to
  // the tab that asked. Only visible paused tabs wait in line, so reloading doesn't
  // hand editing to a background tab. Without Web Locks (very old browsers) every tab
  // edits, as before.
  const LOCK = 'pindou.editor', GEN_KEY = 'pindou.gen', SLOW_ANSWER = 3000, PAYLOAD_WAIT = 400;
  const tab = {
    editing: true,   // may this tab change the design and write the autosave?
    state: 'off',    // off (no Web Locks) | starting | editing | paused | taking | syncing
    id: Math.random().toString(36).slice(2),
    chan: null, token: 0, current: 0, release: null, waiting: null,
    slowTimer: null, payload: null, payloadTimer: null, payloadWaiter: null,
    gen: 0, blocked: false, everEdited: false, waitedAtStart: false, ready: null, lastSync: null, saveFailed: false,
    cancelled: new Set(), asideTimer: null,
  };
  const genOf = (a) => (a && Number.isInteger(a.gen) ? a.gen : 0);
  // The newer of two saved copies: higher generation wins; on a tie the copy that was
  // sent by message (the editor's final state) wins over storage.
  const newest = (stored, sent) => (!sent ? stored : !stored ? sent : genOf(sent) >= genOf(stored) ? sent : stored);
  function lockRequest(opts, onAnswer) {
    const token = ++tab.token;
    let answered = false;
    navigator.locks.request(LOCK, opts, (lock) => {
      answered = true;
      if (onAnswer) onAnswer(!!lock);
      if (!lock) return null;
      return new Promise((release) => { tab.current = token; tab.release = release; onLockGained(); });
    }).catch(() => {
      if (tab.current === token) onLockLost(); // nothing in this app steals, but never edit without the lock
      else if (!answered && !opts.signal) noLocking(); // the browser refused Web Locks
      // otherwise: our own queued wait was cancelled
    });
  }
  // Web Locks only exist on secure addresses (https, localhost, 127.0.0.1). On a plain
  // http network address every tab edits, as in 1.0; warn when a second tab appears.
  function warnNoLocking() {
    if (!('BroadcastChannel' in window)) return;
    const ch = new BroadcastChannel('pindou-nolock');
    const warn = () => toast("Pindou Studio is open in more than one tab, and at this address it can't stop them overwriting each other's autosave. Keep to one tab, or open it at 127.0.0.1 / localhost or over https.", { sticky: true });
    let warned = false;
    ch.onmessage = (e) => { if (e.data === 'hello') ch.postMessage('here'); if (!warned) { warned = true; warn(); } };
    ch.postMessage('hello');
  }
  function noLocking() { warnNoLocking(); tab.state = 'off'; tab.editing = true; hideTabNotice(); if (tab.ready) tab.ready(); }
  function waitForLock() {
    if (tab.waiting || document.visibilityState !== 'visible') return;
    tab.waiting = new AbortController();
    lockRequest({ signal: tab.waiting.signal });
  }
  function stopWaiting() { if (tab.waiting) { tab.waiting.abort(); tab.waiting = null; } }
  // Step out of the queue for a while (or until the next editor shows up).
  function stepAside(ms) {
    stopWaiting();
    clearTimeout(tab.asideTimer);
    tab.asideTimer = setTimeout(() => { if (tab.state === 'paused') waitForLock(); }, ms || 2000);
  }
  function post(msg) { if (tab.chan) tab.chan.postMessage({ ...msg, from: tab.id }); }
  function saveNow() {
    if (tab.state !== 'editing' && tab.state !== 'off') return null;
    const project = { ...serialize(), gen: tab.gen };
    scheduleAddressSync();
    if (store.set('pindou.autosave', project)) {
      dirty = false;
      if (tab.saveFailed) { tab.saveFailed = false; toast('Autosave is working again.'); }
    } else if (!tab.saveFailed) {
      tab.saveFailed = true;
      toast("This browser won't let Pindou Studio autosave (storage is full or blocked). Use Save to keep a copy of your design.", { sticky: true });
    }
    return project;
  }
  // Stop whatever this tab is in the middle of, without applying it.
  function stopInteraction() {
    if (S.stroke) cancelStroke();
    for (const id of pointers.keys()) { try { viewport.releasePointerCapture(id); } catch { /* already released */ } }
    pointers.clear(); gesture = null; viewport.classList.remove('panning');
    $$('dialog[open]').forEach((d) => { if (d.id !== 'tabDialog') d.close('cancel'); });
    if (!$('#exportMenu').hidden) closeMenu(false);
    clearTimeout(saveTimer);
  }
  function onLockGained() {
    stopWaiting();
    clearTimeout(tab.slowTimer); clearTimeout(tab.payloadTimer); tab.payloadWaiter = null;
    const was = tab.state, token = tab.current;
    if (was === 'starting' && !tab.waitedAtStart) { becomeEditor(store.get('pindou.autosave', null), true, 'storage'); return; }
    // Taking over: use the newest design, waiting a moment for the one the other tab
    // sent (it was sent before the lock was let go, but travels separately).
    tab.state = 'syncing';
    const finish = () => {
      if (tab.current !== token || tab.state !== 'syncing') return;
      clearTimeout(tab.payloadTimer); tab.payloadWaiter = null;
      const sent = tab.payload, latest = newest(store.get('pindou.autosave', null), sent);
      tab.payload = null;
      becomeEditor(latest, was === 'starting', latest && latest === sent ? 'message' : 'storage');
      hideTabNotice();
    };
    if (tab.payload) finish();
    else { tab.payloadWaiter = finish; tab.payloadTimer = setTimeout(finish, PAYLOAD_WAIT); }
  }
  function becomeEditor(latest, quiet, source) {
    tab.state = 'editing'; tab.editing = true; tab.lastSync = source; tab.everEdited = true;
    // "My collection" may have changed in the other tab too
    S.owned = new Set(store.get('pindou.owned.' + S.paletteId, S.palette.map((c) => c.code)));
    tab.gen = Math.max(store.get(GEN_KEY, 0) || 0, genOf(latest)) + 1;
    store.set(GEN_KEY, tab.gen);
    takeLatest(latest, quiet);
    refreshPanels();
    post({ type: 'editing' });
    if (tab.ready) tab.ready();
    openLinkFromAddress(); // a link given to this tab while it was paused; otherwise this sets the address
  }
  // Another tab asked to take over: stop, save, send the design, let go.
  function handOver(m) {
    if (tab.state !== 'editing' || !tab.release) return;
    stopInteraction();
    const project = saveNow();
    post({ type: 'handover', to: m.from, project });
    tab.current = 0; tab.state = 'paused'; tab.editing = false;
    dropLiveAddress();
    if (tab.saveFailed) { tab.saveFailed = false; hideToast(); }
    const release = tab.release; tab.release = null; release();
    showTabNotice();
    waitForLock();
  }
  function onLockLost() {
    tab.current = 0; tab.release = null;
    clearTimeout(tab.payloadTimer); tab.payloadWaiter = null;
    stopInteraction();
    tab.state = 'paused'; tab.editing = false;
    dropLiveAddress();
    showTabNotice();
    waitForLock();
  }
  function requestTakeover() {
    if (tab.state !== 'paused') return;
    tab.state = 'taking';
    $('#tabTake').setAttribute('aria-disabled', 'true');
    $('#tabTakeLabel').textContent = 'Taking over…';
    clearTimeout(tab.asideTimer);
    if (!tab.waiting) { tab.waiting = new AbortController(); lockRequest({ signal: tab.waiting.signal }); }
    post({ type: 'request' });
    armSlowTimer();
  }
  // The editing tab hasn't answered: say why this tab is still waiting.
  function armSlowTimer() {
    clearTimeout(tab.slowTimer);
    tab.slowTimer = setTimeout(() => {
      if (tab.state !== 'taking') return;
      $('#tabText').textContent = "The other tab isn't answering. It may have a dialog open (such as Print), or it may be busy or asleep in the background. Switch to it and close the dialog, or close that tab, and this one takes over with what was saved there.";
      $('#tabTakeLabel').textContent = 'Waiting for the other tab…';
    }, SLOW_ANSWER);
  }
  function onMessage(e) {
    const m = e.data;
    if (!m || m.from === tab.id) return;
    if ((m.type === 'handover' || m.type === 'closing') && m.project) {
      if (tab.state === 'editing') return;
      tab.payload = newest(tab.payload, m.project);
      if (tab.payloadWaiter) tab.payloadWaiter();
      // After a hand-over, waiting tabs line up again (if the tab that asked has gone,
      // one of them carries on). When the editor closes, they wait a moment first, so
      // a reload of the editing tab gets editing back.
      if (tab.state === 'paused') { if (m.type === 'handover') waitForLock(); else stepAside(1500); }
    } else if (m.type === 'request') {
      // Let a "cancel" that's already queued behind this request win (the asker went
      // back to the editing tab, e.g. after it had been frozen in the background).
      if (tab.state === 'editing') { tab.cancelled.delete(m.from); setTimeout(() => { if (!tab.cancelled.has(m.from)) handOver(m); }, 0); }
      else if (tab.state === 'paused') stepAside(); // let the tab that asked be next
    } else if (m.type === 'cancel') {
      tab.cancelled.add(m.from);
      if (tab.state === 'paused') waitForLock();
    } else if (m.type === 'editing') {
      // A new editor: older copies are out of date; paused tabs line up again, and a
      // tab that was asking asks the new editor instead.
      if (tab.state === 'paused' || tab.state === 'taking') tab.payload = null;
      if (tab.state === 'paused') { clearTimeout(tab.asideTimer); waitForLock(); }
      if (tab.state === 'taking') { post({ type: 'request' }); armSlowTimer(); }
    }
  }
  // Use a saved design if it differs from what this tab shows. One undo step, so Undo
  // goes back to what this tab had before (except at start-up: no undo step).
  function takeLatest(saved, quiet) {
    let msg = 'Editing in this tab now.';
    if (saved) {
      try {
        const { gen, savedAt, ...project } = saved;
        if (JSON.stringify(project) !== JSON.stringify(serialize())) {
          const { state, name } = parseProject(project);
          S.focus = null;
          if (quiet) { applyState({ ...state, name }); S.name = name; requestDraw(); }
          else replaceState({ ...state, name });
          S.owned = new Set(store.get('pindou.owned.' + S.paletteId, S.palette.map((c) => c.code)));
          msg = "Editing in this tab now, with the other tab's latest work. Undo goes back to what this tab had.";
        }
      } catch { /* unreadable: keep what this tab has */ }
    }
    if (!quiet) toast(msg);
  }
  function showTabNotice() {
    tab.blocked = true;
    dropLiveAddress();
    $('#tabText').textContent = (tab.everEdited
      ? 'Editing moved to another tab, so this one is paused. That tab has everything from here.'
      : 'Pindou Studio is already open in another tab or window.')
      + (incomingLink() != null ? ' The pattern from your link opens here when you edit in this tab.' : '');
    $('#tabTake').removeAttribute('aria-disabled');
    $('#tabTakeLabel').textContent = 'Edit here instead';
    const d = $('#tabDialog');
    if (!d.open) showDialog(d);
    $('#tabTake').focus();
  }
  function hideTabNotice() {
    tab.blocked = false;
    const d = $('#tabDialog');
    if (!d.open) return;
    d.close();
    // the control that had focus before may be hidden in this layout now
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.getClientRects().length) return;
      const to = ['#moreBtn', '[data-action=save]', '.tool[aria-pressed="true"]'].map((s) => $(s)).find((el) => el && el.getClientRects().length);
      if (to) to.focus();
    });
  }
  function initTabLock() {
    if (!(navigator.locks && navigator.locks.request)) { warnNoLocking(); return Promise.resolve(); }
    tab.state = 'starting'; tab.editing = false;
    if ('BroadcastChannel' in window) { tab.chan = new BroadcastChannel('pindou'); tab.chan.onmessage = onMessage; }
    const d = $('#tabDialog');
    d.addEventListener('cancel', (e) => e.preventDefault());
    // Browsers let repeated Escape presses close a modal anyway: put it straight back.
    d.addEventListener('close', () => { if (tab.blocked) setTimeout(() => { if (tab.blocked && !d.open) showDialog(d); }, 0); });
    $('#tabTake').addEventListener('click', () => { if ($('#tabTake').getAttribute('aria-disabled') !== 'true') requestTakeover(); });
    document.addEventListener('visibilitychange', () => {
      if (tab.state === 'taking' && document.visibilityState === 'hidden') {
        // Asked, then left (perhaps to the editing tab itself): never mind.
        stopWaiting(); clearTimeout(tab.slowTimer);
        tab.state = 'paused';
        post({ type: 'cancel' });
        showTabNotice();
        return;
      }
      const waits = tab.state === 'paused' || (tab.state === 'starting' && tab.waitedAtStart);
      if (!waits) return;
      if (document.visibilityState === 'visible') waitForLock(); else stopWaiting();
    });
    // The editing tab always saves when it's hidden or closed, even without changes,
    // and sends its design to whoever takes over next.
    window.addEventListener('pagehide', () => { if (tab.state === 'editing') { const project = saveNow(); if (project) post({ type: 'closing', project }); } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && tab.state === 'editing') saveNow(); });
    return new Promise((ready) => {
      tab.ready = () => { tab.ready = null; ready(); };
      lockRequest({ ifAvailable: true }, (got) => {
        if (got) return; // onLockGained finishes start-up
        // On a reload the old page may not have let go yet: wait a moment before
        // showing the notice, and take over quietly if the lock frees up meanwhile.
        tab.waitedAtStart = true;
        waitForLock();
        setTimeout(() => {
          if (tab.state !== 'starting') { if (tab.state !== 'syncing' && tab.ready) tab.ready(); return; }
          tab.state = 'paused';
          showTabNotice();
          if (tab.ready) tab.ready();
        }, 500);
      });
    });
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

  async function exportPng() {
    // The link is taken now, with the drawing below, so the QR matches the pattern.
    const linkP = S.qrExport ? currentLink() : null;
    const cs = clamp(Math.floor(5000 / Math.max(S.w, S.h)), 4, 24);
    const pattern = renderRegion({ x: 0, y: 0, w: S.w, h: S.h }, cs, { codes: true, rulers: true });
    const list = usedList(countRegion(), 'code');
    const total = list.reduce((a, b) => a + b.n, 0);
    const colW = 150, rowH = 24;
    const cols = Math.max(1, Math.floor((pattern.width - 20) / colW));
    const rows = Math.ceil(list.length / cols);
    const head = 56;
    const name = S.name, info = `${S.w}×${S.h} beads · ${traysAcross()}×${traysDown()} trays of ${S.tray} · ${fmt(total)} beads · ${list.length} colors · ${PALETTES[S.paletteId].name}`;
    let qr = null;
    if (linkP) {
      const url = await linkP;
      qr = makeQr(url);
      if (!qr) toast(url ? `This design's link is too long for a QR code (${QR_MAX_NOTE}), so the PNG has none.` : "This browser can't make design links, so the PNG has no QR code.");
    }
    const out = document.createElement('canvas');
    const foot = 28;
    // about a fifth of the image wide, so it still scans when the PNG is printed to fit a page
    const qrPx = qr ? Math.max(4, Math.floor(Math.max(pattern.width, 480) / 5 / (qr.size + 8))) : 0;
    const qrImg = qr ? qrCanvas(qr, qrPx) : null, qrH = qrImg ? qrImg.height + 16 : 0;
    out.width = Math.max(pattern.width, 480, qrImg ? qrImg.width + 24 + 260 : 0);
    out.height = head + pattern.height + 30 + rows * rowH + 20 + qrH + foot;
    const g = out.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
    g.fillStyle = '#111'; g.font = '700 20px system-ui, sans-serif'; g.textBaseline = 'top';
    g.fillText(name, 12, 10);
    g.font = '13px system-ui, sans-serif'; g.fillStyle = '#555';
    g.fillText(info, 12, 34);
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
    if (qrImg) {
      const qy = y0 + rows * rowH + 16;
      g.drawImage(qrImg, 12, qy);
      g.fillStyle = '#111'; g.font = '600 14px system-ui, sans-serif'; g.textBaseline = 'top';
      g.fillText('Scan to open this design', qrImg.width + 28, qy + 16);
      g.font = '13px system-ui, sans-serif'; g.fillStyle = '#555';
      g.fillText('in Pindou Studio', qrImg.width + 28, qy + 36);
    }
    g.font = '12px system-ui, sans-serif'; g.fillStyle = '#666'; g.textBaseline = 'bottom';
    g.fillText(CREDIT, 12, out.height - 10);
    out.toBlob((b) => download(safeName(name) + '.png', b), 'image/png');
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

  let printing = false;
  async function printTrays() {
    if (printing) return; // a double click
    printing = true;
    try {
      // so the QR page is ready (again if the design changed meanwhile)
      for (let i = 0; S.qrExport && freshLink() === undefined && i < 3; i++) await currentLink();
    } finally { printing = false; }
    buildPrintSheets();
    saveBeforeDialog();
    window.print();
  }
  // Sheets are canvases (drawn synchronously), so they are ready even when the
  // browser's own Print (Ctrl+P) fires 'beforeprint' and prints immediately.
  function buildPrintSheets() {
    const root = $('#printRoot');
    root.innerHTML = '';
    const total = countRegion();
    const totalList = usedList(total, 'code');
    const legendHtml = (list) => list.map(({ c, n }) => `<div><span class="chip" style="background:${c.transparent ? 'rgb(226,236,246)' : c.hex}"></span><b>${c.code}</b> × ${fmt(n)}</div>`).join('');
    const addSheet = (title, sub, canvasEl, list) => {
      const sec = document.createElement('section'); sec.className = 'sheet';
      sec.innerHTML = `<div class="sheet-head"><h2>${escapeHtml(title)}</h2><div class="sheet-sub">${escapeHtml(sub)}</div><div class="sheet-credit">${escapeHtml(CREDIT)}</div></div>`;
      canvasEl.className = 'sheet-img';
      sec.appendChild(canvasEl);
      const lg = document.createElement('div'); lg.className = 'legend'; lg.innerHTML = legendHtml(list);
      sec.appendChild(lg);
      root.appendChild(sec);
    };
    const ovCs = clamp(Math.floor(1400 / Math.max(S.w, S.h)), 2, 16);
    addSheet(`${S.name} — overview`,
      `${S.w}×${S.h} beads · ${traysAcross()}×${traysDown()} trays of ${S.tray}×${S.tray} · ${fmt(totalList.reduce((a, b) => a + b.n, 0))} beads · ${PALETTES[S.paletteId].name}`,
      renderRegion({ x: 0, y: 0, w: S.w, h: S.h }, ovCs, { trayLabels: true, codes: trayCount() === 1 && ovCs >= 14, rulers: trayCount() === 1 }), totalList);
    if (trayCount() > 1 || ovCs < 14) {
      const cs = S.tray > 80 ? 14 : 20;
      for (let r = 0; r < traysDown(); r++) for (let c = 0; c < traysAcross(); c++) {
        const t = trayRect(r, c);
        const list = usedList(countRegion(t), 'code');
        const n = list.reduce((a, b) => a + b.n, 0);
        addSheet(`${S.name} — ${trayName(r, c)}`,
          `Tray ${r * traysAcross() + c + 1} of ${trayCount()} · columns ${t.x + 1}–${t.x + t.w}, rows ${t.y + 1}–${t.y + t.h} of the full design · ${fmt(n)} beads`,
          renderRegion(t, cs, { codes: true, rulers: true }), list);
      }
    }
    if (S.qrExport) {
      // a last page with the design's QR code
      const sec = document.createElement('section'); sec.className = 'sheet sheet-qr-page';
      const url = freshLink();
      const qr = makeQr(url);
      sec.innerHTML = `<div class="sheet-head"><h2>${escapeHtml(S.name)}: scan to open this design</h2><div class="sheet-credit">${escapeHtml(CREDIT)}</div></div>`;
      if (qr) {
        const c = qrCanvas(qr, 8); c.className = 'sheet-qr';
        c.style.width = c.style.height = `${Math.max(40, (qr.size + 8) * 0.5)}mm`; // ~0.5 mm a module scans well
        sec.appendChild(c);
        const p = document.createElement('p'); p.className = 'sheet-sub';
        p.textContent = 'Scan with a phone camera to open this design in Pindou Studio, ready to edit, count or print.';
        sec.appendChild(p);
      } else {
        const p = document.createElement('p'); p.className = 'sheet-sub';
        p.textContent = url === undefined
          ? 'The QR code was still being made when printing started. Print again from Export → Print per-tray sheets to include it.'
          : url === null ? "This browser can't make design links, so there's no QR code."
            : `This design's link is too long for a QR code (${QR_MAX_NOTE}). Save the design as a file to share it instead.`;
        sec.appendChild(p);
      }
      root.appendChild(sec);
    }
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- image → pattern ----------
  const imgState = { img: null, aspect: 1, result: null, timer: null, stepTimer: null, job: null, caches: new Map(), applyWhenDone: false };

  function openImageDialog() {
    const dlg = $('#imageDialog');
    $('#imgOwned').disabled = S.owned.size === 0;
    tp.sel = null; tp.hover = null;
    showDialog(dlg);
    // Always start from a fresh conversion with the current palette and settings.
    if (imgState.img) startConvert();
    else { imgState.result = null; $('#imgApply').disabled = true; }
    drawTrayPicker();
  }

  // ----- tray picker: a "table size" style grid of trays for choosing W × H -----
  const tp = { hover: null, sel: null, n: 4, px: 220 };
  const imgDims = () => ({ w: clamp(+$('#imgW').value | 0, 1, MAX_DIM), h: clamp(+$('#imgH').value | 0, 1, MAX_DIM) });
  function drawTrayPicker() {
    const cv = $('#trayPicker');
    const { w, h } = imgDims();
    const usedA = Math.ceil(w / S.tray), usedD = Math.ceil(h / S.tray);
    const target = tp.hover || tp.sel;
    const maxTrays = Math.floor(MAX_DIM / S.tray);
    // Only resize the grid when the pointer isn't on it, so squares never shift under the cursor.
    // It grows one step past the current size (or keyboard selection) to leave room to go bigger.
    if (!tp.hover) tp.n = clamp(Math.max(usedA, usedD, tp.sel ? Math.max(tp.sel.a, tp.sel.d) : 0) + 1, 4, Math.max(4, maxTrays));
    const r = window.devicePixelRatio || 1;
    cv.width = tp.px * r; cv.height = tp.px * r;
    const g = cv.getContext('2d');
    g.setTransform(r, 0, 0, r, 0, 0);
    const cs = tp.px / tp.n;
    g.fillStyle = T.panel; g.fillRect(0, 0, tp.px, tp.px);
    // empty trays
    for (let y = 0; y < tp.n; y++) for (let x = 0; x < tp.n; x++) {
      g.fillStyle = T.empty;
      g.fillRect(x * cs + 1.5, y * cs + 1.5, cs - 3, cs - 3);
    }
    // current image footprint, drawn to scale in tray units
    const fw = (w / S.tray) * cs, fh = (h / S.tray) * cs;
    if (imgState.img) {
      g.globalAlpha = 0.85; g.imageSmoothingEnabled = true;
      g.drawImage(imgState.img, 1.5, 1.5, Math.max(1, fw - 3), Math.max(1, fh - 3));
      g.globalAlpha = 1;
    } else {
      g.fillStyle = T.grid; g.fillRect(1.5, 1.5, fw - 3, fh - 3);
    }
    g.strokeStyle = T.tray; g.lineWidth = 2; g.strokeRect(1.5, 1.5, fw - 3, fh - 3);
    // hovered / keyboard-selected tray block
    if (target) {
      g.fillStyle = T.accent; g.globalAlpha = 0.18;
      g.fillRect(0, 0, target.a * cs, target.d * cs);
      g.globalAlpha = 1;
      g.strokeStyle = T.accent; g.lineWidth = 2.5;
      g.strokeRect(1.25, 1.25, target.a * cs - 2.5, target.d * cs - 2.5);
    }
    // tray seams
    g.strokeStyle = T.line; g.lineWidth = 1;
    for (let k = 1; k < tp.n; k++) {
      g.beginPath(); g.moveTo(k * cs, 0); g.lineTo(k * cs, tp.px); g.moveTo(0, k * cs); g.lineTo(tp.px, k * cs); g.stroke();
    }
    $('#tpLabel').textContent = target
      ? `${target.a} × ${target.d} tray${target.a * target.d > 1 ? 's' : ''} → ${fitToTrays(target.a, target.d).join(' × ')} beads`
      : `${w} × ${h} beads · ${usedA} × ${usedD} tray${usedA * usedD > 1 ? 's' : ''}`;
    cv.setAttribute('aria-valuetext', $('#tpLabel').textContent);
    cv.setAttribute('aria-valuenow', String(target ? target.a : usedA));
    cv.setAttribute('aria-valuemax', String(tp.n));
  }
  function fitToTrays(a, d) {
    const A = Math.min(a * S.tray, MAX_DIM), D = Math.min(d * S.tray, MAX_DIM);
    if (!$('#imgLock').checked || !imgState.img) return [A, D];
    let w = Math.min(A, Math.round(D * imgState.aspect));
    let h = Math.round(w / imgState.aspect);
    if (h > D) { h = D; w = Math.round(h * imgState.aspect); }
    return [Math.max(1, w), Math.max(1, h)];
  }
  function applyTrayFit(a, d) {
    const [w, h] = fitToTrays(a, d);
    $('#imgW').value = w; $('#imgH').value = h;
    tp.sel = null;
    drawTrayPicker();
    scheduleConvert();
  }
  function tpCell(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const cs = r.width / tp.n;
    return { a: clamp(Math.floor((e.clientX - r.left) / cs) + 1, 1, tp.n), d: clamp(Math.floor((e.clientY - r.top) / cs) + 1, 1, tp.n) };
  }
  function syncImgDims(from) {
    if (!$('#imgLock').checked || !imgState.img) return;
    if (from === 'w') $('#imgH').value = clamp(Math.round(+$('#imgW').value / imgState.aspect), 1, MAX_DIM);
    else $('#imgW').value = clamp(Math.round(+$('#imgH').value * imgState.aspect), 1, MAX_DIM);
  }
  function scheduleConvert() {
    clearTimeout(imgState.timer);
    drawTrayPicker();
    $('#imgStats').textContent = 'Converting…';
    imgState.timer = setTimeout(startConvert, 150);
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
  // Image conversion runs as a generator so it can be sliced: the page stays
  // responsive and a newer setting cancels an older run. Nearest-color matches are
  // cached per palette/candidate set while the dialog is in use, so re-converting
  // at another size mostly reuses earlier results. Matching is exact CIEDE2000.
  let jobDeadline = Infinity;
  const yieldDue = () => performance.now() > jobDeadline;
  function matchCache(candidates) {
    const sig = S.paletteId + ':' + candidates.join(',');
    if (!imgState.caches.has(sig)) imgState.caches.set(sig, new Map());
    return imgState.caches.get(sig);
  }
  function* convertJob(opts) {
    const { w, h } = opts;
    const data = downscale(imgState.img, w, h);
    let cand = S.palette.filter((c) => !c.transparent && (!opts.owned || S.owned.has(c.code))).map((c) => c.i);
    if (!cand.length) cand = allSolid();
    function* run(candidates, pass) {
      const cache = matchCache(candidates);
      const match = (r, g, b) => {
        const key = (r << 16) | (g << 8) | b;
        let v = cache.get(key);
        if (v === undefined) { v = nearest(Color.rgbToLab(r, g, b), candidates); cache.set(key, v); }
        return v;
      };
      const out = new Int16Array(w * h);
      const buf = new Float32Array(w * h * 3);
      for (let i = 0; i < w * h; i++) { buf[i * 3] = data[i * 4]; buf[i * 3 + 1] = data[i * 4 + 1]; buf[i * 3 + 2] = data[i * 4 + 2]; }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
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
        if (yieldDue()) yield { pass, progress: (y + 1) / h };
      }
      return out;
    }
    let out = yield* run(cand, 1);
    if (opts.max > 0) {
      const counts = new Map();
      for (const v of out) if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1);
      if (counts.size > opts.max) out = yield* run(reduceColors(counts, opts.max), 2);
    }
    if (opts.bg) removeBackground(out, w, h);
    return { w, h, cells: out };
  }
  // Run a conversion to the end without yielding (Apply, tests).
  function convert(opts) {
    const saved = jobDeadline; jobDeadline = Infinity;
    try {
      const job = convertJob(opts);
      let r = job.next();
      while (!r.done) r = job.next();
      return r.value;
    } finally { jobDeadline = saved; }
  }
  // Drop colors one at a time, always removing the one that is cheapest to lose
  // (bead count × distance to its nearest surviving color). Unlike "keep the most
  // common N", this keeps small but distinct details such as eyes and outlines.
  // `dropped`, if given, collects the colors in the order they were merged away (the same
  // order for any `max`, so one run down to 2 gives the kept set for every count).
  function reduceColors(counts, max, dropped) {
    const kept = new Map(counts);
    // Pairwise distances once up front (at most 291² of them) instead of every round.
    const ids = [...counts.keys()];
    const dist = new Map(ids.map((a) => [a, new Map(ids.map((b) => [b, Color.deltaE2000(S.palette[a].lab, S.palette[b].lab)]))]));
    while (kept.size > max) {
      let worst = -1, into = -1, best = Infinity;
      for (const [a, na] of kept) {
        let nd = Infinity, ni = -1;
        const da = dist.get(a);
        for (const b of kept.keys()) {
          if (a === b) continue;
          const d = da.get(b);
          if (d < nd) { nd = d; ni = b; }
        }
        const cost = na * nd;
        if (cost < best) { best = cost; worst = a; into = ni; }
      }
      kept.set(into, kept.get(into) + kept.get(worst));
      kept.delete(worst);
      if (dropped) dropped.push(worst);
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
  function convertOpts() {
    return {
      w: clamp(+$('#imgW').value | 0, 1, MAX_DIM), h: clamp(+$('#imgH').value | 0, 1, MAX_DIM),
      max: clamp(+$('#imgMax').value | 0, 0, 999),
      owned: $('#imgOwned').checked,
      dither: $('#imgDither').checked,
      bg: $('#imgBg').checked,
      clear: $('#imgClear').checked,
    };
  }
  function cancelConvert() {
    clearTimeout(imgState.timer); imgState.timer = null;
    clearTimeout(imgState.stepTimer); imgState.stepTimer = null;
    imgState.job = null;
    hideBusy();
  }
  // Progress card over the preview. Only appears once a conversion has run for a
  // moment, so quick conversions don't flash it. The time estimate comes from this
  // pass's own rate, and waits until there's enough of it to be meaningful.
  const BUSY_DELAY = 400;
  function showBusy(pass, progress, passMs) {
    const pct = Math.min(99, Math.floor(progress * 100));
    $('#imgPreviewBox').classList.add('busy');
    $('#imgPreviewBox').setAttribute('aria-busy', 'true');
    $('#imgBusy').hidden = false;
    $('#imgBusyLabel').textContent = pass > 1 ? 'Reducing colors…' : 'Converting…';
    $('#imgBusyPct').textContent = pct + '%';
    $('#imgProgress').value = pct;
    let eta = '';
    if (passMs > 1500 && progress > 0.03) {
      const left = (passMs * (1 - progress)) / progress / 1000;
      eta = left < 5 ? 'Almost done' : left < 60 ? `About ${Math.ceil(left / 5) * 5} s left` : `About ${Math.round(left / 60)} min left`;
      if (pass > 1) eta += ' in this step';
    } else if (passMs > 1500) eta = 'Working out how long this will take…';
    if (imgState.applyWhenDone) eta += (eta ? ' · ' : '') + 'the pattern will be used when this finishes';
    $('#imgBusyEta').textContent = eta;
  }
  function hideBusy() {
    $('#imgPreviewBox').classList.remove('busy');
    $('#imgPreviewBox').removeAttribute('aria-busy');
    $('#imgBusy').hidden = true;
  }
  // Is a newer conversion still waiting or running? Then the shown result is stale.
  const convertPending = () => !!(imgState.timer || imgState.job);
  // Convert in ~20 ms slices so the page stays responsive; a newer request cancels this one.
  function startConvert() {
    const wasBusy = !$('#imgBusy').hidden; // a newer setting replaced a long run: keep the card up
    cancelConvert();
    if (!imgState.img) return;
    const job = convertJob(convertOpts());
    imgState.job = job;
    const started = performance.now();
    let curPass = 1, passStart = started;
    const step = () => {
      if (imgState.job !== job) return;
      jobDeadline = performance.now() + 20;
      let r;
      try { r = job.next(); } finally { jobDeadline = Infinity; }
      if (r.done) { imgState.job = null; hideBusy(); showConversion(r.value); return; }
      const { pass, progress } = r.value;
      const now = performance.now();
      if (pass !== curPass) { curPass = pass; passStart = now; }
      if (wasBusy || now - started > BUSY_DELAY) showBusy(pass, progress, now - passStart);
      $('#imgStats').textContent = `Converting… ${Math.round(progress * 100)}%${pass > 1 ? ' (reducing colors)' : ''}${imgState.applyWhenDone ? ' · will use the pattern when done' : ''}`;
      imgState.stepTimer = setTimeout(step, 0);
    };
    step();
  }
  // Convert right now, to the end (used when the person applies the pattern).
  function runConvert() {
    cancelConvert();
    if (!imgState.img) return;
    showConversion(convert(convertOpts()));
  }
  function showConversion(res) {
    const { w, h } = res;
    imgState.result = res;
    // preview: one pixel per bead, scaled up without smoothing
    const small = document.createElement('canvas'); small.width = w; small.height = h;
    const sg = small.getContext('2d'); const img = sg.createImageData(w, h);
    const used = new Set(); let beads = 0;
    for (let i = 0; i < w * h; i++) {
      const v = res.cells[i], o = i * 4;
      let rgb;
      if (v < 0) { const x = i % w, y = (i / w) | 0; rgb = ((x + y) & 1) ? [221, 221, 221] : [238, 238, 238]; }
      else { rgb = S.palette[v].rgb; used.add(v); beads++; }
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
    sg.putImageData(img, 0, 0);
    const pv = $('#imgPreview');
    const cs = Math.max(1, Math.floor(480 / Math.max(w, h)));
    pv.width = w * cs; pv.height = h * cs;
    const g = pv.getContext('2d'); g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, pv.width, pv.height);
    const ta = Math.ceil(w / S.tray), td = Math.ceil(h / S.tray);
    $('#imgStats').textContent = `${w}×${h} · ${fmt(beads)} beads · ${used.size} colors · ${ta}×${td} tray${ta * td > 1 ? 's' : ''} of ${S.tray}`;
    $('#imgApply').disabled = false;
    if (imgState.applyWhenDone) { imgState.applyWhenDone = false; $('#imageDialog').close('ok'); }
  }

  // ---------- new / resize ----------
  function openNewDialog() {
    const nt = $('#newTray');
    nt.querySelectorAll('option[data-custom]').forEach((o) => o.remove());
    if (![...nt.options].some((o) => o.value === String(S.tray))) {
      const o = document.createElement('option');
      o.dataset.custom = '1'; o.value = String(S.tray); o.textContent = `${S.tray} × ${S.tray}`;
      nt.appendChild(o);
    }
    nt.value = String(S.tray);
    $('#newAcross').value = traysAcross(); $('#newDown').value = traysDown();
    $('#newW').value = S.w; $('#newH').value = S.h;
    $('#newKeep').checked = false;
    updateNewSummary();
    showDialog($('#newDialog'));
  }
  function updateNewSummary() {
    const w = +$('#newW').value | 0, h = +$('#newH').value | 0, t = +$('#newTray').value;
    $('#newSummary').textContent = `${w}×${h} beads → ${Math.ceil(w / t)}×${Math.ceil(h / t)} trays · ${fmt(w * h)} pegs · ≈${(w * 0.26).toFixed(1)}×${(h * 0.26).toFixed(1)} cm`;
  }

  // ---------- wiring ----------
  function syncTraySelect() {
    const sel = $('#traySize'), n = S.tray;
    if (![...sel.options].some((o) => o.value === String(n))) {
      let o = sel.querySelector('option[data-custom]');
      if (!o) { o = document.createElement('option'); o.dataset.custom = '1'; sel.insertBefore(o, sel.lastElementChild); }
      o.value = String(n); o.textContent = `${n} × ${n}`;
    }
    sel.value = String(n);
  }
  function setTraySize(n) {
    S.tray = n;
    syncTraySelect();
    S.focus = null;
    changed(); refreshPanels(); requestDraw();
  }

  function bind() {
    // top actions
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) { if (!e.target.closest('.menu')) closeMenu(); return; }
      const a = b.dataset.action;
      if (a !== 'toggle-export' && a !== 'toggle-qr') closeMenu();
      switch (a) {
        case 'new': openNewDialog(); break;
        case 'import-image': openImageDialog(); break;
        case 'open': $('#openFile').click(); break;
        case 'save': saveProject(); break;
        case 'share-link': shareLink(); break;
        case 'toggle-export': if ($('#exportMenu').hidden) openMenu(); else closeMenu(); break;
        case 'export-png': exportPng(); break;
        case 'toggle-qr': setQrExport(!S.qrExport); break;
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

    // ⋯ menu (compact layouts): closes after an action, on a click outside, or Escape
    $('#moreBtn').addEventListener('click', () => setMore(!$('#fileActions').classList.contains('open'), true));
    // (Capture phase: runs before the action, so a dialog it opens returns focus to ⋯.)
    document.addEventListener('click', (e) => {
      if (!$('#fileActions').classList.contains('open') || e.target.closest('#moreBtn')) return;
      const b = e.target.closest('#fileActions button, #fileActions a');
      if (b && (b.dataset.action === 'toggle-export' || b.dataset.action === 'toggle-qr')) return; // stays inside the menu
      if (b) setMore(false, $('#fileActions').contains(document.activeElement));
      else if (!e.target.closest('#fileActions')) setMore(false, false);
    }, true);
    $('#fileActions').addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (to && !$('#fileActions').contains(to) && to !== $('#moreBtn')) setMore(false, false);
    });
    // bottom sheet (phone layouts)
    $('#sheetToggle').addEventListener('click', () => setSheet(!$('#sidebar').classList.contains('expanded')));
    $('#quickColors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      if (b.dataset.q === 'current') { if (sheetMode()) setSheet(!$('#sidebar').classList.contains('expanded')); }
      else pickColor(+b.dataset.q);
    });
    $('#quickColors').addEventListener('keydown', (e) => {
      const items = $$('#quickColors button');
      const k = items.indexOf(document.activeElement);
      if (k < 0) return;
      const to = { ArrowRight: k + 1, ArrowLeft: k - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      const b = items[clamp(to, 0, items.length - 1)];
      items.forEach((x) => { x.tabIndex = x === b ? 0 : -1; });
      b.focus();
    });
    // Short screens (phones in landscape, flip-phone cover screens) can't spare a row
    // for the view settings, so they move into the ⋯ menu; the same elements, so their
    // listeners come along.
    const shortMQ = matchMedia('(max-height: 520px)');
    const placeStageBar = () => {
      const bar = $('.stage-bar'), fa = $('#fileActions');
      const focused = bar.contains(document.activeElement) ? document.activeElement : null;
      if (shortMQ.matches) { if (bar.parentElement !== fa) fa.insertBefore(bar, fa.querySelector('.repo-sep')); }
      else if (bar.parentElement !== $('.stage')) { $('.stage').insertBefore(bar, viewport); setMore(false); }
      if (focused && document.activeElement !== focused) (focused.offsetParent ? focused : $('#moreBtn')).focus();
    };
    shortMQ.addEventListener('change', placeStageBar);
    placeStageBar();
    // Compact layouts put the swatches right under the palette/search row, so colors
    // come first and the screen order matches the Tab order (the elements move, as
    // with the stage bar; desktop keeps its order).
    const swatchesFirstMQ = matchMedia('(max-width: 599.98px), (max-height: 520px) and (min-width: 600px) and (pointer: coarse), (vertical-viewport-segments: 2), (horizontal-viewport-segments: 2)');
    const placeSwatches = () => {
      const sw = $('#swatches'), hint = $('#ownedHint'), panel = $('[data-panel=palette]');
      const focused = sw.contains(document.activeElement) ? document.activeElement : null;
      if (swatchesFirstMQ.matches) {
        const after = panel.querySelector('.row'); // palette + search
        if (after.nextElementSibling !== hint) { after.after(hint, sw); }
      } else if ($('#swatchesHome').previousElementSibling !== sw) {
        $('#swatchesHome').before(hint, sw);
      }
      sw.classList.toggle('near-top', swatchesFirstMQ.matches);
      if (focused && document.activeElement !== focused) focused.focus();
    };
    placeSwatches();
    // Focus that a layout change hid (rotating, folding, resizing) moves to the
    // control that does the same job in the new layout. The browser may already have
    // dropped focus when the element was hidden, so go by the element that had it,
    // unless the user had deliberately moved focus away (blurred a visible element).
    let lastFocused = null;
    document.addEventListener('focusin', (e) => { lastFocused = e.target; });
    document.addEventListener('focusout', (e) => { if (!e.relatedTarget && e.target.getClientRects().length && document.hasFocus()) lastFocused = null; });
    function keepFocusVisible() {
      const a = document.activeElement;
      const f = a && a !== document.body ? a : lastFocused;
      if (!f || !document.contains(f) || f.getClientRects().length) return;
      let to = null;
      const sb = $('#sidebar');
      if (sheetMode() && !sb.classList.contains('expanded') && sb.contains(f) && !$('.sheet-bar').contains(f)) to = $('#sheetToggle');
      else if (f.closest('#quickColors')) to = $('#quickColors [data-q=current]').getClientRects().length ? $('#quickColors [data-q=current]') : ($('#swatches .sw[aria-pressed="true"]') || $('#swatches .sw'));
      else if (f === $('#sheetToggle')) to = $('#quickColors [data-q=current]').getClientRects().length ? $('#quickColors [data-q=current]') : $('.tabs [aria-selected="true"]');
      else if (f === $('#moreBtn') || f.closest('#fileActions')) to = $('[data-action=save]').getClientRects().length ? $('[data-action=save]') : $('#moreBtn');
      else if (f.matches('[data-action=zoom-in], [data-action=zoom-out]')) to = $('[data-action=zoom-fit]');
      if (to && to.getClientRects().length) to.focus();
    }
    const compactMQ = matchMedia('(max-width: 799.98px), (max-height: 520px)');
    const onLayoutChange = () => {
      if (!compactMQ.matches) setMore(false); // a layout without ⋯ closes it, so it doesn't linger unseen
      placeSwatches();
      requestAnimationFrame(keepFocusVisible);
    };
    [phoneMQ, foldedMQ, shortMQ, compactMQ, swatchesFirstMQ, matchMedia('(max-width: 379.98px)')].forEach((mq) => mq.addEventListener('change', onLayoutChange));
    // The folded-phone layout needs the top bar's height.
    new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', $('.topbar').offsetHeight + 'px')).observe($('.topbar'));

    $('#toastClose').addEventListener('click', hideToast);
    const menuBox = $('.menu');
    menuBox.addEventListener('focusout', (e) => { if (!menuBox.contains(e.relatedTarget)) closeMenu(); });
    $('#exportMenu').addEventListener('keydown', (e) => {
      const items = $$('#exportMenu button');
      const k = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(k + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(k - 1 + items.length) % items.length].focus(); }
    });
    $$('dialog').forEach((dlg) => dlg.addEventListener('close', () => {
      if ($('#toast').parentElement === dlg) moveToast(document.body);
    }));
    $('#projectName').addEventListener('input', (e) => {
      if (!tab.editing) { e.target.value = S.name; return; }
      S.name = e.target.value; dirty = true; autosave(); designChanged();
    });

    $('#traySize').addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        saveBeforeDialog();
        const v = parseInt(prompt('Pegs per side for one tray (5–300):', String(S.tray)), 10);
        if (v >= 5 && v <= 300 && tab.editing) setTraySize(v); else e.target.value = String(S.tray);
      } else if (tab.editing) setTraySize(+e.target.value);
      else e.target.value = String(S.tray);
    });
    $('#guides').addEventListener('change', (e) => { S.guides = +e.target.value; savePrefs(); requestDraw(); });
    $('#showCodes').addEventListener('change', (e) => { S.showCodes = e.target.checked; savePrefs(); requestDraw(); });
    $('#roundBeads').addEventListener('change', (e) => { S.round = e.target.checked; savePrefs(); requestDraw(); });

    // tabs
    // (ARIA tabs pattern: one tab in the Tab order, arrows/Home/End move and select)
    const tabs = $$('.tabs [role=tab]');
    const selectTab = (t, focus) => {
      tabs.forEach((x) => { const on = x === t; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; });
      $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
      if (focus) t.focus();
    };
    tabs.forEach((t) => t.addEventListener('click', () => selectTab(t)));
    $('.tabs').addEventListener('keydown', (e) => {
      const k = tabs.indexOf(document.activeElement);
      if (k < 0) return;
      const to = { ArrowRight: (k + 1) % tabs.length, ArrowLeft: (k - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault();
      selectTab(tabs[to], true);
    });
    selectTab(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);

    // canvas from the keyboard
    viewport.addEventListener('keydown', onCanvasKey);
    viewport.addEventListener('pointerdown', () => { if (cursorOn) { cursorOn = false; requestDraw(); } });
    viewport.addEventListener('blur', () => requestDraw());
    viewport.addEventListener('focus', () => { if (cursorOn) { requestDraw(); announceCursor(); } });

    // palette panel
    const ps = $('#paletteSelect');
    for (const [id, p] of Object.entries(PALETTES)) {
      const o = document.createElement('option'); o.value = id; o.textContent = p.name; ps.appendChild(o);
    }
    ps.value = S.paletteId;
    ps.addEventListener('change', () => switchPalette(ps.value));
    const pv = $('#paletteView');
    for (const [id, v] of Object.entries(PALETTE_VIEWS)) {
      const o = document.createElement('option'); o.value = id; o.textContent = v.label; pv.appendChild(o);
    }
    pv.value = S.pview;
    pv.addEventListener('change', () => { S.pview = pv.value; savePrefs(); renderSwatches(); });
    $('#paletteSearch').addEventListener('input', (e) => { S.search = e.target.value; renderSwatches(); });
    $$('#paletteFilter button').forEach((b) => b.addEventListener('click', () => {
      S.filter = b.dataset.filter;
      $$('#paletteFilter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderSwatches();
    }));
    $('#editOwned').addEventListener('change', (e) => {
      S.editOwned = e.target.checked;
      renderSwatches();
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
        b.setAttribute('aria-pressed', String(S.owned.has(c.code)));
        b.setAttribute('aria-label', `${c.code}, ${S.owned.has(c.code) ? 'in my collection' : 'not in my collection'}`);
      } else {
        pickColor(c.i);
        // Phones: picking from the full palette closes the sheet so the canvas is back;
        // the color stays in the quick row, which keeps the focus.
        if (sheetMode() && $('#sidebar').classList.contains('expanded')) {
          setSheet(false);
          $('#quickColors [data-q=current]').focus();
        }
      }
    });

    $$('#countSort button').forEach((b) => b.addEventListener('click', () => {
      S.sort = b.dataset.sort;
      $$('#countSort button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderCounts();
    }));

    // open file
    $('#linkCopy').addEventListener('click', copyLink);
    $('#linkQrBtn').addEventListener('click', toggleLinkQr);
    $$('input[name=linkWhich]').forEach((r) => r.addEventListener('change', showLinkChoice));
    $('#linkColors').addEventListener('input', onSimplerControls);
    $('#linkClean').addEventListener('change', onSimplerControls);
    $('#linkApply').addEventListener('click', applySimpler);
    $('#linkDialog').addEventListener('close', () => { share.seq++; clearTimeout(share.timer); });
    $('#linkLive').addEventListener('change', (e) => setLinkLive(e.target.checked));
    $('#linkShare').addEventListener('click', () => {
      navigator.share({ title: S.name, url: $('#linkText').value }).catch(() => { /* cancelled */ });
    });
    window.addEventListener('hashchange', () => {
      // asking about a link that's no longer in the address (Back, or a newer link): drop the question
      const ask = $('#linkOpenDialog');
      if (ask.open && incomingLink() !== linkAsking) ask.close('superseded');
      if (tab.blocked) { if (tab.state === 'paused') showTabNotice(); return; } // (re)words the notice; a link opens once this tab edits
      if (incomingLink() == null) return;
      openLinkFromAddress();
    });

    $('#openFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      let parsed;
      try { parsed = parseProject(JSON.parse(await f.text())); }
      catch (err) { toast(`Couldn't open ${f.name}: ${err.message}. Your current design wasn't changed.`, { sticky: true }); return; }
      const { state, name, missing } = parsed;
      S.focus = null;
      replaceState({ ...state, name }, missing.length ? null : `Opened ${name}. Undo brings back the previous design.`);
      if (missing.length) {
        toast(`Opened ${name}, but ${missing.length} color code${missing.length > 1 ? 's' : ''} aren't in ${PALETTES[state.paletteId].name} and were left empty: ${listCodes(missing)}. Undo brings back the previous design.`, { sticky: true });
      }
      autosave();
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
      replaceState({ paletteId: S.paletteId, tray: +$('#newTray').value, name: keep ? S.name : 'Untitled', w, h, cells },
        keep ? `Resized to ${w}×${h}. Undo brings back the previous size.` : `New ${w}×${h} design. Undo brings back the old one.`);
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
      img.onerror = () => {
        $('#imgStats').textContent = "That file couldn't be read as an image. Try a PNG, JPEG, GIF or WebP.";
        toast("That file couldn't be read as an image.", { sticky: true });
      };
      img.src = URL.createObjectURL(f);
    });
    $('#imgW').addEventListener('input', () => { syncImgDims('w'); scheduleConvert(); });
    $('#imgH').addEventListener('input', () => { syncImgDims('h'); scheduleConvert(); });
    ['#imgMax', '#imgOwned', '#imgDither', '#imgBg', '#imgClear', '#imgLock'].forEach((s) => $(s).addEventListener('change', scheduleConvert));
    $('#imgMax').addEventListener('input', scheduleConvert);
    const tpc = $('#trayPicker');
    tpc.addEventListener('pointermove', (e) => { tp.hover = tpCell(e); drawTrayPicker(); });
    tpc.addEventListener('pointerleave', () => { tp.hover = null; drawTrayPicker(); });
    tpc.addEventListener('pointerdown', (e) => { e.preventDefault(); const c = tpCell(e); tp.hover = null; applyTrayFit(c.a, c.d); });
    tpc.addEventListener('blur', () => { tp.sel = null; drawTrayPicker(); });
    tpc.addEventListener('keydown', (e) => {
      const { w, h } = imgDims();
      const cur = tp.sel || { a: Math.ceil(w / S.tray), d: Math.ceil(h / S.tray) };
      const moves = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
      if (moves[e.key]) {
        e.preventDefault();
        const maxT = Math.floor(MAX_DIM / S.tray);
        tp.sel = { a: clamp(cur.a + moves[e.key][0], 1, maxT), d: clamp(cur.d + moves[e.key][1], 1, maxT) };
        drawTrayPicker();
      } else if ((e.key === 'Enter' || e.key === ' ') && tp.sel) {
        e.preventDefault();
        applyTrayFit(tp.sel.a, tp.sel.d);
      }
    });
    // "Use pattern" (or Enter) while a conversion is still running: keep the dialog
    // open, finish it in slices, then apply. Never finish it in one blocking go.
    idlg.querySelector('form').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok' && convertPending()) {
        e.preventDefault();
        imgState.applyWhenDone = true;
        if (!imgState.job) startConvert();
      }
    });
    idlg.addEventListener('close', () => {
      const ok = idlg.returnValue === 'ok' && imgState.result && !convertPending();
      imgState.applyWhenDone = false;
      cancelConvert();
      imgState.caches = new Map(); // match caches are only useful while the dialog is open
      if (!ok) return;
      S.focus = null;
      replaceState({ paletteId: S.paletteId, tray: S.tray, ...imgState.result }, 'Pattern created. Undo brings back the previous design.');
    });

    // keyboard
    // Remember whether focus last arrived by keyboard (Tab etc.) or by a pointer, so Space
    // can press keyboard-focused controls but still pan after a mouse click. (:focus-visible
    // can't tell: browsers switch it on as soon as any key, Space included, is pressed.)
    let lastInput = 'keyboard';
    document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
    document.addEventListener('keydown', (e) => { if (e.key !== ' ') lastInput = 'keyboard'; }, true);
    document.addEventListener('focusin', (e) => { keyboardFocus = lastInput === 'keyboard' ? e.target : null; });
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' && !$('#exportMenu').hidden) { e.preventDefault(); closeMenu(true); return; }
      if (e.key === 'Escape' && $('#fileActions').classList.contains('open')) { e.preventDefault(); setMore(false, true); return; }
      if (e.key === 'Escape' && sheetMode() && $('#sidebar').classList.contains('expanded') && !e.target.closest('dialog, input:not([type=checkbox]), textarea, select')) {
        e.preventDefault(); setSheet(false); $('#sheetToggle').focus(); return;
      }
      // Ctrl+S saves the project from anywhere, including while typing its name.
      if (!tab.editing) { if ((e.ctrlKey || e.metaKey) && k === 's') e.preventDefault(); return; } // another tab is editing
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveProject(); return; }
      if (e.target.closest('dialog')) return;
      // Text fields keep their own undo; dropdowns and checkboxes don't have one.
      const typing = e.target.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, [contenteditable]');
      if (!typing && (e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (!typing && (e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.target.closest('input, select, textarea')) return;
      // Space presses a control reached with the keyboard; after a mouse click it still pans.
      if (e.key === ' ' && e.target === keyboardFocus && e.target.closest('button, a, [role=tab], [role=slider], [tabindex]:not(#viewport)')) return;
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
    window.addEventListener('keyup', (e) => {
      if (e.key !== ' ' || !spaceDown) return;
      e.preventDefault(); // don't let the release "click" a button that kept focus after a mouse click
      spaceDown = false; viewport.classList.toggle('pan', S.tool === 'pan');
    });

    new ResizeObserver(resizeCanvas).observe(viewport);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); rebuildPixmap(); refreshPanels(); requestDraw(); });
    window.addEventListener('beforeprint', () => {
      saveBeforeDialog();
      if (!tab.editing) { $('#printRoot').innerHTML = '<section class="sheet"><div class="sheet-head"><h2>Print from the tab you are editing in</h2><div class="sheet-sub">This tab is paused, so its copy of the design may be out of date.</div></div></section>'; return; }
      if (!$('#printRoot').children.length) buildPrintSheets();
    });
    window.addEventListener('afterprint', () => { $('#printRoot').innerHTML = ''; });
    // Write the autosave right away when the tab is hidden or closed, not 0.4 s later.
    window.addEventListener('pagehide', flushAutosave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutosave(); });
  }

  function openMenu() {
    $('#exportMenu').hidden = false;
    $('[data-action=toggle-export]').setAttribute('aria-expanded', 'true');
    $('#exportMenu button').focus();
  }
  function closeMenu(returnFocus) {
    const menu = $('#exportMenu');
    if (menu.hidden) return;
    menu.hidden = true;
    const t = $('[data-action=toggle-export]');
    t.setAttribute('aria-expanded', 'false');
    if (returnFocus) t.focus();
  }

  function savePrefs() { store.set('pindou.prefs', { guides: S.guides, showCodes: S.showCodes, round: S.round, pview: S.pview, qr: S.qrExport }); }
  function setQrExport(on) {
    S.qrExport = on;
    $('[data-action=toggle-qr]').setAttribute('aria-pressed', String(on));
    savePrefs();
    if (on) currentLink();
  }

  // ---------- boot ----------
  // If the page and this script come from different versions (a browser reused a
  // cached copy after an update), say so plainly instead of half-working.
  function checkVersion() {
    const meta = document.querySelector('meta[name="pindou-version"]');
    const page = meta ? meta.content : 'unknown';
    if (page === VERSION) return;
    toast(`Pindou Studio was updated, but your browser mixed old and new files (page ${page}, script ${VERSION}). Press Ctrl+Shift+R to reload fully. Your design is safe.`, { sticky: true });
  }

  function boot() {
    readTheme();
    const prefs = store.get('pindou.prefs', {});
    if (prefs.guides != null) S.guides = prefs.guides;
    if (prefs.showCodes != null) S.showCodes = prefs.showCodes;
    if (prefs.round != null) S.round = prefs.round;
    if (prefs.pview && PALETTE_VIEWS[prefs.pview]) S.pview = prefs.pview;
    S.qrExport = prefs.qr === true;
    $('[data-action=toggle-qr]').setAttribute('aria-pressed', String(S.qrExport));
    $('#guides').value = String(S.guides); $('#showCodes').checked = S.showCodes; $('#roundBeads').checked = S.round;

    setPalette(S.paletteId);
    bind();
    const saved = store.get('pindou.autosave', null);
    let restored = false;
    if (saved) { try { loadProject(saved); restored = true; } catch { /* unreadable autosave: start fresh */ } }
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
    updateUndoButtons();
    booted = true;
    $('#status').textContent = `Pindou Studio v${VERSION}`;
    $('#menuVersion').textContent = `Pindou Studio v${VERSION}`;
    checkVersion();
    tabReady = initTabLock();
    tabReady.then(openLinkFromAddress);
  }
  let tabReady = Promise.resolve();

  // Exposed for automated tests only.
  window.__pindou = { VERSION, S, convert, serialize, parseProject, loadProject, countRegion, undo, redo, imgState, runConvert, tab, packDesign, unpackDesign, LINK_MAX, currentLink, isLocalAddress, simplifyCells, removeStrays, mergeOrder, reduceColors, simplerTries, get tabReady() { return tabReady; } };
  boot();
})();
