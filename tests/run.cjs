#!/usr/bin/env node
// Browser tests for Pindou Studio.
//
//   node tests/run.cjs            # run everything
//   node tests/run.cjs pinch      # only tests whose name contains "pinch"
//
// Needs Node and Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
// Serves the repo itself with a tiny built-in static server, so no Python is needed.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------- helpers ----------
async function open(browser, base, opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__pindou);
  await page.evaluate(() => __pindou.tabReady);
  page.errors = errors;
  page.ctx = ctx;
  return page;
}
const beads = (p) => p.evaluate(() => __pindou.S.cells.filter((v) => v >= 0).length);
async function cellPoint(p, x, y) {
  const box = await p.locator('#viewport').boundingBox();
  const v = await p.evaluate(() => ({ ...__pindou.S.view }));
  return [box.x + v.ox + (x + 0.5) * v.scale, box.y + v.oy + (y + 0.5) * v.scale];
}
async function newDesign(p, { across = 1, down = 1 } = {}) {
  await p.click('[data-action=new]');
  await p.fill('#newAcross', String(across)); await p.dispatchEvent('#newAcross', 'input');
  await p.fill('#newDown', String(down)); await p.dispatchEvent('#newDown', 'input');
  await p.click('#newDialog button[value=ok]');
  await p.waitForTimeout(100);
}
async function makeImage(p, w, h) {
  const url = await p.evaluate(([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, '#ff2a8a'); gr.addColorStop(0.5, '#f7c948'); gr.addColorStop(1, '#21c5c4');
    g.fillStyle = gr; g.fillRect(0, 0, w, h); return c.toDataURL();
  }, [w, h]);
  return { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
}
async function openFile(p, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  await p.setInputFiles('#openFile', { name: 'x.pindou.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await p.waitForTimeout(250);
}
async function pinch(p, cx, cy) {
  const cdp = await p.ctx.newCDPSession(p);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await send('touchStart', [{ x: cx - 20, y: cy, id: 1 }]);
  await send('touchStart', [{ x: cx - 20, y: cy, id: 1 }, { x: cx + 20, y: cy, id: 2 }]);
  await send('touchMove', [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }]);
  await send('touchEnd', []);
  await p.waitForTimeout(150);
}

// ---------- smoke ----------
test('smoke: draw, fill, undo/redo, save round trip', async (p) => {
  await p.mouse.move(...await cellPoint(p, 2, 2)); await p.mouse.down();
  await p.mouse.move(...await cellPoint(p, 20, 2), { steps: 5 }); await p.mouse.up();
  const stroke = await beads(p); assert(stroke === 19, `stroke placed ${stroke}`);
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 30, 30));
  eq(await beads(p), 52 * 52, 'fill');
  await p.keyboard.press('Control+z'); eq(await beads(p), 19, 'undo');
  await p.keyboard.press('Control+Shift+z'); eq(await beads(p), 52 * 52, 'redo');
  const same = await p.evaluate(() => { const a = JSON.stringify(__pindou.serialize()); __pindou.loadProject(JSON.parse(a)); return a === JSON.stringify(__pindou.serialize()); });
  assert(same, 'save/open round trip changed the design');
});
test('smoke: image import applies', async (p) => {
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 120, 60));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await p.click('#imgApply'); await p.waitForTimeout(150);
  eq(await p.evaluate(() => [__pindou.S.w, __pindou.S.h]), [52, 26], 'imported size');
});
test('smoke: phone width has no horizontal scroll', async (p) => {
  await p.setViewportSize({ width: 390, height: 800 }); await p.waitForTimeout(100);
  assert(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'page scrolls sideways');
});
test('smoke: version is consistent', async (p) => {
  const v = await p.evaluate(() => [__pindou.VERSION, document.querySelector('meta[name=pindou-version]').content, [...document.querySelectorAll('script[src],link[rel=stylesheet]')].map((e) => (e.src || e.href).split('?v=')[1])]);
  assert(v[0] === v[1] && v[2].every((x) => x === v[0]), `version mismatch ${JSON.stringify(v)}`);
});

// ---------- regressions from the pre-1.0 review ----------
test('pinch-zoom with Fill selected changes nothing', async (p) => {
  await p.click('[data-tool=fill]');
  const box = await p.locator('#viewport').boundingBox();
  await pinch(p, box.x + box.width / 2, box.y + box.height / 2);
  eq(await beads(p), 0, 'beads after pinch with Fill');
}, { ...devices['iPad Mini'] });
test('pinch-zoom with Swap selected changes nothing', async (p) => {
  await p.evaluate(() => { __pindou.S.cells.fill(__pindou.S.codeIndex.get('A1')); });
  await p.click('[data-tool=replace]');
  const box = await p.locator('#viewport').boundingBox();
  await pinch(p, box.x + box.width / 2, box.y + box.height / 2);
  eq(await p.evaluate(() => __pindou.S.cells.every((v) => v === __pindou.S.codeIndex.get('A1'))), true, 'cells unchanged');
}, { ...devices['iPad Mini'] });
test('a single tap with Fill still fills (touch)', async (p) => {
  await p.click('[data-tool=fill]');
  const [x, y] = await cellPoint(p, 10, 10);
  await p.touchscreen.tap(x, y); await p.waitForTimeout(100);
  eq(await beads(p), 52 * 52, 'beads after tap');
}, { ...devices['iPad Mini'] });
test('fill stays inside the focused tray', async (p) => {
  await newDesign(p, { across: 2 });
  await p.click('[role=tab][data-tab=trays]'); await p.click('.tray-cell >> nth=0');
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 10, 10));
  eq(await beads(p), 52 * 52, 'beads after fill in focused tray');
});
test('Space presses a focused button', async (p) => {
  await p.focus('[data-tool=fill]'); await p.keyboard.press(' ');
  eq(await p.evaluate(() => __pindou.S.tool), 'fill', 'tool after Space');
  await p.focus('[role=tab][data-tab=counts]'); await p.keyboard.press(' ');
  eq(await p.getAttribute('[role=tab][data-tab=counts]', 'aria-selected'), 'true', 'Counts tab after Space');
});
test('Enter in the New dialog creates the design', async (p) => {
  await p.click('[data-action=new]');
  await p.fill('#newW', '30'); await p.dispatchEvent('#newW', 'input'); await p.press('#newW', 'Enter');
  await p.waitForTimeout(150);
  eq(await p.evaluate(() => __pindou.S.w), 30, 'width after Enter');
});
test('Enter in the image dialog uses the pattern', async (p) => {
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 40, 40));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await p.fill('#imgW', '20'); await p.dispatchEvent('#imgW', 'input'); await p.press('#imgW', 'Enter');
  await p.waitForTimeout(400);
  eq(await p.evaluate(() => [__pindou.S.w, __pindou.S.h]), [20, 20], 'size after Enter');
});
test('Ctrl+S saves even while typing the project name', async (p) => {
  await p.focus('#projectName');
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 3000 }), p.keyboard.press('Control+s')]);
  assert(dl.suggestedFilename().endsWith('.pindou.json'), 'no project download');
});
test('a malformed file leaves the current design intact and saveable', async (p) => {
  await p.selectOption('#paletteSelect', 'mard291');
  await p.evaluate(() => { const S = __pindou.S; S.cells[0] = S.codeIndex.get('R2'); });
  await openFile(p, { format: 'pindou-studio', palette: 'mard221', w: 2, h: 1, cells: [0, 0] });
  eq(await p.evaluate(() => [__pindou.S.paletteId, __pindou.S.w, __pindou.S.palette[__pindou.S.cells[0]].code]), ['mard291', 52, 'R2'], 'state after bad file');
  await p.evaluate(() => __pindou.serialize());
  eq(p.errors, [], 'page errors');
});
test('non-integer cell values load as empty', async (p) => {
  await openFile(p, { format: 'pindou-studio', version: 1, palette: 'mard221', w: 4, h: 1, legend: ['A1', 'B5'], cells: [0.5, true, '0', null] });
  eq(await p.evaluate(() => [...__pindou.S.cells]), [-1, -1, -1, -1], 'cells');
});
test('opening a file can be undone', async (p) => {
  await p.evaluate(() => { __pindou.S.cells[5] = 3; });
  await openFile(p, { format: 'pindou-studio', version: 1, palette: 'mard221', w: 2, h: 1, legend: ['A1'], cells: [0, 0] });
  eq(await p.evaluate(() => __pindou.S.w), 2, 'opened');
  await p.keyboard.press('Control+z');
  eq(await p.evaluate(() => [__pindou.S.w, __pindou.S.cells[5]]), [52, 3], 'after undo');
});
test('switching palettes can be undone without losing colors', async (p) => {
  p.on('dialog', (d) => d.accept());
  await p.selectOption('#paletteSelect', 'mard291');
  await p.evaluate(() => { const S = __pindou.S; S.cells[0] = S.codeIndex.get('P1'); S.cells[1] = S.codeIndex.get('ZG8'); });
  await p.selectOption('#paletteSelect', 'mard221');
  await p.keyboard.press('Control+z');
  eq(await p.evaluate(() => [__pindou.S.paletteId, __pindou.S.palette[__pindou.S.cells[0]].code, __pindou.S.palette[__pindou.S.cells[1]].code, document.querySelector('#paletteSelect').value]), ['mard291', 'P1', 'ZG8', 'mard291'], 'after undo');
});
test('a lossy palette switch asks first, and Cancel keeps everything', async (p) => {
  await p.selectOption('#paletteSelect', 'mard291');
  await p.evaluate(() => { __pindou.S.cells[0] = __pindou.S.codeIndex.get('P1'); });
  let asked = false; p.once('dialog', (d) => { asked = true; d.dismiss(); });
  await p.selectOption('#paletteSelect', 'mard221'); await p.waitForTimeout(100);
  assert(asked, 'no confirmation');
  eq(await p.evaluate(() => [__pindou.S.paletteId, document.querySelector('#paletteSelect').value]), ['mard291', 'mard291'], 'after cancel');
});
test('reopening the image dialog after a palette switch cannot apply a stale result', async (p) => {
  p.on('dialog', (d) => d.accept());
  await p.selectOption('#paletteSelect', 'mard291');
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 20, 20));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await p.click('#imgApply'); await p.waitForTimeout(100);
  await p.selectOption('#paletteSelect', 'mard221');
  await p.click('[data-action=import-image]');
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await p.click('#imgApply'); await p.waitForTimeout(150);
  eq(await p.evaluate(() => __pindou.S.cells.filter((v) => v >= __pindou.S.palette.length).length), 0, 'cells past the palette');
  eq(p.errors, [], 'page errors');
});
test('clicking Use pattern right after a change applies the new settings', async (p) => {
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 40, 40));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await p.fill('#imgW', '20'); await p.dispatchEvent('#imgW', 'input');
  await p.evaluate(() => document.querySelector('#imgApply').click());
  await p.waitForTimeout(400);
  eq(await p.evaluate(() => [__pindou.S.w, __pindou.S.h]), [20, 20], 'applied size');
});
test('a custom tray size survives resize and undo', async (p) => {
  p.on('dialog', (d) => d.accept('29'));
  await p.selectOption('#traySize', 'custom'); await p.waitForTimeout(100);
  eq(await p.evaluate(() => __pindou.S.tray), 29, 'custom tray');
  await p.click('[data-action=new]'); await p.check('#newKeep');
  await p.fill('#newW', '60'); await p.dispatchEvent('#newW', 'input');
  await p.click('#newDialog button[value=ok]'); await p.waitForTimeout(100);
  eq(await p.evaluate(() => __pindou.S.tray), 29, 'tray after resize');
  await p.keyboard.press('Control+z');
  eq(await p.evaluate(() => [__pindou.S.tray, __pindou.S.w]), [29, 52], 'after undo');
});
test('autosave is written when the page is hidden', async (p) => {
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 5, 5));
  await p.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('pindou.autosave') || 'null'));
  assert(saved && saved.cells.filter((v) => v >= 0).length === 52 * 52, 'autosave not flushed');
});
test('code labels use the more readable of black or white', async (p) => {
  const bad = await p.evaluate(() => {
    const lum = (hex) => { const c = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return __pindou.S.palette.filter((c) => !c.transparent).filter((c) => {
      const L = lum(c.hex); const black = ratio(L, lum('111111')), white = ratio(L, 1);
      return (c.text === '#fff' ? white : black) < Math.max(black, white) - 1e-9;
    }).map((c) => c.code);
  });
  eq(bad, [], 'colors with the less readable label');
});
test('messages show above an open dialog and are announced', async (p) => {
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await p.waitForTimeout(300);
  const st = await p.evaluate(() => { const t = document.querySelector('#toast'); const r = t.getBoundingClientRect();
    return { role: t.getAttribute('role'), top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#toast') === t }; });
  eq(st, { role: 'status', top: true }, 'toast state');
});
test('browser print (Ctrl+P) gets the pattern sheets', async (p) => {
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await p.waitForTimeout(300);
  assert(await p.evaluate(() => document.querySelectorAll('#printRoot .sheet').length) >= 1, 'no sheets before print');
});
test('choosing a tray by keyboard keeps focus on the tray', async (p) => {
  await newDesign(p, { across: 2 });
  await p.click('[role=tab][data-tab=trays]');
  await p.focus('.tray-cell >> nth=1'); await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  eq(await p.evaluate(() => [document.activeElement.classList.contains('tray-cell'), [...document.querySelectorAll('.tray-cell')].indexOf(document.activeElement)]), [true, 1], 'focus');
});
test('export menu closes on Escape and reports its state', async (p) => {
  await p.click('[data-action=toggle-export]');
  eq(await p.getAttribute('[data-action=toggle-export]', 'aria-expanded'), 'true', 'open');
  await p.keyboard.press('Escape');
  eq(await p.evaluate(() => [document.querySelector('#exportMenu').hidden, document.querySelector('[data-action=toggle-export]').getAttribute('aria-expanded')]), [true, 'false'], 'after Escape');
  await p.click('[data-action=toggle-export]'); await p.mouse.click(5, 300);
  eq(await p.getAttribute('[data-action=toggle-export]', 'aria-expanded'), 'false', 'after outside click');
});
test('icon-only buttons have spoken names', async (p) => {
  const unnamed = await p.evaluate(() => [...document.querySelectorAll('button')].filter((b) => {
    const name = (b.getAttribute('aria-label') || b.textContent).trim();
    return !/[A-Za-z]{2,}|^[A-Z]{1,2}\d+$/.test(name); // a word, or a bead code like H7 / ZG3
  }).map((b) => b.outerHTML.slice(0, 60)));
  eq(unnamed, [], 'buttons without a word in their name');
});
test('bead counts can be chosen from the keyboard', async (p) => {
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 5, 5));
  await p.click('[role=tab][data-tab=counts]'); await p.waitForTimeout(300); // panels refresh shortly after an edit
  const n = await p.evaluate(() => document.querySelectorAll('#countBody button').length);
  assert(n >= 1, 'count rows are not buttons');
});

test('sliced image conversion matches a straight-through one and keeps the page responsive', async (p) => {
  await p.click('[data-action=import-image]');
  const url = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 500; const g = c.getContext('2d'); const d = g.createImageData(500, 500); let s = 3; for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i] = s & 255; d.data[i + 1] = (s >> 8) & 255; d.data[i + 2] = (s >> 16) & 255; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); return c.toDataURL(); });
  await p.setInputFiles('#imgFile', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled, null, { timeout: 60000 });
  const r = await p.evaluate(async () => {
    let last = performance.now(), worst = 0; const hb = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
    const el = document.querySelector('#imgW'); el.value = '300'; el.dispatchEvent(new Event('input'));
    let sawProgress = false;
    await new Promise((ok) => { const chk = () => { const t = document.querySelector('#imgStats').textContent; if (t.startsWith('Converting… ') && /\d%/.test(t)) sawProgress = true; return t.startsWith('300×') ? ok() : setTimeout(chk, 5); }; chk(); });
    clearInterval(hb);
    const sliced = __pindou.imgState.result.cells;
    const whole = __pindou.convert({ w: 300, h: 300, max: 0, owned: false, dither: false, bg: false, clear: true }).cells;
    return { worst: Math.round(worst), sawProgress, same: sliced.length === whole.length && sliced.every((v, i) => v === whole[i]) };
  });
  assert(r.same, 'sliced conversion differs from a straight-through one');
  assert(r.sawProgress, 'no progress shown while converting');
  assert(r.worst < 300, `page froze for ${r.worst} ms`);
});

