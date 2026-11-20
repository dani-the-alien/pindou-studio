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
  for (let k = 0; k < 3; k++) await t2.keyboard.press('Escape'); // browsers let repeated Escape close a modal
  await t2.waitForTimeout(50);
  eq(await tabState(t2), { editing: false, notice: true }, 'notice after Escape ×3');
  await t2.keyboard.press('Control+z');
  eq(await beads(t2), 10, 'Ctrl+Z changed the paused tab');
  // try to change the paused tab's design and name directly, then close it
  await t2.evaluate(() => { const n = document.querySelector('#projectName'); n.value = 'from paused tab'; n.dispatchEvent(new Event('input')); });
  await t2.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('pindou.autosave')));
  assert(saved.name !== 'from paused tab', 'paused tab renamed the design');
  eq(saved.cells.filter((v) => v >= 0).length, 10, 'beads in autosave');
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
test('if the browser refuses to autosave, the page says so', async (p) => {
  await p.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
  await stroke(p, 5); await p.waitForTimeout(600);
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  assert(/won't let Pindou Studio autosave/.test(await p.textContent('#toastText')), 'no warning');
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
    assert(quick || !(await p.evaluate(() => matchMedia('(max-width: 599px), (max-height: 520px)').matches)), 'no quick colors on a phone');
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
test('flip phone cover screen: a message with the sheet open stays on screen and can be dismissed', async (p) => {
  await p.tap('#sheetToggle'); await p.waitForTimeout(150);
  await p.setInputFiles('#openFile', { name: 'x.pindou.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await p.waitForFunction(() => !document.querySelector('#toast').hidden);
  const r = await p.evaluate(() => { const t = document.querySelector('#toast').getBoundingClientRect(); return [t.top >= 0, t.bottom <= innerHeight]; });
  eq(r, [true, true], 'message on screen');
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
  assert(await p.evaluate(() => document.activeElement !== document.body), 'focus dropped to the page after the settings moved into ⋯');
}, touch({ width: 780, height: 412 }));
test('phone: Escape in the palette search clears the search, not the sheet', async (p) => {
  await p.tap('#sheetToggle');
  await p.fill('#paletteSearch', 'A'); await p.focus('#paletteSearch'); await p.keyboard.press('Escape');
  eq(await p.getAttribute('#sheetToggle', 'aria-expanded'), 'true', 'sheet stays open');
}, touch(SCREENS['foldable cover / tall phone']));
test('phones in landscape: quick colors at the top of the sidebar, swatches before the controls', async (p) => {
  assert(await tappable(p, '#quickColors [data-q=current]'), 'no quick row');
  const r = await p.evaluate(() => [document.querySelector('#swatches').getBoundingClientRect().top, document.querySelector('#paletteSelect').getBoundingClientRect().top]);
  assert(r[0] < r[1], 'controls before the swatches');
}, touch(SCREENS['small phone in landscape']));
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
    try { await t.fn(page); console.log('  ✓ ' + t.name); }
    catch (e) { failed++; failures.push(t.name); console.log('  ✗ ' + t.name + '\n      ' + e.message.split('\n')[0]); }
    finally { await page.ctx.close(); }
  }
  await browser.close(); server.close();
  // Failed test names last, so they survive a truncated log (e.g. `| tail`).
  if (failures.length) console.log('\nFailed:\n' + failures.map((n) => '  - ' + n).join('\n'));
  console.log(`\n${ran - failed}/${ran} passed`);
  process.exit(failed ? 1 : 0);
})();
