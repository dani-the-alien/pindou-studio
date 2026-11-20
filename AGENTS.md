# Working on Pindou Studio

Notes for anyone (human or AI assistant) changing this codebase.

**Asked to install Pindou Studio on someone's computer instead?** Follow [`desktop/INSTALL-AGENT.md`](desktop/INSTALL-AGENT.md), not this file.

## Layout

- `index.html`, `styles.css`: the page. No build step, no framework, no dependencies.
- `js/app.js`: the whole app (drawing, trays, image conversion, files, export). `js/color.js`: color math (CIELAB, CIEDE2000, OKLCH).
- `js/palettes.js`: **generated** from `data/*.json` by `tools/gen-palettes.py`. Don't edit it by hand.
- `js/qrcodegen.js`: **vendored** (Project Nayuki's QR encoder, MIT, compiled once from its TypeScript; its header says how). Don't edit it by hand; to update it, replace the whole file the same way. `tests/vendor/`: test-only vendored files (jsQR, to decode QR codes in tests).
- `desktop/`: the per-user Linux desktop installer, its local server (`serve.py`) and the install guide for assistants.
- `tests/run.cjs`: browser tests (Node + Playwright with Chromium).
- `tools/bump-version.sh`: keeps the version in `js/app.js` and `index.html` in sync.

## Before you commit

- Run the tests: `node tests/run.cjs` (or `node tests/run.cjs <part of a test name>`). Add a test for any bug you fix.
- If you changed anything in `js/` or `styles.css`, bump the version: `tools/bump-version.sh X.Y.Z`, then `tools/bump-version.sh --check`. Browsers use it to fetch fresh files instead of cached ones.
- If you changed `data/`, regenerate: `python3 tools/gen-palettes.py`.

## Things that are easy to break

- **Whole-design changes go through `replaceState()`** (New/resize, Open, image import, "use the simpler version") so they're one undo step that also restores palette and tray size. Don't mutate `S.cells`/`S.w`/`S.palette` directly for those.
- **Cell values are indices into the current palette.** There's one palette (`mard`; files from before 1.4 name `mard221`/`mard291` and open into it by code). "Check my colors" corrections recolor codes in place (`recolorPalette()`), keeping codes and their order, so cells stay valid; anything that reorders or removes palette entries would have to remap cells first.
- **Links for other people use `shareBase()`,** which swaps a local address (localhost, 127.0.0.1, file:) for the public site. The address-bar switch is the exception: it keeps the tab's own address, since it's for that browser's own bookmarks. QR codes in exports need a link that's ready at once (Ctrl+P prints immediately), so `currentLink()` keeps one ready while the QR export toggle is on; anything that changes the design or its name must call `designChanged()` (`changed()` does).
- **Project files and pattern links are untrusted input:** validate everything in `parseProject()` before changing any state. Links (`#pattern=…`, see "sharing a design as a link" in `js/app.js`) are unpacked by `unpackDesign()`, which caps how big they may unzip to, then go through `parseProject()` too. Changing what a link holds means a new `LINK_FORMAT` number, and old links must keep opening.
- **Fill and Swap run on pointer-up,** so starting a pinch-zoom on a touchscreen doesn't trigger them.
- **Matching uses exact CIEDE2000.** Faster approximations were measured and rejected (see the history of `convertJob()`).
- **Only the editing tab may change the design or write the autosave.** Anything new that edits must check `tab.editing` (or go through `replaceState()`, which does), and anything that opens a blocking dialog (`confirm`, `prompt`, `print`) must call `saveBeforeDialog()` first. Editing moves between tabs only by hand-over, never by taking the lock; see the comment at the top of "one editing tab at a time" in `js/app.js` before changing it.
- **Layout breakpoints live in two places:** `styles.css` media queries and the `matchMedia()` calls in `js/app.js` (599.98, 799.98, 379.98 px wide; 520 and 600 px high; the Viewport Segments queries; 1099.98 is CSS-only). Change them together. Upper limits end in `.98` so fractional widths (browser zoom) don't fall between two layouts.
- **Some elements move in the DOM with the layout:** `.stage-bar` moves into the ⋯ menu on short screens, and `#swatches`/`#ownedHint` move up under the search row on compact layouts (and back before `#swatchesHome`). Don't assume their parent. CSS variables set from JS: `--top-h` (top bar height) and `--below-canvas` (space below the canvas, for message placement).