// ---------- regressions from the 1.0 release review ----------
// ---------- 1.1 ----------
async function secondTab(p) {
  const t = await p.ctx.newPage();
  t.errors = []; t.on('pageerror', (e) => t.errors.push(e.message));
  await t.goto(p.url()); await t.waitForFunction(() => window.__pindou);
  await t.evaluate(() => __pindou.tabReady);
  return t;
}
const tabState = (t) => t.evaluate(() => ({ editing: __pindou.tab.editing, notice: document.querySelector('#tabDialog').open }));
const savedBeads = (t) => t.evaluate(() => { const a = JSON.parse(localStorage.getItem('pindou.autosave') || 'null'); return a ? a.cells.filter((v) => v >= 0).length : null; });
const undoLen = (t) => t.evaluate(() => __pindou.S.undo.length);
async function stroke(t, n) { // a horizontal stroke of n beads on row 2
  await t.click('[data-tool=pencil]');
  await t.mouse.move(...await cellPoint(t, 2, 2)); await t.mouse.down();
  await t.mouse.move(...await cellPoint(t, 1 + n, 2), { steps: 5 }); await t.mouse.up();
}
// Headless pages all count as visible; make one look like a background tab.
const hide = (t) => t.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });

test('a second tab is paused: no drawing, no keyboard edits, no saving; Escape cannot dismiss the notice', async (p) => {
  await stroke(p, 10); await p.waitForTimeout(500); // let the autosave land before the second tab opens
  const t2 = await secondTab(p);
  eq(await tabState(p), { editing: true, notice: false }, 'first tab');
  eq(await tabState(t2), { editing: false, notice: true }, 'second tab');
  // give the second tab an undo history of its own, then hand editing back
  await t2.click('#tabTake'); await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await t2.click('[data-tool=eraser]'); await t2.mouse.click(...await cellPoint(t2, 3, 2)); await t2.waitForTimeout(500);
  await p.click('#tabTake'); await p.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await p.waitForTimeout(100);
  eq(await t2.evaluate(() => __pindou.S.undo.length > 0), true, 'second tab has something to undo');
  for (let k = 0; k < 3; k++) await t2.keyboard.press('Escape'); // browsers let repeated Escape close a modal
  await t2.waitForTimeout(50);
  eq(await tabState(t2), { editing: false, notice: true }, 'notice after Escape ×3');
  await t2.keyboard.press('Control+z');
  eq(await beads(t2), 9, 'Ctrl+Z changed the paused tab');
  // try to change the paused tab's design and name directly, then close it
  await t2.evaluate(() => { const n = document.querySelector('#projectName'); n.value = 'from paused tab'; n.dispatchEvent(new Event('input')); });
  await t2.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('pindou.autosave')));
  assert(saved.name !== 'from paused tab', 'paused tab renamed the design');
  eq(saved.cells.filter((v) => v >= 0).length, 9, 'beads in autosave');
  eq(t2.errors, [], 'page errors');
});
test('"Edit here instead" hands over quickly with the latest work, and back again', async (p) => {
  const t2 = await secondTab(p);
  await stroke(p, 19); // and take over at once, before the first tab's autosave timer fires
  const t0 = Date.now();
  await t2.click('#tabTake');
  await t2.waitForFunction(() => !document.querySelector('#tabDialog').open);
  const ms = Date.now() - t0;
  eq(await t2.evaluate(() => __pindou.tab.lastSync), 'message', 'the design came from the hand-over message');
  assert(ms < 700, `hand-over took ${ms} ms`);
  eq(await beads(t2), 19, 'second tab has the first tab\'s stroke');
  eq(await savedBeads(t2), 19, 'autosave');
  eq(await tabState(t2), { editing: true, notice: false }, 'second tab after taking over');
  eq(await tabState(p), { editing: false, notice: true }, 'first tab after handing over');
  await t2.keyboard.press('Control+z'); eq(await beads(t2), 0, 'undo goes back to what the second tab had');
  await t2.keyboard.press('Control+Shift+z'); eq(await beads(t2), 19, 'redo');
  await t2.click('[data-tool=fill]'); await t2.mouse.click(...await cellPoint(t2, 30, 30));
  await p.click('#tabTake');
  await p.waitForFunction(() => !document.querySelector('#tabDialog').open);
  eq(await beads(p), 52 * 52, 'first tab has the second tab\'s fill');
  eq(await tabState(t2), { editing: false, notice: true }, 'second tab paused again');
  eq([...p.errors, ...t2.errors], [], 'page errors');
});
test('double-clicking "Edit here instead" cannot lose the other tab\'s work', async (p) => {
  const t2 = await secondTab(p);
  await stroke(p, 19);
  await t2.dblclick('#tabTake').catch(() => {});
  await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await t2.waitForTimeout(1500);
  eq([await beads(t2), await savedBeads(t2)], [19, 19], 'beads in the new tab and in the autosave');
});
test('a busy editing tab: the other tab waits, says why, then takes over with everything', async (p) => {
  const t2 = await secondTab(p);
  await stroke(p, 19); // not yet autosaved…
  await p.evaluate(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 4500); }, 0); }); // …and stuck for 4.5 s
  await p.waitForTimeout(50).catch(() => {});
  await t2.click('#tabTake');
  await t2.waitForTimeout(3400);
  eq(await tabState(t2), { editing: false, notice: true }, 'still waiting');
  assert(/isn't answering/.test(await t2.textContent('#tabText')), 'no explanation while waiting');
  await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open, null, { timeout: 8000 });
  eq([await beads(t2), await savedBeads(t2)], [19, 19], 'the busy tab\'s unsaved stroke arrived');
  eq(await tabState(p), { editing: false, notice: true }, 'the busy tab paused after handing over');
});
test('three tabs, two asking while the editor is busy: one editor in the end, and it saves', async (p) => {
  await stroke(p, 7);
  const b = await secondTab(p), c = await secondTab(p);
  await p.evaluate(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 4000); }, 0); });
  await p.waitForTimeout(50).catch(() => {});
  await b.click('#tabTake'); await b.waitForTimeout(200); await c.click('#tabTake');
  await b.waitForTimeout(6000);
  const editing = [];
  for (const t of [p, b, c]) editing.push(await t.evaluate(() => __pindou.tab.editing));
  eq(editing.filter(Boolean).length, 1, `tabs editing (${editing})`);
  const ed = [p, b, c][editing.indexOf(true)];
  eq(await beads(ed), 7, 'editor has the stroke');
  await ed.click('[data-tool=fill]'); await ed.mouse.click(...await cellPoint(ed, 30, 30));
  await ed.waitForTimeout(600);
  eq(await savedBeads(ed), 52 * 52, 'autosave after the fill');
  await ed.close({ runBeforeUnload: true });
  await p.waitForTimeout(800);
  eq(await savedBeads(p), 52 * 52, 'autosave after the editor closed');
});
test('if the browser refuses to autosave, the page says so, and when it works again', async (p) => {
  await p.evaluate(() => { window.__origSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
  await stroke(p, 5); await p.waitForTimeout(600);
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  assert(/won't let Pindou Studio autosave/.test(await p.textContent('#toastText')), 'no warning');
  await p.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
  await stroke(p, 6); await p.waitForTimeout(600);
  await p.waitForFunction(() => /working again/.test(document.querySelector('#toastText').textContent), null, { timeout: 3000 });
});
test('three tabs: the lock goes to the tab that asked, not another waiting tab', async (p) => {
  const b = await secondTab(p), c = await secondTab(p);
  await b.evaluate(() => { window.__toasts = []; new MutationObserver(() => window.__toasts.push(document.querySelector('#toastText').textContent)).observe(document.querySelector('#toastText'), { childList: true, characterData: true, subtree: true }); });
  await c.click('#tabTake');
  await c.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await c.waitForTimeout(300);
  eq(await b.evaluate(() => [__pindou.tab.editing, window.__toasts.length, __pindou.S.undo.length]), [false, 0, 0], 'the other waiting tab never took over');
  eq(await c.evaluate(() => __pindou.tab.lastSync), 'message', 'c got the design by message');
});
test('a stroke or fill in progress when the tab loses editing is not applied', async (p) => {
  const t2 = await secondTab(p);
  await p.click('[data-tool=fill]');
  await p.mouse.move(...await cellPoint(p, 30, 30)); await p.mouse.down();
  await t2.click('#tabTake'); await t2.waitForFunction(() => __pindou.tab.editing);
  await p.mouse.up();
  await p.click('[data-tool=pencil]').catch(() => {}); // blocked by the notice
  eq([await beads(p), await undoLen(p)], [0, 0], 'paused tab after mouse-up');
});
test('closing the editing tab lets a visible waiting tab carry on by itself', async (p) => {
  const t2 = await secondTab(p);
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 5, 5));
  await p.close({ runBeforeUnload: true });
  await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open, null, { timeout: 5000 });
  eq(await beads(t2), 52 * 52, 'waiting tab picked up the closed tab\'s work');
});
test('reloading the editing tab keeps editing there, not in a background tab', async (p) => {
  const t2 = await secondTab(p);
  await hide(t2);
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady);
  eq(await tabState(p), { editing: true, notice: false }, 'reloaded tab');
  eq(await tabState(t2), { editing: false, notice: true }, 'background tab');
});
test('closing the editing tab while a dialog is open keeps a change made just before it', async (p) => {
  const t2 = await secondTab(p);
  await stroke(p, 12);
  p.on('dialog', () => {}); // leave the prompt() open
  await p.evaluate(() => { const s = document.querySelector('#traySize'); s.value = 'custom'; setTimeout(() => s.dispatchEvent(new Event('change')), 0); }); // opens prompt() at once
  await p.waitForTimeout(150);
  await t2.click('#tabTake');
  await t2.waitForTimeout(3500); // the waiting tab says the other isn't answering; the user closes it
  await p.close({ runBeforeUnload: true }).catch(() => {});
  await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open, null, { timeout: 8000 });
  eq(await beads(t2), 12, 'stroke made just before the dialog');
});
test('if the tab that asked closes first, another visible waiting tab carries on', async (p) => {
  const b = await secondTab(p), c = await secondTab(p);
  await stroke(p, 9);
  await hide(p); // the editor is in the background
  await b.click('#tabTake');
  await b.close();
  await c.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open, null, { timeout: 6000 });
  eq(await beads(c), 9, 'the waiting tab has the work');
});
test('a drag in progress when editing moves is not applied', async (p) => {
  const t2 = await secondTab(p);
  await p.mouse.move(...await cellPoint(p, 2, 2)); await p.mouse.down();
  await p.mouse.move(...await cellPoint(p, 10, 2), { steps: 3 });
  await t2.click('#tabTake'); await t2.waitForFunction(() => __pindou.tab.editing);
  await p.mouse.move(...await cellPoint(p, 30, 2), { steps: 3 }).catch(() => {});
  await p.mouse.up().catch(() => {});
  eq([await beads(p), await undoLen(p)], [0, 0], 'paused tab after the drag');
  eq(await beads(t2), 0, 'nothing from the cancelled drag reached the new editor');
});
test('taking over ranks saved copies by generation, not by where they came from', async (p) => {
  const t2 = await secondTab(p);
  await stroke(p, 4); await p.waitForTimeout(600);
  // storage holds a copy from a newer editor than the one being handed over (stale message)
  await p.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('pindou.autosave'));
    const newer = { ...a, gen: a.gen + 5, cells: a.cells.map(() => 0), legend: [a.legend[0] || 'H7'] };
    localStorage.setItem('pindou.autosave', JSON.stringify(newer));
  });
  // and the editing tab's own copy is older: hand over without letting it save
  await p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
  await t2.click('#tabTake');
  await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  eq(await beads(t2), 52 * 52, 'the newer-generation copy won');
});
test('asking, then going back to the editing tab, cancels the request', async (p) => {
  const t2 = await secondTab(p);
  await p.evaluate(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 1200); }, 0); }); // the editor is busy…
  await p.waitForTimeout(50).catch(() => {});
  await t2.click('#tabTake');
  await hide(t2); // …and the user goes back to it before it answers
  await p.waitForTimeout(1800);
  eq([await p.evaluate(() => __pindou.tab.editing), await t2.evaluate(() => __pindou.tab.editing)], [true, false], 'still editing in the first tab');
  eq(await tabState(p), { editing: true, notice: false }, 'no notice in the first tab');
});
test('losing the tab closes an open dialog without applying it', async (p) => {
  const t2 = await secondTab(p);
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 60, 60));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  await t2.click('#tabTake');
  await p.waitForFunction(() => document.querySelector('#tabDialog').open);
  eq(await p.evaluate(() => document.querySelector('#imageDialog').open), false, 'image dialog closed');
  eq([await beads(p), await undoLen(p)], [0, 0], 'pattern not applied');
});
test('a long conversion shows a progress card; a quick one does not', async (p) => {
  await p.click('[data-action=import-image]');
  await p.evaluate(() => { window.__sawBusy = false; new MutationObserver(() => { if (!document.querySelector('#imgBusy').hidden) window.__sawBusy = true; }).observe(document.querySelector('#imgBusy'), { attributes: true }); });
  await p.setInputFiles('#imgFile', await makeImage(p, 60, 60));
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled);
  eq(await p.evaluate(() => window.__sawBusy), false, 'card flashed on a quick conversion');
  // truly random noise: every bead a new color, so nothing comes from the match cache
  const url = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 400; const g = c.getContext('2d'); const d = g.createImageData(400, 400); for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0; g.putImageData(d, 0, 0); return c.toDataURL(); });
  await p.setInputFiles('#imgFile', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await p.fill('#imgW', '400'); await p.dispatchEvent('#imgW', 'input');
  await p.waitForFunction(() => !document.querySelector('#imgBusy').hidden, null, { timeout: 10000 });
  await p.waitForFunction(() => /left|Almost done/.test(document.querySelector('#imgBusyEta').textContent), null, { timeout: 15000 });
  const v1 = await p.evaluate(() => document.querySelector('#imgProgress').value);
  await p.waitForTimeout(800);
  const v2 = await p.evaluate(() => document.querySelector('#imgProgress').value);
  assert(v2 > v1, `progress did not move (${v1} → ${v2})`);
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled && !document.querySelector('#imgStats').textContent.startsWith('Converting'), null, { timeout: 90000 });
  eq(await p.evaluate(() => [document.querySelector('#imgBusy').hidden, document.querySelector('#imgPreviewBox').hasAttribute('aria-busy')]), [true, false], 'card gone when done');
});
test('the app links to its repository in a new tab', async (p) => {
  const a = await p.evaluate(() => { const l = document.querySelector('a.repo-link'); return l && [l.href, l.target, l.rel, l.getAttribute('aria-label')]; });
  assert(a, 'no repository link');
  eq(a.slice(0, 3), ['https://github.com/dani-the-alien/pindou-studio', '_blank', 'noopener'], 'link');
  assert(/new tab/.test(a[3]), 'spoken name does not say it opens a new tab');
});
test('exported PNG and printed sheets carry the app address', async (p) => {
  await p.evaluate(() => { window.__texts = []; const f = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t, ...a) { window.__texts.push(String(t)); return f.call(this, t, ...a); }; });
  await p.click('[data-action=toggle-export]');
  const dl = p.waitForEvent('download');
  await p.click('[data-action=export-png]'); await dl;
  assert(await p.evaluate(() => window.__texts.some((t) => t.includes('dani-the-alien.github.io/pindou-studio'))), 'PNG has no address');
  // the credit is the last line, below every legend entry
  eq(await p.evaluate(() => { const i = window.__texts.findIndex((t) => t.includes('dani-the-alien.github.io')); return i === window.__texts.length - 1; }), true, 'credit drawn last, after the legend');
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const sheets = await p.evaluate(() => [...document.querySelectorAll('#printRoot .sheet')].map((s) => s.textContent.includes('dani-the-alien.github.io/pindou-studio')));
  assert(sheets.length && sheets.every(Boolean), 'a printed sheet has no address');
});
// ---------- layouts for phones, foldables and tablets ----------
// Approximate browser viewports (CSS px) for the screens we design for.
const SCREENS = {
  'foldable cover / tall phone': { width: 412, height: 780 },
  'flip phone cover screen': { width: 400, height: 330 },
  'small phone': { width: 360, height: 640 },
  'big foldable, open': { width: 790, height: 720 },
  'big foldable, open, portrait': { width: 720, height: 790 },
  'phone in landscape': { width: 860, height: 360 },
  'small phone in landscape': { width: 740, height: 360 },
  'tablet portrait': { width: 820, height: 1060 },
  'tablet landscape': { width: 1180, height: 760 },
  'older tablet portrait': { width: 768, height: 1024 },
  'narrow phone': { width: 320, height: 568 },
};
const touch = (vp) => ({ viewport: vp, isMobile: true, hasTouch: true });
const MOUSE_SCREENS = { 'narrow browser window': { width: 412, height: 780 }, 'very narrow browser window': { width: 360, height: 640 } };
// Can this element actually be tapped: on screen, not clipped by a scrolling parent,
// not covered by something else?
const tappable = (p, sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  // the whole control: its middle and points just inside each corner
  const i = Math.min(4, r.width / 4, r.height / 4);
  const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + i, r.top + i], [r.right - i, r.top + i], [r.left + i, r.bottom - i], [r.right - i, r.bottom - i]];
  return pts.every(([x, y]) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  });
}, sel);
async function openSheetIfPhone(p) {
  if (await tappable(p, '#sheetToggle') && (await p.getAttribute('#sheetToggle', 'aria-expanded')) === 'false') { await p.click('#sheetToggle'); await p.waitForTimeout(150); }
}
const ALL_SCREENS = [...Object.entries(SCREENS).map(([n, vp]) => [n, vp, touch(vp)]), ...Object.entries(MOUSE_SCREENS).map(([n, vp]) => [n, vp, { viewport: vp }])];
for (const [name, vp, opts] of ALL_SCREENS) {
  test(`layout (${name} ${vp.width}×${vp.height}): no page scroll, big canvas, everything reachable`, async (p) => {
    const f = await p.evaluate(() => {
      const v = document.querySelector('#viewport').getBoundingClientRect(), de = document.documentElement;
      return { scrolls: de.scrollWidth > innerWidth || de.scrollHeight > innerHeight, share: (v.width * v.height) / (innerWidth * innerHeight), min: Math.min(v.width, v.height) };
    });
    assert(!f.scrolls, 'the page scrolls');
    assert(f.share > 0.4, `canvas only ${Math.round(f.share * 100)}% of the screen`);
    assert(f.min >= 170, `canvas only ${Math.round(f.min)}px on its short side`);
    const tools = await p.evaluate(() => [...document.querySelectorAll('.tool')].map((b) => b.dataset.tool));
    for (const t of tools) assert(await tappable(p, `.tool[data-tool=${t}]`), `tool ${t} can't be tapped`);
    for (const sel of ['[data-action=zoom-fit]', '[data-action=undo]', '[data-action=redo]']) assert(await tappable(p, sel), `${sel} can't be tapped`);
    // file actions: in the bar, or inside the ⋯ menu
    if (!(await tappable(p, '[data-action=save]'))) {
      assert(await tappable(p, '#moreBtn'), 'neither Save nor ⋯ can be tapped');
      await p.click('#moreBtn');
      for (const a of ['new', 'import-image', 'open', 'save', 'toggle-export']) assert(await tappable(p, `[data-action=${a}]`), `${a} not in the open ⋯ menu`);
      await p.keyboard.press('Escape');
    }
    // colors: the quick row, and the full palette (opening the sheet on phones)
    const quick = await tappable(p, '#quickColors [data-q=current]');
    await openSheetIfPhone(p);
    assert(await tappable(p, '#swatches .sw'), 'the full palette shows no colors');
    assert(quick || !(await p.evaluate(() => matchMedia('(max-width: 599.98px), (max-height: 520px)').matches)), 'no quick colors on a phone');
    // the palette's own controls still exist (maybe after the swatches)
    for (const sel of ['#paletteSelect', '#paletteSearch', '#paletteFilter', '#editOwned']) {
      assert(await p.evaluate((sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel), `${sel} not shown`);
    }
    // the top bar is one row
    assert(await p.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height < 72), 'top bar wraps');
    eq(p.errors, [], 'page errors');
  }, opts);
}
test('phone: quick colors switch color and tool; recent picks come first; the sheet closes after a pick', async (p) => {
  await p.click('[data-tool=fill]'); await p.tap('#viewport');
  await p.waitForTimeout(300);
  const h7 = await p.evaluate(() => __pindou.S.codeIndex.get('H7'));
  eq(await p.evaluate(() => document.querySelector('#quickColors [data-q=current]').textContent), 'H7', 'current color first in the quick row');
  eq(await p.locator(`#quickColors [data-q="${h7}"]`).count(), 0, 'current color repeated in the quick row');
  eq(await p.evaluate(() => document.querySelector('#swatches').getBoundingClientRect().height), 0, 'palette visible while the sheet is closed');
  await p.tap('#sheetToggle');
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'true', 'sheet toggle state');
  eq(await p.getAttribute('#quickColors [data-q=current]', 'aria-expanded'), 'true', 'current color button state');
  const pick = p.locator('#swatches .sw >> nth=5');
  const code = await pick.textContent();
  await pick.tap();
  eq(await p.evaluate(() => __pindou.S.palette[__pindou.S.color].code), code, 'picked color');
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'false', 'sheet closes after a pick');
  eq(await p.evaluate(() => document.activeElement.dataset.q), 'current', 'focus stays in the quick row');
  // eraser, then a quick color: back to drawing
  await p.tap('[data-tool=eraser]');
  await p.tap(`#quickColors [data-q="${h7}"]`);
  eq(await p.evaluate(() => [__pindou.S.palette[__pindou.S.color].code, __pindou.S.tool]), ['H7', 'pencil'], 'color and tool after a quick pick');
  // the earlier pick is now right after the current color
  eq(await p.evaluate(() => document.querySelectorAll('#quickColors .sw')[1].textContent), code, 'recent pick position');
  // one Tab stop; arrows move along the row
  eq(await p.evaluate(() => [...document.querySelectorAll('#quickColors button')].filter((b) => b.tabIndex === 0).length), 1, 'tab stops in the quick row');
  await p.focus('#quickColors [data-q=current]'); await p.keyboard.press('ArrowRight');
  eq(await p.evaluate(() => document.activeElement.textContent), code, 'ArrowRight');
  // Escape closes the sheet
  await p.tap('#sheetToggle'); await p.keyboard.press('Escape');
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'false', 'Escape closes the sheet');
}, touch(SCREENS['foldable cover / tall phone']));
test('phone: a message does not cover undo or ⋯', async (p) => {
  await p.evaluate(() => { const s = document.querySelector('#paletteSelect'); s.value = 'mard291'; s.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  const overlap = await p.evaluate(() => {
    const t = document.querySelector('#toast').getBoundingClientRect();
    return ['[data-action=undo]', '#moreBtn', '#quickColors [data-q=current]', '.tool[data-tool=pencil]'].filter((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom);
    });
  });
  eq(overlap, [], 'controls under the message');
}, touch(SCREENS['foldable cover / tall phone']));
test('compact: the ⋯ menu holds the file actions, closes after one, on Escape, and when the layout changes', async (p) => {
  assert(!(await p.locator('[data-action=new]').isVisible()), 'file actions shown outside the menu');
  await p.tap('#moreBtn');
  eq(await p.getAttribute('#moreBtn', 'aria-expanded'), 'true', 'menu state');
  await p.tap('[data-action=new]');
  assert(await p.evaluate(() => document.querySelector('#newDialog').open), 'New did not open');
  eq(await p.getAttribute('#moreBtn', 'aria-expanded'), 'false', 'menu closes after an action');
  await p.click('#newDialog button[value=cancel]');
  await p.focus('#moreBtn'); await p.keyboard.press('Enter');
  assert(await p.locator('#fileActions [data-action=new]').isVisible(), 'menu did not open from the keyboard');
  await p.keyboard.press('Escape');
  eq(await p.getAttribute('#moreBtn', 'aria-expanded'), 'false', 'Escape closes the menu');
  eq(await p.evaluate(() => document.activeElement.id), 'moreBtn', 'focus back on ⋯');
  await p.tap('#moreBtn'); await p.tap('[data-action=toggle-export]');
  assert(await p.locator('[data-action=export-png]').isVisible(), 'export choices not shown');
  // a tap on the canvas only closes the menu, it doesn't draw
  { const v = await p.locator('#viewport').boundingBox(); await p.touchscreen.tap(v.x + 30, v.y + v.height / 2); } // clear of the open menu
  eq([await p.getAttribute('#moreBtn', 'aria-expanded'), await beads(p)], ['false', 0], 'canvas tap with the menu open');
  // open, then rotate to a layout without ⋯: the menu closes
  await p.tap('#moreBtn');
  await p.setViewportSize({ width: 1060, height: 820 }); await p.waitForTimeout(150);
  eq(await p.evaluate(() => document.querySelector('#fileActions').classList.contains('open')), false, 'menu left open after rotating');
}, touch(SCREENS['foldable cover / tall phone']));
test('short screens: view settings move into the ⋯ menu and still work', async (p) => {
  eq(await p.evaluate(() => !!document.querySelector('#fileActions .stage-bar')), true, 'settings in the menu');
  await p.tap('#moreBtn');
  const before = await p.evaluate(() => __pindou.S.showCodes);
  await p.tap('#showCodes');
  eq(await p.evaluate(() => __pindou.S.showCodes), !before, 'Codes toggled');
  eq(await p.getAttribute('#moreBtn', 'aria-expanded'), 'true', 'menu stays open while changing settings');
  await p.setViewportSize({ width: 412, height: 780 }); await p.waitForTimeout(150);
  eq(await p.evaluate(() => document.querySelector('.stage-bar').parentElement.className), 'stage', 'settings back in place');
  eq(await p.evaluate(() => document.querySelector('#fileActions').classList.contains('open')), false, 'menu closed when its settings moved out');
}, touch(SCREENS['flip phone cover screen']));
test('flip phone cover screen: the open sheet shows colors straight away', async (p) => {
  await p.tap('#sheetToggle'); await p.waitForTimeout(150);
  assert(await tappable(p, '#swatches .sw'), 'no swatch on screen');
  const pick = p.locator('#swatches .sw >> nth=3'); const code = await pick.textContent(); await pick.tap();
  eq(await p.evaluate(() => __pindou.S.palette[__pindou.S.color].code), code, 'picked');
  assert(await p.evaluate(() => document.querySelector('#viewport').getBoundingClientRect().height > 150), 'canvas back after the pick');
}, touch(SCREENS['flip phone cover screen']));
test('tall tablet: palette docked under the canvas, full top bar', async (p) => {
  const r = await p.evaluate(() => { const v = document.querySelector('#viewport').getBoundingClientRect(), s = document.querySelector('.sidebar').getBoundingClientRect(); return [s.top >= v.bottom - 1, s.width > innerWidth * 0.8]; });
  eq(r, [true, true], 'sidebar below and full width');
  assert(await tappable(p, '[data-action=save]'), 'Save not in the bar');
}, touch(SCREENS['tablet portrait']));
async function fold(p, vp, orientation, offset, maskLength) {
  const cdp = await p.ctx.newCDPSession(p);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: true, displayFeature: { orientation, offset, maskLength }, devicePosture: { type: 'folded' } });
  await p.waitForTimeout(300);
}
// Hinge across the screen (one segment above the other): flip phone half-open, a big
// foldable or tablet used like a little laptop.
for (const [name, vp, at] of [['flip phone', { width: 412, height: 820 }, 400], ['big foldable', { width: 720, height: 790 }, 385], ['big foldable, tabletop', { width: 790, height: 720 }, 352], ['tall tablet', { width: 820, height: 1060 }, 520]]) {
  test(`${name} half-open, hinge across: canvas above, controls below, all reachable`, async (p) => {
    await fold(p, vp, 'horizontal', at, 20);
    const r = await p.evaluate(() => {
      const seg = window.viewport.segments; const st = document.querySelector('.stage').getBoundingClientRect(), sb = document.querySelector('.sidebar').getBoundingClientRect();
      const de = document.documentElement;
      return { segs: seg.length, stageEnd: Math.round(st.bottom), sideTop: Math.round(sb.top), sideH: Math.round(sb.height), top0: seg[0].height, top1: seg[1].y, scrolls: de.scrollHeight > innerHeight || de.scrollWidth > innerWidth };
    });
    eq(r.segs, 2, 'segments');
    assert(!r.scrolls, 'the page scrolls');
    assert(r.stageEnd <= r.top0 + 1, `canvas runs past the hinge (${r.stageEnd} > ${r.top0})`);
    assert(r.sideTop >= r.top1 - 1, `controls start above the hinge (${r.sideTop} < ${r.top1})`);
    assert(r.sideH >= 120, `panels only ${r.sideH}px tall`);
    assert(await tappable(p, '#swatches .sw'), 'no swatch on screen');
    for (const t of ['pencil', 'eraser', 'fill', 'picker', 'replace', 'pan']) assert(await tappable(p, `.tool[data-tool=${t}]`), `tool ${t}`);
    assert(await tappable(p, '[data-action=zoom-fit]'), 'Fit');
  }, touch(vp));
}
test('flip phone sideways, half-open like a book: all tools reachable', async (p) => {
  await fold(p, { width: 820, height: 412 }, 'vertical', 400, 20);
  for (const t of ['pencil', 'eraser', 'fill', 'picker', 'replace', 'pan']) assert(await tappable(p, `.tool[data-tool=${t}]`), `tool ${t}`);
  assert(await tappable(p, '[data-action=zoom-fit]'), 'Fit');
  assert(await tappable(p, '#swatches .sw'), 'no swatch on screen');
}, touch({ width: 820, height: 412 }));
test('folded with the hinge across: messages appear above the hinge, clear of the tools', async (p) => {
  await fold(p, { width: 720, height: 790 }, 'horizontal', 385, 20);
  await p.evaluate(() => { const s = document.querySelector('#paletteSelect'); s.value = 'mard291'; s.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  const r = await p.evaluate(() => ({ bottom: document.querySelector('#toast').getBoundingClientRect().bottom, hinge: window.viewport.segments[0].height }));
  assert(r.bottom <= r.hinge, `message reaches ${r.bottom}, hinge at ${r.hinge}`);
}, touch({ width: 720, height: 790 }));
test('book-style foldable half-open: canvas on the left half, panels on the right', async (p) => {
  await fold(p, { width: 790, height: 720 }, 'vertical', 386, 18);
  const r = await p.evaluate(() => {
    const seg = window.viewport.segments; const st = document.querySelector('.stage').getBoundingClientRect(), sb = document.querySelector('.sidebar').getBoundingClientRect();
    return { segs: seg.length, stageEnd: Math.round(st.right), sideLeft: Math.round(sb.left), sideRight: Math.round(sb.right), w0: seg[0].width, x1: seg[1].x };
  });
  eq(r.segs, 2, 'segments');
  assert(r.stageEnd <= r.w0 + 1, `canvas runs past the hinge (${r.stageEnd} > ${r.w0})`);
  assert(r.sideLeft >= r.x1 - 1 && r.sideRight <= 791, `panels not on the right half (${r.sideLeft}–${r.sideRight})`);
  assert(await tappable(p, '#swatches .sw'), 'no swatch on screen');
}, touch({ width: 790, height: 720 }));
const inView = (p) => p.evaluate(() => {
  const S = __pindou.S, v = S.view, r = document.querySelector('#viewport').getBoundingClientRect();
  const t = S.focus ? { x: S.focus.c * S.tray, y: S.focus.r * S.tray, w: S.tray, h: S.tray } : { x: 0, y: 0, w: S.w, h: S.h };
  const x0 = v.ox + t.x * v.scale, y0 = v.oy + t.y * v.scale;
  return { fits: x0 >= -1 && y0 >= -1 && x0 + t.w * v.scale <= r.width + 1 && y0 + t.h * v.scale <= r.height + 1, fill: Math.max(t.w * v.scale / r.width, t.h * v.scale / r.height) };
});
test('a design that fit stays fitted when the screen changes size; a zoomed one keeps its zoom', async (p) => {
  assert((await inView(p)).fits, 'not fitted at start');
  await p.setViewportSize({ width: 412, height: 400 }); await p.waitForTimeout(200);
  assert((await inView(p)).fits, 'design spills off after the screen shrinks');
  await p.keyboard.press('Equal'); await p.keyboard.press('Equal');
  const s1 = await p.evaluate(() => __pindou.S.view.scale);
  await p.setViewportSize({ width: 412, height: 780 }); await p.waitForTimeout(200);
  eq(await p.evaluate(() => __pindou.S.view.scale), s1, 'zoom kept');
}, { viewport: { width: 412, height: 780 } });
test('printing does not lose the view', async (p) => {
  const before = await p.evaluate(() => ({ ...__pindou.S.view }));
  await p.emulateMedia({ media: 'print' }); await p.waitForTimeout(200);
  await p.emulateMedia({ media: 'screen' }); await p.waitForTimeout(200);
  eq(await p.evaluate(() => ({ ...__pindou.S.view })), before, 'fitted view after print');
  await p.click('[data-action=zoom-in]'); await p.click('[data-action=zoom-in]');
  const zoomed = await p.evaluate(() => ({ ...__pindou.S.view }));
  await p.emulateMedia({ media: 'print' }); await p.waitForTimeout(200);
  await p.emulateMedia({ media: 'screen' }); await p.waitForTimeout(200);
  eq(await p.evaluate(() => ({ ...__pindou.S.view })), zoomed, 'zoomed view after print');
});
test('phone: a tray picked from the sheet fills the screen once the sheet closes', async (p) => {
  await p.tap('#moreBtn'); await p.tap('[data-action=new]');
  await p.fill('#newAcross', '2'); await p.dispatchEvent('#newAcross', 'input');
  await p.fill('#newDown', '2'); await p.dispatchEvent('#newDown', 'input');
  await p.tap('#newDialog button[value=ok]'); await p.waitForTimeout(150);
  await p.tap('#sheetToggle'); await p.tap('[role=tab][data-tab=trays]'); await p.waitForTimeout(150);
  await p.tap('#trayGrid [data-tray] >> nth=0'); await p.waitForTimeout(300);
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'false', 'sheet closed');
  const v = await inView(p);
  assert(v.fits && v.fill > 0.8, `tray not fitted to the full canvas (fill ${v.fill.toFixed(2)})`);
}, touch(SCREENS['foldable cover / tall phone']));
test('printed sheets show their headings', async (p) => {
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await p.emulateMedia({ media: 'print' });
  const h = await p.evaluate(() => [...document.querySelectorAll('#printRoot .sheet h2')].map((e) => e.getBoundingClientRect().height));
  assert(h.length && h.every((x) => x > 10), `sheet headings ${JSON.stringify(h)}`);
});
test('flip phone cover screen: a message with the sheet open stays on screen, clear of the top bar, and can be dismissed', async (p) => {
  await p.tap('#sheetToggle'); await p.waitForTimeout(150);
  await p.setInputFiles('#openFile', { name: 'x.pindou.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  const r = await p.evaluate(() => { const t = document.querySelector('#toast').getBoundingClientRect(); return [t.top >= 0, t.bottom <= innerHeight, t.top >= document.querySelector('.topbar').getBoundingClientRect().bottom]; });
  eq(r, [true, true, true], 'message on screen, below the top bar');
  assert(await tappable(p, '#toastClose'), 'Dismiss cannot be tapped');
}, touch(SCREENS['flip phone cover screen']));
test('flip phone: a search and "edit my collection" set on the main screen can be undone on the cover screen', async (p) => {
  await p.tap('#sheetToggle');
  await p.fill('#paletteSearch', 'A1'); await p.dispatchEvent('#paletteSearch', 'input');
  await p.check('#editOwned');
  await p.setViewportSize(SCREENS['flip phone cover screen']); await p.waitForTimeout(200);
  if ((await p.getAttribute('#sheetToggle', 'aria-expanded')) === 'false') await p.tap('#sheetToggle');
  await p.evaluate(() => document.querySelector('#editOwned').scrollIntoView({ block: 'nearest' }));
  assert(await tappable(p, '#editOwned'), '"Edit my collection" not reachable');
  assert(await p.evaluate(() => !document.querySelector('#ownedHint').hidden && document.querySelector('#ownedHint').getBoundingClientRect().height > 0), 'edit-mode hint not shown');
  await p.evaluate(() => document.querySelector('#paletteSearch').scrollIntoView({ block: 'nearest' }));
  assert(await tappable(p, '#paletteSearch'), 'search not reachable');
}, touch(SCREENS['foldable cover / tall phone']));
test('phone: picking a recent color in the quick row with the keyboard keeps focus there', async (p) => {
  await p.tap('#sheetToggle'); await p.tap('#swatches .sw >> nth=8');
  await p.tap('#sheetToggle'); await p.tap('#swatches .sw >> nth=9');
  await p.focus('#quickColors [data-q=current]'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
  eq(await p.evaluate(() => !!document.activeElement.closest('#quickColors')), true, 'focus in the quick row');
}, touch(SCREENS['foldable cover / tall phone']));
test('rotating keeps keyboard focus somewhere useful', async (p) => {
  await p.focus('#swatches .sw');
  await p.setViewportSize({ width: 412, height: 780 }); await p.waitForTimeout(200);
  eq(await p.evaluate(() => document.activeElement.id), 'sheetToggle', 'focus after rotating to portrait');
  await p.focus('#guides'); // in the stage bar above the canvas in portrait
  eq(await p.evaluate(() => document.activeElement.id), 'guides', 'focus on Guides');
  await p.setViewportSize({ width: 780, height: 412 }); await p.waitForTimeout(200); // the bar moves into the ⋯ menu
  eq(await p.evaluate(() => document.activeElement.id), 'moreBtn', 'focus after the settings moved into ⋯');
}, touch({ width: 780, height: 412 }));
test('phone: Escape in the palette search clears the search, not the sheet', async (p) => {
  await p.tap('#sheetToggle');
  await p.fill('#paletteSearch', 'A'); await p.focus('#paletteSearch'); await p.keyboard.press('Escape');
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'true', 'sheet stays open');
}, touch(SCREENS['foldable cover / tall phone']));
test('phones in landscape: quick colors at the top of the sidebar; search, then swatches, then the other controls', async (p) => {
  assert(await tappable(p, '#quickColors [data-q=current]'), 'no quick row');
  assert(await tappable(p, '#paletteSearch'), 'search not reachable without scrolling');
  const r = await p.evaluate(() => ['#paletteSearch', '#swatches', '#paletteView'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert(r[0] < r[1] && r[1] < r[2], `order on screen ${r}`);
}, touch(SCREENS['small phone in landscape']));
test('phone sheet: search is right there, and Tab order matches what is on screen', async (p) => {
  await p.tap('#sheetToggle'); await p.waitForTimeout(150);
  assert(await tappable(p, '#paletteSearch'), 'search not reachable when the sheet opens');
  assert(await tappable(p, '#swatches .sw'), 'no swatch when the sheet opens');
  const order = await p.evaluate(() => {
    const els = ['#paletteSearch', '#swatches .sw', '#paletteView'].map((s) => document.querySelector(s));
    const dom = els.every((e, i) => i === 0 || (els[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING));
    const tops = els.map((e) => e.getBoundingClientRect().top);
    return { dom, screen: tops[0] < tops[1] && tops[1] < tops[2] };
  });
  eq(order, { dom: true, screen: true }, 'search → swatches → other controls');
}, touch(SCREENS['foldable cover / tall phone']));
test('desktop keeps the palette controls above the swatches', async (p) => {
  const r = await p.evaluate(() => ['#paletteView', '#editOwned', '#swatches'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert(r[0] < r[2] && r[1] < r[2], `order ${r}`);
});
test('flip phone half-open: the current color does not pretend to open a sheet', async (p) => {
  await fold(p, { width: 412, height: 820 }, 'horizontal', 400, 20);
  await p.tap('#quickColors [data-q=current]');
  eq([await p.getAttribute('#quickColors [data-q=current]', 'aria-expanded'), await p.evaluate(() => document.querySelector('#sidebar').classList.contains('expanded'))], [null, false], 'sheet state');
}, touch({ width: 412, height: 820 }));
test('compact: after an action from the ⋯ menu, keyboard focus comes back to ⋯', async (p) => {
  await p.focus('#moreBtn'); await p.keyboard.press('Enter');
  await p.keyboard.press('Enter'); // New (first item)
  assert(await p.evaluate(() => document.querySelector('#newDialog').open), 'New did not open');
  await p.keyboard.press('Escape');
  eq(await p.evaluate(() => document.activeElement.id), 'moreBtn', 'focus after closing the dialog');
}, { viewport: { width: 412, height: 780 } });
test('tablet: the ⋯ menu does not stay open after rotating to a layout without it', async (p) => {
  await p.click('#moreBtn');
  await p.setViewportSize({ width: 1024, height: 768 }); await p.waitForTimeout(200);
  eq(await p.evaluate(() => [document.querySelector('#fileActions').classList.contains('open'), document.querySelector('#moreBtn').getAttribute('aria-expanded')]), [false, 'false'], 'menu state');
  await p.mouse.click(500, 400); // a canvas click draws again
  assert(await beads(p) > 0, 'first canvas click after rotating was swallowed');
}, { viewport: { width: 768, height: 1024 } });
test('leaving the phone layout keeps keyboard focus on a visible control', async (p) => {
  for (const [sel, size] of [['#sheetToggle', { width: 720, height: 790 }], ['#quickColors [data-q=current]', { width: 780, height: 412 }]]) {
    await p.setViewportSize({ width: 412, height: 780 }); await p.waitForTimeout(150);
    await p.focus(sel);
    await p.setViewportSize(size); await p.waitForTimeout(200);
    assert(await p.evaluate(() => document.activeElement !== document.body && document.activeElement.getClientRects().length > 0), `focus lost after leaving the phone layout from ${sel}`);
  }
}, { viewport: { width: 412, height: 780 } });
test('low desktop window (1024×540): every tool and zoom button reachable', async (p) => {
  for (const t of ['pencil', 'eraser', 'fill', 'picker', 'replace', 'pan']) assert(await tappable(p, `.tool[data-tool=${t}]`), `tool ${t}`);
  for (const a of ['zoom-in', 'zoom-fit', 'zoom-out']) assert(await tappable(p, `[data-action=${a}]`), a);
}, { viewport: { width: 1024, height: 540 } });
test('folding and unfolding keeps keyboard focus on a visible control', async (p) => {
  const visibleFocus = () => p.evaluate(() => document.activeElement !== document.body && document.activeElement.getClientRects().length > 0);
  await p.focus('#sheetToggle');
  await fold(p, { width: 412, height: 820 }, 'horizontal', 400, 20);
  assert(await visibleFocus(), 'focus lost when folding');
  await p.focus('#swatches .sw');
  const cdp = await p.ctx.newCDPSession(p);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 820, deviceScaleFactor: 1, mobile: true });
  await p.waitForTimeout(300);
  assert(await visibleFocus(), 'focus lost when unfolding');
}, touch({ width: 412, height: 820 }));
test('book-style fold on a lower screen (960×600): zoom buttons reachable, messages in the right half', async (p) => {
  await fold(p, { width: 960, height: 600 }, 'vertical', 470, 20);
  for (const a of ['zoom-in', 'zoom-fit', 'zoom-out']) assert(await tappable(p, `[data-action=${a}]`), a);
  await p.evaluate(() => { const s = document.querySelector('#paletteSelect'); s.value = 'mard291'; s.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  const r = await p.evaluate(() => ({ left: document.querySelector('#toast').getBoundingClientRect().left, x1: window.viewport.segments[1].x }));
  assert(r.left >= r.x1, `message starts at ${r.left}, right half at ${r.x1}`);
}, { viewport: { width: 960, height: 600 } });
test('tiny cover screen (300×330): Fit still reachable', async (p) => {
  assert(await tappable(p, '[data-action=zoom-fit]'), 'Fit');
  for (const t of ['pencil', 'eraser', 'fill', 'picker', 'replace', 'pan']) assert(await tappable(p, `.tool[data-tool=${t}]`), `tool ${t}`);
}, touch({ width: 300, height: 330 }));
test('a pinch started while the ⋯ menu is open zooms and draws nothing', async (p) => {
  await p.tap('#moreBtn');
  const box = await p.locator('#viewport').boundingBox();
  const s0 = await p.evaluate(() => __pindou.S.view.scale);
  await pinch(p, box.x + 60, box.y + box.height / 2);
  eq([await beads(p), await undoLen(p)], [0, 0], 'beads and undo steps');
  assert(await p.evaluate(() => __pindou.S.view.scale) > s0, 'did not zoom');
}, touch(SCREENS['foldable cover / tall phone']));
test('"my collection" goes with editing to the other tab', async (p) => {
  const t2 = await secondTab(p);
  await p.check('#editOwned'); await p.click('#ownNone'); await p.uncheck('#editOwned');
  await t2.click('#tabTake'); await t2.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  eq(await t2.evaluate(() => __pindou.S.owned.size), 0, 'collection in the new editor');
});
test('Ctrl+P in a paused tab prints a pointer to the editing tab, not an old design', async (p) => {
  const t2 = await secondTab(p);
  await t2.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  const txt = await t2.evaluate(() => document.querySelector('#printRoot').textContent);
  assert(/Print from the tab you are editing in/.test(txt), 'paused tab printed its design');
});
test('phone: taking editing back leaves keyboard focus on a visible control', async (p) => {
  const t2 = await secondTab(p);
  await t2.click('#tabTake'); await t2.waitForFunction(() => __pindou.tab.editing);
  await p.focus('#tabTake'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await p.waitForTimeout(100);
  assert(await p.evaluate(() => document.activeElement !== document.body && document.activeElement.getClientRects().length > 0), 'focus lost');
}, { viewport: { width: 412, height: 780 } });
test('phone: the conversion progress card is on screen', async (p) => {
  await p.tap('#moreBtn'); await p.tap('[data-action=import-image]');
  const url = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 400; const g = c.getContext('2d'); const d = g.createImageData(400, 400); for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0; g.putImageData(d, 0, 0); return c.toDataURL(); });
  await p.setInputFiles('#imgFile', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await p.fill('#imgW', '400'); await p.dispatchEvent('#imgW', 'input');
  await p.waitForFunction(() => !document.querySelector('#imgBusy').hidden, null, { timeout: 10000 });
  await p.waitForTimeout(300);
  assert(await p.evaluate(() => { const r = document.querySelector('#imgBusy').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'progress card off screen');
}, touch({ width: 390, height: 780 }));
test('phone: typing a size while converting keeps the field in view', async (p) => {
  await p.tap('#moreBtn'); await p.tap('[data-action=import-image]');
  const url = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 600; const g = c.getContext('2d'); const d = g.createImageData(600, 600); for (let i = 0; i < d.data.length; i++) d.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0; g.putImageData(d, 0, 0); return c.toDataURL(); });
  await p.setInputFiles('#imgFile', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled, null, { timeout: 60000 });
  await p.evaluate(() => { document.querySelector('#imageDialog').scrollTop = 0; });
  await p.focus('#imgW'); await p.fill('#imgW', '300'); await p.dispatchEvent('#imgW', 'input');
  await p.waitForFunction(() => !document.querySelector('#imgBusy').hidden, null, { timeout: 10000 });
  await p.waitForTimeout(300);
  assert(await p.evaluate(() => { const r = document.querySelector('#imgW').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'Width field scrolled out of view');
}, touch({ width: 390, height: 780 }));
test('without Web Locks (plain http on a network address), a second tab gets a warning', async (p) => {
  const ctx = await p.context().browser().newContext();
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true }); });
  const a = await ctx.newPage(); await a.goto(p.url()); await a.waitForFunction(() => window.__pindou);
  await a.waitForTimeout(300);
  eq(await a.evaluate(() => document.querySelector('#toast').hidden), true, 'warned with only one tab');
  const b = await ctx.newPage(); await b.goto(p.url()); await b.waitForFunction(() => window.__pindou);
  for (const t of [a, b]) await t.waitForFunction(() => /can't stop them overwriting/.test(document.querySelector('#toastText').textContent), null, { timeout: 3000 });
  await ctx.close();
});
test('Space still pans after clicking a button with the mouse', async (p) => {
  await p.click('#swatches .sw >> nth=3'); // focus stays on the swatch after a mouse click
  const [x, y] = await cellPoint(p, 10, 10);
  await p.keyboard.down(' '); await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 80, y + 40, { steps: 4 }); await p.mouse.up(); await p.keyboard.up(' ');
  eq(await beads(p), 0, 'beads after Space-drag');
  await p.click('[data-tool=pencil]'); await p.mouse.click(x, y); await p.mouse.click(x + 30, y);
  await p.click('[data-action=undo]'); // focus stays on Undo
  const after = await p.evaluate(() => __pindou.S.undo.length);
  await p.keyboard.press(' ');
  eq(await p.evaluate(() => __pindou.S.undo.length), after, 'Space after clicking Undo must not undo again');
});
test('Use pattern during a conversion keeps the page responsive and applies the new settings', async (p) => {
  await p.click('[data-action=import-image]');
  const url = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 500; const g = c.getContext('2d'); const d = g.createImageData(500, 500); let s = 11; for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; d.data[i] = s & 255; d.data[i + 1] = (s >> 8) & 255; d.data[i + 2] = (s >> 16) & 255; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); return c.toDataURL(); });
  await p.setInputFiles('#imgFile', { name: 'noise.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') });
  await p.waitForFunction(() => !document.querySelector('#imgApply').disabled, null, { timeout: 60000 });
  const r = await p.evaluate(async () => {
    let last = performance.now(), worst = 0; const hb = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 5);
    // Wait for the close event, not just !open: the pattern is applied in the close
    // handler, which runs a task after the dialog stops being open.
    const closed = new Promise((ok) => document.querySelector('#imageDialog').addEventListener('close', () => setTimeout(ok, 0), { once: true }));
    const el = document.querySelector('#imgW'); el.value = '260'; el.dispatchEvent(new Event('input'));
    document.querySelector('#imgApply').click();
    await closed;
    clearInterval(hb);
    return { worst: Math.round(worst), w: __pindou.S.w };
  });
  eq(r.w, 260, 'applied width');
  assert(r.worst < 300, `page froze for ${r.worst} ms`);
});
test('cancelling the image dialog stops the conversion; a palette switch afterwards is safe', async (p) => {
  p.on('dialog', (d) => d.accept());
  await p.click('[data-action=import-image]');
  await p.setInputFiles('#imgFile', await makeImage(p, 900, 900));
  await p.fill('#imgW', '400'); await p.dispatchEvent('#imgW', 'input');
  await p.waitForTimeout(250);
  await p.click('#imageDialog button[value=cancel]');
  eq(await p.evaluate(() => !!__pindou.imgState.job), false, 'job still running after Cancel');
  await p.selectOption('#paletteSelect', 'mard291'); await p.waitForTimeout(200);
  await p.selectOption('#paletteSelect', 'mard221'); await p.waitForTimeout(200);
  eq(p.errors, [], 'page errors');
});
test('the selected swatch keeps its selection ring even when not in my collection', async (p) => {
  await p.check('#editOwned'); await p.click('#ownNone'); await p.uncheck('#editOwned');
  const style = await p.evaluate(() => { const b = document.querySelector('#swatches .sw[aria-pressed=true]'); const cs = getComputedStyle(b); return [b.classList.contains('unowned'), cs.outlineStyle, cs.outlineWidth]; });
  eq(style, [true, 'solid', '3px'], 'selected unowned swatch outline');
});
test('a warning showing before a dialog opens can still be dismissed', async (p) => {
  await openFile(p, '{"not": "a project"}');
  assert(await p.isVisible('#toastClose'), 'no sticky warning');
  await p.click('[data-action=new]');
  await p.click('#toastClose', { timeout: 2000 });
  assert(!(await p.isVisible('#toast')), 'toast still visible');
});
test('the Counts panel keeps keyboard focus when it refreshes', async (p) => {
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 5, 5));
  await p.click('[role=tab][data-tab=counts]'); await p.waitForTimeout(300);
  await p.focus('#countBody .code-btn'); await p.keyboard.press('Control+z'); await p.keyboard.press('Control+Shift+z'); await p.waitForTimeout(300);
  eq(await p.evaluate(() => document.activeElement.classList.contains('code-btn')), true, 'focus on a count button');
});
test('undoing Open brings back the previous project name', async (p) => {
  await p.fill('#projectName', 'Frog'); await p.dispatchEvent('#projectName', 'input');
  await p.click('[data-tool=pencil]');
  await openFile(p, { format: 'pindou-studio', version: 1, name: 'Cat', palette: 'mard221', w: 2, h: 1, legend: ['A1'], cells: [0, 0] });
  eq(await p.inputValue('#projectName'), 'Cat', 'name after open');
  await p.keyboard.press('Control+z');
  eq([await p.inputValue('#projectName'), await p.evaluate(() => __pindou.S.name)], ['Frog', 'Frog'], 'name after undo');
});
test('switching palettes keeps the zoom', async (p) => {
  await p.click('[data-action=zoom-in]'); await p.click('[data-action=zoom-in]');
  const z = await p.evaluate(() => __pindou.S.view.scale);
  await p.selectOption('#paletteSelect', 'mard291'); await p.waitForTimeout(100);
  eq(await p.evaluate(() => __pindou.S.view.scale), z, 'zoom after switch');
});
test('Ctrl+Z works while the palette dropdown has focus', async (p) => {
  await p.selectOption('#paletteSelect', 'mard291'); await p.waitForTimeout(100);
  await p.focus('#paletteSelect'); await p.keyboard.press('Control+z'); await p.waitForTimeout(100);
  eq(await p.evaluate(() => __pindou.S.paletteId), 'mard221', 'palette after Ctrl+Z');
});

