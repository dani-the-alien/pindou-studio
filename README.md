# Pindou Studio

A browser-based design and layout tool for MARD 2.6mm fuse beads (拼豆). Plain HTML/CSS/JS, no build step and no server-side code. Open `index.html` through any static file server, or host the folder anywhere (GitHub Pages works).

```
python3 -m http.server 8000   # then open http://localhost:8000
```

To install it as a desktop app (app-menu entry plus a small user-level local server; built for Bazzite/KDE Plasma, works on most systemd Linux desktops), run `bash desktop/install.sh`. `AGENTS.md` has step-by-step instructions written for an AI assistant doing the setup.

## Features

- **Draw by hand**: pencil, eraser (or right-click), flood fill, eyedropper, swap-all-of-a-color, undo/redo.
- **Palette views**: color families, hue (rainbow), value (light → dark), saturation, or MARD series order. Sorting uses OKLCH, so hues line up with color names.
- **Image → pattern**: a tray-grid picker sets the size (click 2 × 3 to fit the image into that many trays). Matching uses CIEDE2000 color matching against the MARD palette. Optional limits: max colors (merges whichever color is cheapest to lose, so small details like eyes survive), only beads you own, Floyd–Steinberg dithering, and background removal.
- **Multi-tray layout**: any design size up to 624×624. Tray boundaries are drawn on the canvas. Tray presets are 52/72/78/104 pegs per side, plus custom sizes. Focus mode works one board at a time, with per-board peg numbering and per-board counts.
- **Bead counts**: per color for the whole design or a single tray. The CSV export has per-tray columns.
- **Export**: PNG pattern with codes and legend, CSV, and print sheets (an overview plus one page per tray).
- **My collection**: mark which colors you own, then filter the palette or restrict image conversion to them.
- Projects autosave in the browser. Save/Open uses `.pindou.json` files.

## Shortcuts

P pencil · E eraser · F fill · I eyedropper · R swap · H pan (or hold Space / middle-drag / two fingers) · Ctrl+Z / Ctrl+Shift+Z · + / − / 0 zoom · [ ] step through trays · Esc leave tray focus · Ctrl+S save

## Palette data

`data/mard-221.json` and `data/mard-291.json` come from [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data) (MIT, see `data/LICENSE-pindou-color-data`). `js/palettes.js` is generated from them.

There is no official machine-readable MARD hex list. These values are community approximations. The two public 221-color sources agree on 144 codes and differ slightly on the other 77 (median ΔE2000 ≈ 1.3), with larger disagreement on A25, F11, G8 and H13. Check close calls against a physical color card. H1 is treated as the clear (transparent) bead and is excluded from image matching.
