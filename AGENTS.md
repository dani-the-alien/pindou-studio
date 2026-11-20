# Working on Pindou Studio

Notes for anyone (human or AI assistant) changing this codebase.

**Asked to install Pindou Studio on someone's computer instead?** Follow [`desktop/INSTALL-AGENT.md`](desktop/INSTALL-AGENT.md), not this file.

## Layout

- `index.html`, `styles.css`: the page. No build step, no framework, no dependencies.
- `js/app.js`: the whole app (drawing, trays, image conversion, files, export). `js/color.js`: color math (CIELAB, CIEDE2000, OKLCH).
- `js/palettes.js`: **generated** from `data/*.json` by `tools/gen-palettes.py`. Don't edit it by hand.
- `desktop/`: the per-user Linux desktop installer, its local server (`serve.py`) and the install guide for assistants.
- `tests/run.cjs`: browser tests (Node + Playwright with Chromium).
- `tools/bump-version.sh`: keeps the version in `js/app.js` and `index.html` in sync.

## Before you commit

- Run the tests: `node tests/run.cjs` (or `node tests/run.cjs <part of a test name>`). Add a test for any bug you fix.
- If you changed anything in `js/` or `styles.css`, bump the version: `tools/bump-version.sh X.Y.Z`, then `tools/bump-version.sh --check`. Browsers use it to fetch fresh files instead of cached ones.
- If you changed `data/`, regenerate: `python3 tools/gen-palettes.py`.

## Things that are easy to break

- **Whole-design changes go through `replaceState()`** (New/resize, Open, image import, palette switch) so they're one undo step that also restores palette and tray size. Don't mutate `S.cells`/`S.w`/`S.palette` directly for those.
- **Cell values are indices into the current palette.** Anything that changes the palette must remap cells first (see `switchPalette()`).
- **Project files are untrusted input:** validate everything in `parseProject()` before changing any state.
- **Fill and Swap run on pointer-up,** so starting a pinch-zoom on a touchscreen doesn't trigger them.
- **Matching uses exact CIEDE2000.** Faster approximations were measured and rejected (see the history of `convertJob()`).