// ---------- 1.2: sharing a design as a link ----------
async function shareUrl(p) {
  await p.click('[data-action=share-link]');
  await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  const url = await p.inputValue('#linkText');
  await p.click('#linkDialog button[value=close]');
  // the tests run on 127.0.0.1, so links point at the public site: open them here instead
  return url.replace(PUBLIC_URL, p.url().split('#')[0]);
}
const PUBLIC_URL = 'https://dani-the-alien.github.io/pindou-studio/';
async function openLink(browser, url) { // a fresh browser profile, as if someone else opened it
  const ctx = await browser.newContext();
  const t = await ctx.newPage();
  t.errors = []; t.on('pageerror', (e) => t.errors.push(e.message));
  await t.goto(url);
  await t.waitForFunction(() => window.__pindou); await t.evaluate(() => __pindou.tabReady);
  await t.waitForTimeout(300);
  t.ctx = ctx;
  return t;
}
const design = (t) => t.evaluate(() => { const { name, palette, tray, w, h, legend, cells } = __pindou.serialize(); return JSON.stringify({ name, palette, tray, w, h, legend, cells }); });
const hashOf = (t) => t.evaluate(() => location.hash);

test('share link: a design survives the trip through a link into another browser', async (p, browser) => {
  await p.fill('#projectName', 'Frog é 🐸');
  await stroke(p, 12);
  await p.click('[data-tool=fill]'); await p.mouse.click(...await cellPoint(p, 30, 30));
  const url = await shareUrl(p);
  assert(url.startsWith(p.url().split('#')[0] + '#pattern='), 'not a pattern link: ' + url.slice(0, 80));
  assert((await p.inputValue('#linkText')).startsWith(PUBLIC_URL + '#pattern='), 'a link made on 127.0.0.1 should point at the public site');
  const t = await openLink(browser, url);
  eq(await design(t), await design(p), 'design in the other browser');
  eq(await hashOf(t), '', 'pattern left in the address');
  eq(await undoLen(t), 1, 'opening is one undo step');
  eq(await t.evaluate(() => document.querySelector('#linkOpenDialog').open), false, 'asked although the design there was empty');
  await t.ctx.close();
});
test('share link: opening one over a design asks first; Keep mine changes nothing', async (p, browser) => {
  await stroke(p, 8);
  const url = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]); // someone with their own design
  await stroke(t, 3); await t.waitForTimeout(500);
  const before = await design(t);
  await t.goto(url); await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open);
  assert(/8 beads in 1 color/.test(await t.textContent('#linkOpenText')), 'dialog text: ' + await t.textContent('#linkOpenText'));
  await t.click('#linkOpenDialog button[value=keep]'); await t.waitForTimeout(200);
  eq(await design(t), before, 'design after Keep mine');
  eq(await hashOf(t), '', 'pattern left in the address');
  await t.ctx.close();
});
test('share link: Open it replaces the design in one undo step', async (p, browser) => {
  await stroke(p, 8);
  const url = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]);
  await stroke(t, 3); await t.waitForTimeout(500);
  const before = await design(t);
  await t.goto(url); await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open);
  // "goto" with only a new #fragment is a same-page navigation: the hashchange path
  await t.click('#linkOpenDialog button[value=open]'); await t.waitForTimeout(200);
  eq(await design(t), await design(p), 'design after Open it');
  await t.keyboard.press('Control+z');
  eq(await design(t), before, 'Undo');
  await t.ctx.close();
});
test('share link: Save mine, then open downloads the old design first', async (p, browser) => {
  await stroke(p, 8);
  const url = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]);
  await stroke(t, 3); await t.waitForTimeout(500);
  await t.evaluate(() => location.reload()); await t.waitForFunction(() => window.__pindou); // a fresh page (the link then comes by hashchange)
  await t.evaluate(() => __pindou.tabReady);
  const dl = t.waitForEvent('download');
  await t.evaluate((u) => { location.href = u; }, url);
  await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open);
  await t.click('#linkOpenDialog button[value=save-open]');
  const file = JSON.parse(require('fs').readFileSync(await (await dl).path(), 'utf8'));
  eq(file.cells.filter((v) => v >= 0).length, 3, 'beads in the saved file');
  await t.waitForTimeout(200);
  eq(await design(t), await design(p), 'design after opening');
  await t.ctx.close();
});
test('share link: a broken or cut-off link leaves the design alone and says so', async (p) => {
  await stroke(p, 5);
  const url = await shareUrl(p);
  const before = await design(p);
  for (const bad of [url.slice(0, url.length - 6), url.split('#')[0] + '#pattern=!!notbase64', url.split('#')[0] + '#pattern=AAAA']) {
    await p.evaluate(() => { document.querySelector('#toastText').textContent = ''; });
    await p.evaluate((u) => { location.hash = u.split('#')[1]; }, bad);
    await p.waitForFunction(() => /Couldn't open the pattern in this link/.test(document.querySelector('#toastText').textContent), null, { timeout: 3000 });
    eq(await design(p), before, 'design after ' + bad.slice(-20));
    eq(await hashOf(p), '', 'broken link left in the address');
  }
  eq(p.errors, [], 'page errors');
});
test('share link: a link that unpacks to something huge is refused, not unpacked', async (p) => {
  // 50 MB of zeros deflates to ~50 KB: well past what any real design needs
  const bomb = await p.evaluate(async () => {
    const z = new Uint8Array(await new Response(new Blob([new Uint8Array(50 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = ''; for (let i = 0; i < z.length; i += 0x8000) bin += String.fromCharCode(...z.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
  const r = await p.evaluate(async (b) => { try { await __pindou.unpackDesign(b); return 'opened'; } catch (e) { return e.message; } }, bomb);
  eq(r, 'it holds far more than any design could', 'result');
});
test('share link: values a hand-made link could hold are checked like a file', async (p) => {
  const r = await p.evaluate(async () => {
    const S = __pindou.S, code = S.palette[0].code;
    const base = { name: 'x', palette: S.paletteId, tray: 52, w: 2, h: 1, legend: [code], cells: [0, -1] };
    const tryIt = async (d) => { try { const x = await __pindou.unpackDesign(await __pindou.packDesign(d)); return Array.from(x.state.cells); } catch (e) { return e.message; } };
    return {
      ok: await tryIt(base),
      tooWide: await tryIt({ ...base, w: 5000, h: 1, cells: new Array(5000).fill(0) }),
      badIndex: await tryIt({ ...base, cells: [7, 0] }),
      unknownCode: await tryIt({ ...base, legend: ['NOPE'] }),
      otherPalette: await tryIt({ ...base, palette: 'no-such-palette' }),
    };
  });
  eq(r.ok, [0, -1], 'plain');
  eq(r.tooWide, 'its size is invalid', 'too wide');
  eq(r.badIndex, [-1, 0], 'out-of-range color left empty');
  eq(r.unknownCode, [-1, -1], 'unknown code left empty');
  eq(r.otherPalette, [0, -1], 'unknown palette falls back to the current one');
});
test('share link: given to a paused tab, it opens when that tab takes over editing', async (p) => {
  await stroke(p, 6);
  const url = await shareUrl(p);
  await stroke(p, 10); await p.waitForTimeout(500); // the editing tab moves on
  const t = await p.ctx.newPage(); t.errors = [];
  await t.goto(url); await t.waitForFunction(() => window.__pindou); await t.evaluate(() => __pindou.tabReady);
  eq(await tabState(t), { editing: false, notice: true }, 'new tab');
  assert(/pattern from your link opens here/.test(await t.textContent('#tabText')), 'notice says nothing about the link');
  assert((await hashOf(t)).startsWith('#pattern='), 'link dropped while paused');
  await t.click('#tabTake');
  await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  await t.click('#linkOpenDialog button[value=open]'); await t.waitForTimeout(200);
  eq(await t.evaluate(() => __pindou.S.cells.filter((v) => v >= 0).length), 6, 'beads from the link');
  await t.keyboard.press('Control+z');
  eq(await t.evaluate(() => __pindou.S.cells.filter((v) => v >= 0).length), 10, 'Undo gives the other tab\'s latest work');
});
test('share link: the address switch follows edits, survives a reload, and needs no question', async (p) => {
  await stroke(p, 4);
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  await p.check('#linkLive'); await p.click('#linkDialog button[value=close]');
  await p.waitForFunction(() => location.hash.startsWith('#pattern='));
  const first = await hashOf(p);
  await p.click('[data-tool=pencil]'); await p.mouse.click(...await cellPoint(p, 20, 20));
  await p.waitForFunction((h) => location.hash !== h && location.hash.startsWith('#pattern='), first, { timeout: 3000 });
  const d = await p.evaluate(async () => __pindou.unpackDesign(location.hash.slice(9)).then((x) => x.state.cells.filter((v) => v >= 0).length));
  eq(d, 5, 'beads in the address');
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady); await p.waitForTimeout(300);
  eq(await p.evaluate(() => document.querySelector('#linkOpenDialog').open), false, 'asked about its own design after a reload');
  assert((await hashOf(p)).startsWith('#pattern='), 'address lost on reload');
  eq(await beads(p), 5, 'beads after reload');
  // turning it off takes the design out of the address
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  eq(await p.isChecked('#linkLive'), true, 'switch remembered in this tab');
  await p.uncheck('#linkLive'); await p.click('#linkDialog button[value=close]');
  eq(await hashOf(p), '', 'address after switching off');
});
test('share link: with the address switch on, handing editing to another tab clears this address', async (p) => {
  await stroke(p, 4);
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  await p.check('#linkLive'); await p.click('#linkDialog button[value=close]');
  await p.waitForFunction(() => location.hash.startsWith('#pattern='));
  const t = await p.ctx.newPage(); await t.goto(p.url().split('#')[0]); await t.waitForFunction(() => window.__pindou); await t.evaluate(() => __pindou.tabReady);
  await t.click('#tabTake'); await t.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await p.waitForTimeout(200);
  eq(await hashOf(p), '', 'paused tab still shows an old copy in its address');
  eq(await beads(t), 4, 'design in the new editing tab');
});
test('share link: phone: Share is in the ⋯ menu and the dialog fits', async (p) => {
  await stroke(p, 4);
  await p.tap('#moreBtn'); await p.tap('[data-action=share-link]');
  await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  for (const s of ['#linkCopy', '#linkLive', '#linkDialog button[value=close]']) assert(await tappable(p, s), s + ' not tappable');
  assert(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'page scrolls sideways');
}, touch({ width: 360, height: 640 }));

async function switchOn(p) {
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  await p.check('#linkLive'); await p.click('#linkDialog button[value=close]');
  await p.waitForFunction(() => location.hash.startsWith('#pattern='));
}
const reloaded = async (p) => { await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady); await p.waitForTimeout(400); };
test('share link: reloading right after an edit, with the address switch on, keeps the latest work', async (p) => {
  await stroke(p, 4); await switchOn(p);
  await p.click('[data-tool=pencil]'); await p.mouse.click(...await cellPoint(p, 20, 20));
  await p.reload(); await reloaded(p); // before the address has caught up
  eq(await p.evaluate(() => document.querySelector('#linkOpenDialog').open), false, 'asked about its own older copy');
  eq(await beads(p), 5, 'beads after reload');
  await p.waitForFunction(async () => { const h = location.hash.slice(9); return h && (await __pindou.unpackDesign(h)).state.cells.filter((v) => v >= 0).length === 5; }, null, { timeout: 3000 });
  // and when the newer state is empty, the older copy isn't opened silently either
  await newDesign(p);
  await p.reload(); await reloaded(p);
  eq(await beads(p), 0, 'beads after clearing and reloading');
  assert(!/from a link/.test(await p.textContent('#toastText')), 'opened its own old copy');
});
test('share link: a second link while the question is open replaces the question', async (p, browser) => {
  await stroke(p, 8); const a = await shareUrl(p);
  await stroke(p, 12); const b = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]);
  await stroke(t, 3); await t.waitForTimeout(500);
  await t.goto('about:blank'); await t.goto(a); // a real page load with the link
  await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  assert(/8 beads/.test(await t.textContent('#linkOpenText')), 'first question');
  eq(await t.evaluate(() => document.activeElement.value), 'keep', 'focus starts on Keep mine');
  await t.evaluate((u) => { location.hash = u.split('#')[1]; }, b);
  await t.waitForFunction(() => /12 beads/.test(document.querySelector('#linkOpenText').textContent) && document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  await t.click('#linkOpenDialog button[value=open]'); await t.waitForTimeout(300);
  eq(await beads(t), 12, 'beads opened');
  eq(await hashOf(t), '', 'address');
  await t.ctx.close();
});
test('share link: a link arriving with the Share dialog open closes it first', async (p, browser) => {
  await stroke(p, 8); const a = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]);
  await stroke(t, 3);
  await t.click('[data-action=share-link]'); await t.waitForFunction(() => document.querySelector('#linkDialog').open);
  await t.evaluate((u) => { location.hash = u.split('#')[1]; }, a);
  await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  eq(await t.evaluate(() => document.querySelector('#linkDialog').open), false, 'Share dialog with the old link still open');
  await t.ctx.close();
});
test('share link: a browser that can\'t unzip keeps the link in the address and says so', async (p, browser) => {
  await stroke(p, 8); const a = await shareUrl(p);
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { delete window.DecompressionStream; delete window.CompressionStream; });
  const t = await ctx.newPage(); await t.goto(a); await reloaded(t);
  assert(/too old to open pattern links/.test(await t.textContent('#toastText')), 'no message');
  assert((await hashOf(t)).startsWith('#pattern='), 'link removed from the address');
  await t.click('[data-action=share-link]'); await t.waitForTimeout(200);
  eq(await t.evaluate(() => document.querySelector('#linkDialog').open), false, 'offered a link it can\'t make');
  await ctx.close();
});
test('share link: a link arriving while a paused tab is already taking over leaves it waiting', async (p) => {
  await stroke(p, 4); const a = await shareUrl(p);
  const t = await secondTab(p);
  await p.evaluate(() => { __pindou.tab.chan.onmessage = null; }); // the editing tab stops answering
  await t.click('#tabTake'); await t.waitForTimeout(100);
  eq(await t.evaluate(() => __pindou.tab.state), 'taking', 'state');
  await t.evaluate((u) => { location.hash = u.split('#')[1]; }, a); await t.waitForTimeout(200);
  eq(await t.evaluate(() => document.querySelector('#tabTake').getAttribute('aria-disabled')), 'true', 'button enabled again');
  eq(await t.textContent('#tabTakeLabel'), 'Taking over…', 'label');
});

test('share link: a bookmarked design opened in a tab that has since paused still asks to open', async (p) => {
  await stroke(p, 4); await switchOn(p);
  const bookmark = p.url(); // the design as bookmarked
  const t = await secondTab(p);
  await t.click('#tabTake'); await t.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await t.click('[data-tool=pencil]'); for (const x of [30, 31, 32]) await t.mouse.click(...await cellPoint(t, x, 30));
  await t.waitForTimeout(500);
  await p.evaluate((u) => { location.hash = u.split('#')[1]; }, bookmark); await p.waitForTimeout(200);
  assert(/pattern from your link opens here/.test(await p.textContent('#tabText')), 'link not noticed in the paused tab');
  await p.click('#tabTake');
  await p.waitForFunction(() => document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  await p.click('#linkOpenDialog button[value=open]'); await p.waitForTimeout(200);
  eq(await beads(p), 4, 'beads from the bookmark');
});
test('share link: a tab that loses editing while unpacking a link doesn\'t ask over the pause notice', async (p) => {
  await stroke(p, 4); const a = await shareUrl(p);
  const t = await secondTab(p);
  await t.click('#tabTake'); await t.waitForFunction(() => __pindou.tab.editing && !document.querySelector('#tabDialog').open);
  await t.click('[data-tool=pencil]'); await t.mouse.click(...await cellPoint(t, 30, 30)); await t.waitForTimeout(400);
  // slow the unzip down so the other tab can take over in the middle of it
  await t.evaluate(() => {
    const D = window.DecompressionStream;
    window.DecompressionStream = class { constructor(f) { const d = new D(f); this.writable = d.writable; this.readable = d.readable.pipeThrough(new TransformStream({ async transform(c, ctl) { await new Promise((r) => setTimeout(r, 1500)); ctl.enqueue(c); } })); } };
  });
  await t.evaluate((u) => { location.hash = u.split('#')[1]; }, a);
  await t.waitForTimeout(100);
  await p.click('#tabTake'); await p.waitForFunction(() => __pindou.tab.editing);
  await t.waitForTimeout(2000);
  eq(await t.evaluate(() => [__pindou.tab.editing, document.querySelector('#linkOpenDialog').open]), [false, false], '[editing, asking]');
  assert((await hashOf(t)).startsWith('#pattern='), 'link dropped');
});
test('share link: going Back while the question is open drops the question', async (p, browser) => {
  await stroke(p, 8); const a = await shareUrl(p);
  const t = await openLink(browser, p.url().split('#')[0]);
  await stroke(t, 3);
  await t.evaluate((u) => { location.hash = u.split('#')[1]; }, a);
  await t.waitForFunction(() => document.querySelector('#linkOpenDialog').open, null, { timeout: 5000 });
  await t.goBack(); await t.waitForTimeout(300);
  eq(await t.evaluate(() => document.querySelector('#linkOpenDialog').open), false, 'question still open');
  eq(await beads(t), 3, 'beads');
  await t.ctx.close();
});
test('share link: the address switch turns itself off when the design grows too big for a link', async (p) => {
  await stroke(p, 4); await switchOn(p);
  await p.evaluate(() => {
    const pal = __pindou.S.palette, w = 300, h = 300;
    window.__big = { format: 'pindou-studio', version: 1, name: 'noise', palette: __pindou.S.paletteId, tray: 52, w, h, legend: pal.map((c) => c.code), cells: Array.from({ length: w * h }, () => (Math.random() * pal.length) | 0) };
  });
  await openFile(p, await p.evaluate(() => JSON.stringify(window.__big)));
  await p.waitForFunction(() => /is off/.test(document.querySelector('#toastText').textContent), null, { timeout: 5000 });
  eq(await hashOf(p), '', 'address');
  eq(await p.evaluate(() => sessionStorage.getItem('pindou.linkLive')), null, 'switch still on');
});
test('share link: a link from a newer version stays in the address', async (p) => {
  const data = await p.evaluate(async () => {
    const z = new Uint8Array(await new Response(new Blob([new Uint8Array([9, 0, 0])]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    return btoa(String.fromCharCode(...z)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
  await p.evaluate((d) => { location.hash = 'pattern=' + d; }, data);
  await p.waitForFunction(() => /newer version/.test(document.querySelector('#toastText').textContent), null, { timeout: 3000 });
  eq(await hashOf(p), '#pattern=' + data, 'address');
});
test('opening a file or link with many unknown codes lists only some of them', async (p) => {
  await openFile(p, { format: 'pindou-studio', version: 1, name: 'x', palette: 'mard-221', tray: 52, w: 2, h: 1, legend: Array.from({ length: 500 }, (_, i) => 'Z' + i), cells: [0, 1] });
  const txt = await p.textContent('#toastText');
  assert(/and 480 more/.test(txt) && txt.length < 600, 'message: ' + txt.slice(0, 120) + '… (' + txt.length + ' chars)');
});

// ---------- 1.3: QR codes ----------
// Decode a canvas (or an image's data URL) on the page with jsQR (tests/vendor, test-only).
async function decodeQr(p, how) {
  if (!(await p.evaluate(() => !!window.jsQR))) await p.addScriptTag({ path: path.join(ROOT, 'tests/vendor/jsQR.js') });
  return p.evaluate(async (how) => {
    let c;
    if (how.selector) c = document.querySelector(how.selector);
    else {
      const img = new Image(); img.src = how.dataUrl; await img.decode();
      c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      if (how.crop) { const d = g.getImageData(...how.crop); c.width = how.crop[2]; c.height = how.crop[3]; g.putImageData(d, 0, 0); }
    }
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const r = jsQR(d.data, d.width, d.height);
    return r ? r.data : null;
  }, how);
}
const noisy = (p, n) => p.evaluate((n) => {
  const pal = __pindou.S.palette;
  __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'noise', palette: __pindou.S.paletteId, tray: 52, w: n, h: n, legend: pal.map((c) => c.code), cells: Array.from({ length: n * n }, () => (Math.random() * pal.length) | 0) });
}, n);

test('QR: the Share dialog shows a QR code that scans to the exact link', async (p) => {
  await stroke(p, 9);
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  eq(await p.evaluate(() => document.querySelector('#linkQrBox').hidden), true, 'QR shown before asking');
  await p.click('#linkQrBtn');
  // decode what's on the screen, not the canvas's own pixels
  const shot = await p.locator('#linkQrBox canvas').screenshot();
  eq(await decodeQr(p, { dataUrl: 'data:image/png;base64,' + shot.toString('base64') }), await p.inputValue('#linkText'), 'decoded QR on screen');
  assert(await tappable(p, '#linkQrBtn'), 'button not tappable');
  await p.click('#linkQrBtn');
  eq(await p.evaluate(() => document.querySelector('#linkQrBox').hidden), true, 'Hide QR code');
});
test('QR: a link too long for a QR code says so instead', async (p) => {
  await noisy(p, 60); // a link of several thousand characters: fits a link, not a QR code
  await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  const len = (await p.inputValue('#linkText')).length;
  assert(len > 3000 && len < 32000, 'test design gave a link of ' + len);
  eq([await p.isDisabled('#linkQrBtn'), await p.textContent('#linkQrBtn')], [true, 'Too long for a QR code'], 'button');
});
test('QR: the export toggle stays in the menu, is remembered, and says whether it is on', async (p) => {
  await p.click('[data-action=toggle-export]');
  await p.click('[data-action=toggle-qr]');
  eq(await p.evaluate(() => !document.querySelector('#exportMenu').hidden), true, 'menu closed by the toggle');
  eq(await p.getAttribute('[data-action=toggle-qr]', 'aria-pressed'), 'true', 'pressed');
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady);
  eq(await p.getAttribute('[data-action=toggle-qr]', 'aria-pressed'), 'true', 'after reload');
});
test('QR: with the toggle on, the PNG export carries a QR code of the design\'s link', async (p) => {
  await stroke(p, 9);
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]');
  const dl = p.waitForEvent('download');
  await p.click('[data-action=export-png]');
  const buf = require('fs').readFileSync(await (await dl).path());
  const want = await p.evaluate(() => __pindou.currentLink());
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  // the QR sits at the bottom left, above the credit line
  const size = await p.evaluate(async (u) => { const i = new Image(); i.src = u; await i.decode(); return [i.width, i.height]; }, dataUrl);
  const got = await decodeQr(p, { dataUrl, crop: [0, Math.round(size[1] * 0.55), size[0], size[1] - Math.round(size[1] * 0.55)] });
  eq(got, want, 'decoded QR in the PNG');
  // and it opens this design
  const d = await p.evaluate(async (u) => (await __pindou.unpackDesign(u.split('#pattern=')[1])).state.cells.filter((v) => v >= 0).length, got);
  eq(d, 9, 'beads in the QR\'s design');
});
test('QR: a PNG export whose link is too long for a QR code says so and has none', async (p) => {
  await noisy(p, 60);
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]');
  const dl = p.waitForEvent('download');
  await p.click('[data-action=export-png]'); await dl;
  assert(/too long for a QR code/.test(await p.textContent('#toastText')), 'no message');
});
test('QR: printing with the toggle on adds a last page whose QR code opens the design', async (p) => {
  await stroke(p, 9);
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]');
  await p.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await p.click('[data-action=print-trays]');
  await p.waitForFunction(() => window.__printed);
  const last = await p.evaluate(() => { const s = [...document.querySelectorAll('#printRoot .sheet')].pop(); return { qr: !!s.querySelector('canvas.sheet-qr'), w: s.querySelector('canvas.sheet-qr')?.style.width }; });
  eq(last.qr, true, 'QR page');
  assert(/mm$/.test(last.w) && parseFloat(last.w) >= 40, 'printed size ' + last.w);
  eq(await decodeQr(p, { selector: '#printRoot .sheet:last-child canvas.sheet-qr' }), await p.evaluate(() => __pindou.currentLink()), 'decoded');
  // without the toggle, no QR page
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]');
  await p.click('[data-action=print-trays]');
  eq(await p.evaluate(() => !!document.querySelector('#printRoot canvas.sheet-qr')), false, 'QR page with the toggle off');
});
test('QR: Ctrl+P straight after an edit never prints an out-of-date QR code', async (p) => {
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]'); await p.keyboard.press('Escape');
  await stroke(p, 5); await p.waitForTimeout(1200); // link for 5 beads is ready
  await p.click('[data-tool=pencil]'); await p.mouse.click(...await cellPoint(p, 30, 30)); // now 6
  await p.evaluate(() => { document.querySelector('#printRoot').innerHTML = ''; window.dispatchEvent(new Event('beforeprint')); });
  const qrNow = await p.evaluate(() => !!document.querySelector('#printRoot canvas.sheet-qr'));
  if (qrNow) {
    const got = await decodeQr(p, { selector: '#printRoot canvas.sheet-qr' });
    const n = await p.evaluate(async (u) => (await __pindou.unpackDesign(u.split('#pattern=')[1])).state.cells.filter((v) => v >= 0).length, got);
    eq(n, 6, 'QR printed for an older design');
  } else assert(/still being made/.test(await p.textContent('#printRoot')), 'no QR and no explanation');
});

test('QR: renaming the design updates the link the QR codes carry', async (p) => {
  await stroke(p, 3);
  const before = await p.evaluate(() => __pindou.currentLink());
  await p.fill('#projectName', 'Renamed swallow');
  const after = await p.evaluate(() => __pindou.currentLink());
  assert(before !== after, 'link unchanged by the rename');
  eq(await p.evaluate(async (u) => (await __pindou.unpackDesign(u.split('#pattern=')[1])).name, after), 'Renamed swallow', 'name in the link');
});

for (const [label, opts, beadsN] of [['a long link, normal screen', {}, 0], ['a long link, high-density phone screen', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 }, 0]]) {
  test(`QR: the Share dialog's code scans from the screen (${label})`, async (p) => {
    // a ~2,000+ character link: a dense code, where uneven module sizes stop it scanning
    await p.evaluate(() => {
      const pal = __pindou.S.palette, n = 62;
      __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'dense', palette: __pindou.S.paletteId, tray: 52, w: n, h: n, legend: pal.slice(0, 12).map((c) => c.code), cells: Array.from({ length: n * n }, () => (Math.random() * 12) | 0) });
    });
    if (opts.viewport) { await p.tap('#moreBtn'); await p.tap('[data-action=share-link]'); } else await p.click('[data-action=share-link]');
    await p.waitForFunction(() => document.querySelector('#linkDialog').open);
    const link = await p.inputValue('#linkText');
    assert(link.length > 1800 && link.length < 2900, 'test link is ' + link.length);
    await p.click('#linkQrBtn');
    const shot = await p.locator('#linkQrBox canvas').screenshot();
    eq(await decodeQr(p, { dataUrl: 'data:image/png;base64,' + shot.toString('base64') }), link, 'decoded QR on screen');
  }, opts.viewport ? { ...opts, hasTouch: true, isMobile: true } : opts);
}
test('QR: once the link is ready, Ctrl+P prints a QR of the current design (after an edit, and after a reload)', async (p) => {
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]'); await p.keyboard.press('Escape');
  const printed = async () => {
    await p.evaluate(() => { document.querySelector('#printRoot').innerHTML = ''; window.dispatchEvent(new Event('beforeprint')); });
    const got = await decodeQr(p, { selector: '#printRoot canvas.sheet-qr' });
    assert(got, 'no QR printed');
    return p.evaluate(async (u) => (await __pindou.unpackDesign(u.split('#pattern=')[1])).state.cells.filter((v) => v >= 0).length, got);
  };
  await stroke(p, 7); await p.waitForTimeout(1500);
  eq(await printed(), 7, 'beads in the printed QR after an edit');
  await p.waitForTimeout(500); // autosave
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady); await p.waitForTimeout(1500);
  eq(await printed(), 7, 'beads in the printed QR after a reload');
});
test('QR: a double click on Print opens one print dialog', async (p) => {
  await p.click('[data-action=toggle-export]'); await p.click('[data-action=toggle-qr]');
  await p.evaluate(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await stroke(p, 4);
  await p.evaluate(() => { const b = document.querySelector('[data-action=print-trays]'); b.click(); b.click(); });
  await p.waitForTimeout(800);
  eq(await p.evaluate(() => window.__prints), 1, 'print dialogs');
});
test('QR: the export toggle is announced by its words, not the box drawn before them', async (p) => {
  await p.click('[data-action=toggle-export]');
  eq(await p.getByRole('button', { name: 'Add a QR code (PNG & print)', exact: true }).count(), 1, 'button with that exact name');
});
test('share link: addresses that only work on this computer are recognised', async (p) => {
  const r = await p.evaluate(() => {
    const host = (u) => new URL(u).hostname;
    return ['http://localhost:8000/', 'http://127.0.0.1:8000/', 'http://127.1/', 'http://0.0.0.0:8000/', 'http://pindou.localhost/', 'http://[::1]:8000/', 'http://[::ffff:127.0.0.1]/', 'http://[::]:8000/',
      'https://dani-the-alien.github.io/pindou-studio/', 'http://192.168.1.20:8000/', 'https://example.com/']
      .map((u) => __pindou.isLocalAddress(host(u), 'http:'));
  });
  eq(r, [true, true, true, true, true, true, true, true, false, false, false], 'local?');
});
test('QR: a stroke that gets cancelled (pinch, hand-over) leaves no beads in the QR link', async (p) => {
  await stroke(p, 3);
  await p.click('[data-tool=pencil]');
  await p.mouse.move(...await cellPoint(p, 2, 10)); await p.mouse.down();
  await p.mouse.move(...await cellPoint(p, 12, 10), { steps: 6 });
  await p.evaluate(() => __pindou.currentLink()); // a link made mid-stroke
  await p.evaluate(() => { const v = document.querySelector('#viewport'); v.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })); });
  await p.mouse.up();
  eq(await beads(p), 3, 'beads after the cancelled stroke');
  const n = await p.evaluate(async () => (await __pindou.unpackDesign((await __pindou.currentLink()).split('#pattern=')[1])).state.cells.filter((v) => v >= 0).length);
  eq(n, 3, 'beads in the QR link');
});
// ---------- 1.3: a simpler version for long links ----------
const shareOpen = async (p) => { await p.click('[data-action=share-link]'); await p.waitForFunction(() => document.querySelector('#linkDialog').open); };
const simpleReady = (p) => p.waitForFunction(() => /characters|too long/.test(document.querySelector('#linkSimpleLen').textContent), null, { timeout: 20000 });
// a converted-looking design: smooth regions with speckled edges and many colors
const speckled = (p, n) => p.evaluate((n) => {
  const pal = __pindou.S.palette, cells = new Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const base = Math.floor((x / n) * 8) * 6 + Math.floor((y / n) * 6);
    cells[y * n + x] = Math.random() < 0.15 ? (Math.random() * pal.length) | 0 : base % pal.length;
  }
  __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'speckled', palette: __pindou.S.paletteId, tray: 52, w: n, h: n, legend: pal.map((c) => c.code), cells });
}, n);

test('short links: a short link offers no simpler version', async (p) => {
  await stroke(p, 6); await shareOpen(p);
  eq(await p.evaluate(() => document.querySelector('#linkSimpler').hidden), true, 'simpler section shown');
});
test('short links: a long link offers a simpler version that fits, without changing the design', async (p, browser) => {
  await speckled(p, 80);
  const before = await design(p);
  await shareOpen(p);
  eq(await p.evaluate(() => document.querySelector('#linkSimpler').hidden), false, 'no simpler section');
  const origLen = (await p.inputValue('#linkText')).length;
  assert(origLen > 2000, 'test design gave a short link: ' + origLen);
  await simpleReady(p);
  await p.check('#linkWhichSimple');
  const simple = await p.inputValue('#linkText');
  assert(simple.length <= 2000, 'suggested version is ' + simple.length + ' characters');
  eq(await design(p), before, 'design changed by choosing the simpler link');
  // the simpler link opens the simpler design elsewhere
  const t = await openLink(browser, simple.replace(PUBLIC_URL, p.url().split('#')[0]));
  const colors = await t.evaluate(() => new Set(__pindou.S.cells.filter((v) => v >= 0 && !__pindou.S.palette[v].transparent)).size);
  eq(String(colors), (await p.textContent('#linkSimpleLen')).match(/(\d+) colors?/)[1], 'colors in the opened simpler design');
  await t.ctx.close();
  // back to the original
  await p.check('#linkWhichOrig');
  eq((await p.inputValue('#linkText')).length, origLen, 'original link again');
});
test('short links: the colors slider and clean-up switch change the link', async (p) => {
  await speckled(p, 80);
  await shareOpen(p); await simpleReady(p); await p.check('#linkWhichSimple');
  const a = (await p.inputValue('#linkText')).length;
  const newLink = (prev) => p.waitForFunction((prev) => { const v = document.querySelector('#linkText').value; return v && v.length !== prev; }, prev, { timeout: 10000 });
  await p.fill('#linkColors', '2'); await newLink(a);
  const b = (await p.inputValue('#linkText')).length;
  eq(await p.textContent('#linkColorsOut'), '2', 'colors shown');
  eq(await p.evaluate(async () => new Set((await __pindou.unpackDesign(document.querySelector('#linkText').value.split('#pattern=')[1])).state.cells.filter((v) => v >= 0 && !__pindou.S.palette[v].transparent)).size), 2, 'colors in the link');
  await p.uncheck('#linkClean'); await newLink(b);
  assert((await p.inputValue('#linkText')).length > b, 'clean-up off should make a longer link');
});
test('short links: a design too detailed for any link can still share a simpler version', async (p) => {
  await p.evaluate(() => {
    const pal = __pindou.S.palette; const w = 300, h = 300;
    __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'noise', palette: __pindou.S.paletteId, tray: 52, w, h, legend: pal.map((c) => c.code), cells: Array.from({ length: w * h }, () => (Math.random() * pal.length) | 0) });
  });
  await shareOpen(p);
  eq(await p.isDisabled('#linkWhichOrig'), true, 'the too-long original offered');
  eq(await p.isChecked('#linkWhichSimple'), true, 'simpler version not chosen');
  await simpleReady(p);
  const url = await p.inputValue('#linkText');
  assert(url.length > 0 && url.length <= await p.evaluate(() => __pindou.LINK_MAX), 'link ' + url.length);
});
test('short links: "use it in my design too" is one undo step', async (p) => {
  await speckled(p, 80);
  const before = await design(p);
  await shareOpen(p); await simpleReady(p); await p.check('#linkWhichSimple');
  const simpleLink = await p.inputValue('#linkText');
  await p.click('#linkApply');
  await p.waitForFunction(() => document.querySelector('#linkDialog').open);
  await p.waitForTimeout(300);
  const now = await p.evaluate(() => new Set(__pindou.S.cells.filter((v) => v >= 0)).size);
  eq(String(now), await p.evaluate(async (u) => String(new Set((await __pindou.unpackDesign(u.split('#pattern=')[1])).state.cells.filter((v) => v >= 0)).size), simpleLink), 'design now uses the simpler version');
  await p.click('#linkDialog button[value=close]');
  await p.keyboard.press('Control+z');
  eq(await design(p), before, 'Undo');
});
test('short links: stray single beads are removed, lines and blocks are kept', async (p) => {
  const r = await p.evaluate(() => {
    // 5×5 of color 0, with a lone bead of 1 in the middle, and a 2-bead line of 2 at the top
    const w = 5, h = 5, c = new Array(25).fill(0);
    c[12] = 1; c[1] = 2; c[2] = 2;
    return Array.from(__pindou.removeStrays(Int16Array.from(c), w, h));
  });
  eq(r[12], 0, 'lone bead');
  eq([r[1], r[2]], [2, 2], 'two touching beads');
});
test('short links: the suggestion is the most colors that fit, even when fewer colors make a longer link', async (p) => {
  // specks two beads wide (clean-up keeps them), in many colors: all of them don't fit
  await p.evaluate(() => {
    const pal = __pindou.S.palette.filter((c) => !c.transparent), n = 120, cells = new Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells[y * n + x] = (Math.floor((x / n) * 6) * 5 + Math.floor((y / n) * 5)) % pal.length;
    for (let k = 0; k < 400; k++) { const x = (Math.random() * (n - 2)) | 0, y = (Math.random() * (n - 2)) | 0, v = (Math.random() * pal.length) | 0; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) cells[(y + dy) * n + x + dx] = v; }
    __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'blobs', palette: __pindou.S.paletteId, tray: 52, w: n, h: n, legend: pal.map((c) => c.code), cells });
  });
  await shareOpen(p); await simpleReady(p); await p.check('#linkWhichSimple');
  const k = +(await p.textContent('#linkColorsOut'));
  assert(k < +(await p.getAttribute('#linkColors', 'max')), 'every color already fit: nothing to search');
  const len = (await p.inputValue('#linkText')).length;
  assert(len <= 2000, 'suggested link ' + len);
  // every count the search tries above k makes a link that doesn't fit
  const over = await p.evaluate(async (k) => {
    const S = __pindou.S, n = +document.querySelector('#linkColors').max, base = 'https://dani-the-alien.github.io/pindou-studio/#pattern=';
    const fits = [];
    for (const t of __pindou.simplerTries(n)) if (t > k) {
      const cells = __pindou.simplifyCells(S.cells, S.w, S.h, t, true);
      const url = base + await __pindou.packDesign(__pindou.serialize(cells));
      if (url.length <= 2000) fits.push(t);
    }
    return fits;
  }, k);
  eq(over, [], 'larger counts that would also have fitted');
});
test('short links: fewer colors move each dropped color to its nearest kept one', async (p) => {
  const r = await p.evaluate(() => {
    const S = __pindou.S, code = (c) => S.palette.findIndex((x) => x.code === c);
    // lots of H7 (black), a little H2-ish white, and one near-black that should merge into black
    const black = code('H7'), white = code('H2'), near = code('H6');
    const cells = Int16Array.from([...new Array(40).fill(black), ...new Array(40).fill(white), near]);
    const out = __pindou.simplifyCells(cells, 81, 1, 2, false);
    return { kept: [...new Set(out)].sort(), black, white, nearTo: out[80] };
  });
  eq(r.kept, [r.black, r.white].sort(), 'kept colors');
  eq(r.nearTo, r.black, 'near-black went to black');
});

// ---------- 1.3: keyboard drawing and tabs ----------
const cellV = (p, x, y) => p.evaluate(([x, y]) => __pindou.S.cells[y * __pindou.S.w + x], [x, y]);
const keys = async (p, ...ks) => { for (const k of ks) await p.keyboard.press(k); };
test('keyboard: the canvas can be reached with Tab and drawn on with arrows and Enter', async (p) => {
  // Tab from the tool buttons reaches the canvas
  await p.focus('[data-tool=pan]');
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) { await p.keyboard.press('Tab'); reached = await p.evaluate(() => document.activeElement.id === 'viewport'); }
  assert(reached, 'Tab never reached the canvas');
  await keys(p, 'ArrowRight'); // shows the cursor at the top-left
  await keys(p, 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'Enter');
  eq(await cellV(p, 3, 2), await p.evaluate(() => __pindou.S.color), 'bead at column 4, row 3');
  eq(await beads(p), 1, 'beads');
  eq(await undoLen(p), 1, 'one undo step');
  assert(/Placed\. column 4, row 3: \w+/.test(await p.textContent('#canvasLive')), 'announced: ' + await p.textContent('#canvasLive'));
  await keys(p, 'Delete');
  eq(await cellV(p, 3, 2), -1, 'erased with Delete');
  // Shift moves 10; Home/End go to the ends of the row; the edges hold
  await keys(p, 'Shift+ArrowRight', 'Enter');
  eq(await cellV(p, 13, 2), await p.evaluate(() => __pindou.S.color), 'Shift+ArrowRight moved 10');
  await keys(p, 'End', 'ArrowRight', 'Enter');
  eq(await cellV(p, 51, 2), await p.evaluate(() => __pindou.S.color), 'End, and the right edge holds');
  await keys(p, 'Home', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'Enter');
  eq(await cellV(p, 0, 0), await p.evaluate(() => __pindou.S.color), 'Home, and the top edge holds');
});
test('keyboard: Enter uses the current tool (fill, pick)', async (p) => {
  await p.focus('#viewport'); await keys(p, 'ArrowDown', 'ArrowDown');
  await keys(p, 'f', 'Enter');
  eq(await beads(p), 52 * 52, 'filled');
  await p.evaluate(() => { const S = __pindou.S; S.cells[0] = 3; }); // a different bead at the corner
  await keys(p, 'Home', 'ArrowUp', 'ArrowUp', 'i', 'Enter');
  eq(await p.evaluate(() => __pindou.S.color), 3, 'picked');
  eq(await p.evaluate(() => __pindou.S.tool), 'pencil', 'back to the pencil');
});
test('keyboard: after a mouse click on the canvas, Enter doesn\'t paint at a hidden cursor', async (p) => {
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'ArrowRight');
  await p.mouse.click(...await cellPoint(p, 20, 20)); // draws one bead with the mouse
  await p.keyboard.press('Enter');
  eq(await beads(p), 1, 'beads');
});
test('keyboard: in a focused tray the cursor stays in that tray', async (p) => {
  await newDesign(p, { across: 2, down: 1 });
  await p.evaluate(() => document.querySelector('[data-tab=trays]').click());
  await p.keyboard.press(']'); // focus the first tray
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'End', 'ArrowRight', 'Enter');
  const tray = await p.evaluate(() => __pindou.S.tray);
  eq(await cellV(p, tray - 1, 0), await p.evaluate(() => __pindou.S.color), 'bead at the tray\'s right edge');
});
test('keyboard: a paused tab can\'t draw from the keyboard', async (p) => {
  const t = await secondTab(p);
  await t.evaluate(() => { document.querySelector('#tabDialog').close(); __pindou.tab.blocked = false; }); // even if the notice were gone
  await t.focus('#viewport'); await keys(t, 'ArrowRight', 'Enter');
  eq(await beads(t), 0, 'beads in the paused tab');
});
test('tabs: one tab in the Tab order; arrows, Home and End move and select; each controls its panel', async (p) => {
  const st = () => p.evaluate(() => [...document.querySelectorAll('.tabs [role=tab]')].map((t) => [t.dataset.tab, t.getAttribute('aria-selected'), t.tabIndex, document.getElementById(t.getAttribute('aria-controls')).hidden]));
  eq(await st(), [['palette', 'true', 0, false], ['counts', 'false', -1, true], ['trays', 'false', -1, true]], 'start');
  await p.focus('#tab-palette');
  await keys(p, 'ArrowRight');
  eq(await st(), [['palette', 'false', -1, true], ['counts', 'true', 0, false], ['trays', 'false', -1, true]], 'ArrowRight');
  eq(await p.evaluate(() => document.activeElement.id), 'tab-counts', 'focus');
  await keys(p, 'End'); eq((await st())[2][1], 'true', 'End');
  await keys(p, 'ArrowRight'); eq((await st())[0][1], 'true', 'wraps to the first');
  await keys(p, 'ArrowLeft'); eq((await st())[2][1], 'true', 'wraps to the last');
  await keys(p, 'Home'); eq((await st())[0][1], 'true', 'Home');
  eq(await p.evaluate(() => [...document.querySelectorAll('[role=tabpanel]')].every((x) => document.getElementById(x.getAttribute('aria-labelledby')).getAttribute('aria-controls') === x.id)), true, 'panels labelled by their tabs');
});

test('short links: the merge order gives exactly what reduceColors keeps, for every count', async (p) => {
  const bad = await p.evaluate(() => {
    const counts = new Map(); for (let v = 0; v < 25; v++) counts.set(v * 3, 1 + ((v * 7919) % 97));
    const order = __pindou.mergeOrder(counts), bad = [];
    for (let k = 1; k <= 25; k++) {
      const want = new Set(__pindou.reduceColors(counts, k));
      const got = new Set([...counts.keys()].filter((v) => !order.slice(0, 25 - k).includes(v)));
      if (want.size !== got.size || [...want].some((v) => !got.has(v))) bad.push(k);
    }
    return bad;
  });
  eq(bad, [], 'counts where they differ');
});
test('short links: clear beads stay clear, and white stays white', async (p) => {
  const r = await p.evaluate(() => {
    const S = __pindou.S, clear = S.palette.findIndex((c) => c.transparent);
    const white = S.palette.findIndex((c) => !c.transparent && c.code === 'H2');
    const others = S.palette.filter((c) => !c.transparent && c.i !== white).slice(0, 5).map((c) => c.i);
    const cells = Int16Array.from([...new Array(30).fill(clear), ...new Array(300).fill(white), ...others.flatMap((o, k) => new Array(50 + k).fill(o))]);
    const out = __pindou.simplifyCells(cells, cells.length, 1, 2, false);
    // and clean-up: a lone clear bead in white, and a lone white bead in clear, stay
    const g = (a, b) => Int16Array.from([a, a, a, a, b, a, a, a, a]);
    const c1 = __pindou.simplifyCells(g(white, clear), 3, 3, 99, true)[4], c2 = __pindou.simplifyCells(g(clear, white), 3, 3, 99, true)[4];
    return { clear, white, clearOut: out.slice(0, 30).every((v) => v === clear), whiteOut: out.slice(30, 330).every((v) => v === white), loneClear: c1 === clear, loneWhite: c2 === white };
  });
  assert(r.clear >= 0, 'palette has no clear bead');
  eq([r.clearOut, r.whiteOut, r.loneClear, r.loneWhite], [true, true, true, true], '[clear kept, white kept, lone clear kept, lone white kept]');
});
test('short links: moving the slider at once never lets the old version be copied or applied', async (p) => {
  await speckled(p, 80);
  const before = await design(p);
  await shareOpen(p); await simpleReady(p); await p.check('#linkWhichSimple');
  await p.fill('#linkColors', '2');
  eq([await p.inputValue('#linkText'), await p.isDisabled('#linkCopy'), await p.isDisabled('#linkApply')], ['', true, true], '[link, Copy disabled, Apply disabled] right after');
  await p.waitForFunction(() => !document.querySelector('#linkApply').disabled, null, { timeout: 10000 });
  await p.click('#linkApply'); await p.waitForTimeout(300);
  eq(await p.evaluate(() => new Set(__pindou.S.cells.filter((v) => v >= 0 && !__pindou.S.palette[v].transparent)).size <= 2), true, 'applied the 2-color version');
  assert(await design(p) !== before, 'design unchanged');
});
test('short links: when even the simplest version is too long, it says so', async (p) => {
  await p.evaluate(() => {
    const pal = __pindou.S.palette; const w = 624, h = 624;
    __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'noise', palette: __pindou.S.paletteId, tray: 52, w, h, legend: pal.map((c) => c.code), cells: Array.from({ length: w * h }, () => (Math.random() * pal.length) | 0) });
  });
  await shareOpen(p); await simpleReady(p);
  const len = await p.textContent('#linkSimpleLen');
  assert(/still too long/.test(len), 'expected nothing to fit: ' + len);
  assert(/Still too long for a link/.test(await p.textContent('#linkHint')), 'hint: ' + await p.textContent('#linkHint'));
});
test('short links: the colors slider has a name', async (p) => {
  await speckled(p, 80); await shareOpen(p); await simpleReady(p); await p.check('#linkWhichSimple');
  eq(await p.getByRole('slider', { name: 'At most this many colors:' }).count(), 1, 'named slider');
});
test('short links: an open QR code stays open when the suggestion arrives', async (p) => {
  // a link over 2,000 characters that still fits a QR code
  await p.evaluate(() => {
    const pal = __pindou.S.palette, n = 62;
    __pindou.loadProject({ format: 'pindou-studio', version: 1, name: 'dense', palette: __pindou.S.paletteId, tray: 52, w: n, h: n, legend: pal.slice(0, 12).map((c) => c.code), cells: Array.from({ length: n * n }, () => (Math.random() * 12) | 0) });
  });
  // slow compression down, so the suggestion arrives after the QR code is opened
  await p.evaluate(() => {
    const C = window.CompressionStream;
    window.CompressionStream = class { constructor(f) { const c = new C(f); this.writable = c.writable; this.readable = c.readable.pipeThrough(new TransformStream({ async transform(ch, ctl) { await new Promise((r) => setTimeout(r, 300)); ctl.enqueue(ch); } })); } };
  });
  await shareOpen(p);
  await p.click('#linkQrBtn');
  eq(await p.evaluate(() => /working/.test(document.querySelector('#linkSimpleLen').textContent)), true, 'suggestion already there before the QR was opened');
  await simpleReady(p); await p.waitForTimeout(200);
  eq(await p.evaluate(() => !document.querySelector('#linkQrBox').hidden), true, 'QR still shown');
});
// ---------- 1.3: mouse wheel zooms, touchpad scroll pans ----------
// Send a burst of wheel events (as one device would) and report what each did to the view.
// Chromium's own WheelEvent fills in wheelDeltaY from deltaY, which no real browser does for
// touchpads, so each event sets it explicitly (undefined = a browser without it).
async function wheelBurst(p, events) {
  return p.evaluate((events) => {
    const v = document.querySelector('#viewport'), r = v.getBoundingClientRect(), out = [];
    for (const ev of events) {
      const before = { ...__pindou.S.view };
      const { wheelDeltaY, ...init } = ev;
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, deltaMode: 0, deltaX: 0, ...init });
      Object.defineProperty(e, 'wheelDeltaY', { value: wheelDeltaY });
      v.dispatchEvent(e);
      const after = __pindou.S.view;
      out.push(after.scale !== before.scale ? +(after.scale / before.scale).toFixed(3) : (after.ox !== before.ox || after.oy !== before.oy) ? 'pan' : 'none');
    }
    return out;
  }, events);
}
const gap = (p) => p.waitForTimeout(350); // longer than a burst's 250 ms
const ZOOM_OUT = +(1 / 1.2).toFixed(3), ZOOM_IN = 1.2;
test('wheel: mouse wheels zoom 1.2× a notch, in each browser\'s way of reporting them', async (p) => {
  eq(await wheelBurst(p, [{ deltaY: 100, wheelDeltaY: -120 }, { deltaY: 100, wheelDeltaY: -120 }]), [ZOOM_OUT, ZOOM_OUT], 'Chrome/Edge notch');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: -66.66666, wheelDeltaY: 120 }]), [ZOOM_IN], 'Chrome notch at 150% page zoom');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 4.000244, wheelDeltaY: -120 }]), [ZOOM_OUT], 'Chrome on macOS, a slow notch');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 33.33, wheelDeltaY: -120 }]), [ZOOM_OUT], 'Windows set to scroll 1 line a notch');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 3, deltaMode: 1 }]), [ZOOM_OUT], 'Firefox notch (lines)');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 53 }]), [+(1 / Math.pow(1.2, 0.53)).toFixed(3)], 'a whole-pixel notch from a browser without wheelDeltaY');
});
test('wheel: a touchpad pans, even when a flick speeds up into big steps', async (p) => {
  eq(await wheelBurst(p, [{ deltaY: 1.5 }, { deltaY: 6 }, { deltaY: 18 }, { deltaY: 60 }, { deltaY: 120 }, { deltaY: 80 }]), ['pan', 'pan', 'pan', 'pan', 'pan', 'pan'], 'a flick');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 40, wheelDeltaY: -120 }]), ['pan'], 'macOS touchpad signature (wheelDeltaY = -3 × deltaY)');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaX: 4, deltaY: 50 }]), ['pan'], 'any sideways movement');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 45.5 }, { deltaY: 70.25 }]), ['pan', 'pan'], 'a fast flick whose first step is big but fractional');
});
test('wheel: each burst is judged afresh; Ctrl zooms and Shift pans whatever the device', async (p) => {
  eq(await wheelBurst(p, [{ deltaY: 2 }]), ['pan'], 'touchpad');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 100, wheelDeltaY: -120 }]), [ZOOM_OUT], 'then a mouse');
  await gap(p);
  assert(typeof (await wheelBurst(p, [{ deltaY: 2, ctrlKey: true }]))[0] === 'number', 'touchpad pinch (Ctrl+wheel) zooms');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaY: 100, wheelDeltaY: -120, shiftKey: true }]), ['pan'], 'Shift+wheel (Firefox: deltaY)');
  await gap(p);
  eq(await wheelBurst(p, [{ deltaX: 100, deltaY: 0, wheelDeltaY: 0, shiftKey: true }]), ['pan'], 'Shift+wheel (Chrome: turned into deltaX)');
  // letting go of Shift mid-spin: the wheel zooms again at once (Shift didn't judge the burst)
  eq(await wheelBurst(p, [{ deltaY: 100, wheelDeltaY: -120 }]), [ZOOM_OUT], 'the wheel right after Shift');
});
test('wheel: a high-resolution wheel zooms in proportion, not a full step per event', async (p) => {
  const s = await p.evaluate(() => __pindou.S.view.scale);
  await wheelBurst(p, [{ deltaY: -3, deltaMode: 1 }]);
  const one = await p.evaluate(() => __pindou.S.view.scale) / s;
  assert(one > 1.15, 'a whole notch zoomed only ' + one.toFixed(3) + '×');
  await gap(p);
  const s2 = await p.evaluate(() => __pindou.S.view.scale);
  await wheelBurst(p, [{ deltaY: -1.5, deltaMode: 1 }, { deltaY: -1.5, deltaMode: 1 }]); // the same notch in two halves
  const two = await p.evaluate(() => __pindou.S.view.scale) / s2;
  assert(Math.abs(one - two) < 0.01, `one notch ${one.toFixed(3)}× vs two halves ${two.toFixed(3)}×`);
});
test('wheel: deltaMode is read before the deltas (Firefox switches to pixels otherwise)', async (p) => {
  const firsts = await p.evaluate(() => {
    const v = document.querySelector('#viewport'), r = v.getBoundingClientRect(), firsts = [];
    for (const extra of [{}, {}, { ctrlKey: true }, { shiftKey: true }]) {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 50, clientY: r.top + 50, deltaMode: 1, deltaY: 3, ...extra });
      let first = null;
      for (const k of ['deltaMode', 'deltaX', 'deltaY', 'deltaZ', 'wheelDeltaY']) {
        const val = e[k];
        Object.defineProperty(e, k, { get() { if (!first) first = k; return val; } });
      }
      v.dispatchEvent(e);
      firsts.push(first);
    }
    return firsts;
  });
  eq(firsts, ['deltaMode', 'deltaMode', 'deltaMode', 'deltaMode'], 'first property read, per event');
});

// ---------- 1.3: check my colors ----------
const hexOf = (p, code) => p.evaluate((code) => { const S = __pindou.S; return S.palette[S.codeIndex.get(code)].hex; }, code);
test('check colors: the disputed codes are the ones the two lists visibly disagree about', async (p) => {
  const d = await p.evaluate(() => __pindou.disputedColors().map((x) => x.code));
  eq(d.length, 11, 'how many: ' + d.join(' '));
  for (const c of ['H13', 'A25', 'F11', 'G8']) assert(d.includes(c), c + ' missing');
  assert(!d.includes('H1'), 'the clear bead is never disputed');
});
test('check colors: a choice recolors that code in both palettes, keeps the design, and lasts', async (p) => {
  await stroke(p, 5);
  const before = await design(p);
  const d = await p.evaluate(() => __pindou.disputedColors()[0]); // A25
  const now = await hexOf(p, d.code), pick = d.hexes.find((h) => h !== now);
  await p.click('#checkColors'); await p.waitForFunction(() => document.querySelector('#checkDialog').open);
  eq(await p.textContent('#checkStep'), `Bead 1 of 11: ${d.code}`, 'first step');
  await p.click(`#checkPair [data-hex="${pick}"]`);
  eq(await hexOf(p, d.code), pick, 'color in this palette');
  assert(/Bead 2 of 11/.test(await p.textContent('#checkStep')), 'moved on');
  eq(await design(p), before, 'design');
  await p.click('#checkDialog button[value=done]');
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady);
  eq(await hexOf(p, d.code), pick, 'after a reload');
  // the other palette uses it too
  await p.selectOption('#paletteSelect', await p.evaluate(() => [...document.querySelectorAll('#paletteSelect option')].map((o) => o.value).find((v) => v !== __pindou.S.paletteId)));
  await p.waitForTimeout(200);
  eq(await hexOf(p, d.code), pick, 'in the other palette');
});
test('check colors: Back, Skip, and going back to the published colors', async (p) => {
  const d = await p.evaluate(() => __pindou.disputedColors());
  const pub0 = await hexOf(p, d[0].code);
  await p.click('#checkColors'); await p.waitForFunction(() => document.querySelector('#checkDialog').open);
  const pick = d[0].hexes.find((h) => h !== pub0);
  await p.click(`#checkPair [data-hex="${pick}"]`);
  await p.click('#checkBack');
  eq(await p.getAttribute(`#checkPair [data-hex="${pick}"]`, 'aria-pressed'), 'true', 'Back shows the choice');
  for (let k = 0; k < 11; k++) await p.click('#checkSkip');
  assert(!(await p.evaluate(() => document.querySelector('#checkSummary').hidden)), 'no summary at the end');
  assert((await p.textContent('#checkSummaryText')).includes(d[0].code), 'summary lists the choice');
  await p.click('#checkReset');
  eq(await hexOf(p, d[0].code), pub0, 'published color again');
  eq(await p.evaluate(() => localStorage.getItem('pindou.colorFixes')), '{}', 'stored corrections');
});
test('check colors: stored corrections that aren\'t candidate colors are ignored', async (p) => {
  await p.evaluate(() => localStorage.setItem('pindou.colorFixes', JSON.stringify({ A1: '#000000', H13: '#123456', H1: '#FFFFFF' })));
  await p.reload(); await p.waitForFunction(() => window.__pindou); await p.evaluate(() => __pindou.tabReady);
  const pal = await p.evaluate(() => { const id = __pindou.S.paletteId; return Object.fromEntries(PALETTES[id].colors.filter((c) => ['A1', 'H13', 'H1'].includes(c.code)).map((c) => [c.code, c.hex])); });
  for (const code of ['A1', 'H13', 'H1']) eq(await hexOf(p, code), pal[code], code);
});
test('check colors: a choice in one tab recolors another open tab', async (p) => {
  const t = await secondTab(p);
  const d = await p.evaluate(() => __pindou.disputedColors()[0]);
  const now = await hexOf(t, d.code), other = d.hexes.find((h) => h !== now);
  await p.click('#checkColors'); await p.click(`#checkPair [data-hex="${other}"]`);
  await t.waitForFunction(([c, h]) => __pindou.S.palette[__pindou.S.codeIndex.get(c)].hex === h, [d.code, other], { timeout: 3000 });
});

test('keyboard: after New makes the design smaller, Enter paints inside it', async (p) => {
  await newDesign(p, { across: 2, down: 1 });
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'End'); // column 104
  await newDesign(p); // 52×52; no click on the canvas
  await p.focus('#viewport'); await keys(p, 'Enter');
  eq(await cellV(p, 51, 0), await p.evaluate(() => __pindou.S.color), 'bead at the new right edge');
  eq(await beads(p), 1, 'beads');
  assert(/column 52, row 1/.test(await p.textContent('#canvasLive')), 'announced: ' + await p.textContent('#canvasLive'));
});
test('keyboard: Enter on the tray buttons over the canvas presses them, not the canvas', async (p) => {
  await newDesign(p, { across: 2, down: 1 });
  await p.keyboard.press(']'); // first tray
  await p.focus('#viewport'); await keys(p, 'ArrowRight');
  await p.focus('[data-action=tray-next]'); await keys(p, 'Enter');
  eq(await p.evaluate(() => __pindou.S.focus), { r: 0, c: 1 }, 'tray after Next tray');
  eq(await beads(p), 0, 'beads');
});
test('keyboard: stepping to another tray brings the cursor into it', async (p) => {
  await newDesign(p, { across: 2, down: 1 });
  await p.keyboard.press(']');
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'ArrowDown');
  await keys(p, ']', 'Enter');
  const tray = await p.evaluate(() => __pindou.S.tray);
  eq(await cellV(p, tray, 1), await p.evaluate(() => __pindou.S.color), 'bead at the left edge of the second tray');
});
test('keyboard: Ctrl+Z of a resize while the canvas has focus keeps the cursor inside', async (p) => {
  await newDesign(p, { across: 2, down: 1 });
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'End'); // column 104
  await keys(p, 'Control+z'); // back to 52 wide, the canvas still focused
  eq(await p.evaluate(() => __pindou.S.w), 52, 'width after undo');
  await keys(p, 'Enter');
  eq(await cellV(p, 51, 0), await p.evaluate(() => __pindou.S.color), 'bead at the right edge');
  eq(await beads(p), 1, 'beads');
});
test('keyboard: it says when picking or filling does nothing, and when a fill works with a full undo history', async (p) => {
  await p.focus('#viewport'); await keys(p, 'ArrowRight', 'i', 'Enter');
  assert(/Nothing to pick here/.test(await p.textContent('#canvasLive')), 'empty pick: ' + await p.textContent('#canvasLive'));
  await keys(p, 'p');
  for (let k = 0; k < 205; k++) await keys(p, k % 2 ? 'Delete' : 'Enter'); // fill the undo history
  await keys(p, 'Delete', 'f', 'Enter');
  assert(/^Filled\./.test(await p.textContent('#canvasLive')), 'real fill: ' + await p.textContent('#canvasLive'));
  await keys(p, 'Enter');
  assert(/^Nothing changed\./.test(await p.textContent('#canvasLive')), 'fill with the same color: ' + await p.textContent('#canvasLive'));
});
// ---------- runner ----------
(async () => {
  const filter = process.argv[2] || '';
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let failed = 0, ran = 0; const failures = [];
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    ran++;
    const page = await open(browser, base, t.opts || {});
    try { await t.fn(page, browser); console.log('  ✓ ' + t.name); }
    catch (e) { failed++; failures.push(t.name); console.log('  ✗ ' + t.name + '\n      ' + e.message.split('\n')[0]); }
    finally { await page.ctx.close(); }
  }
  await browser.close(); server.close();
  // Failed test names last, so they survive a truncated log (e.g. `| tail`).
  if (failures.length) console.log('\nFailed:\n' + failures.map((n) => '  - ' + n).join('\n'));
  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
})();
