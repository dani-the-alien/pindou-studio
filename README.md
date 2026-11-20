# Pindou Studio

A browser-based design and layout tool for MARD 2.6mm fuse beads (拼豆). Draw a pattern or convert a picture, see it split across pegboards ("trays"), get bead counts, and print one sheet per tray to build from.

Plain HTML/CSS/JS: no build step, no server-side code, no accounts. Everything happens in your browser. Pictures you convert are never uploaded anywhere.

## What is Pindou ##

Pindou is a pixel art like system of making images with small plastic beads, then fusing them together permanently by pressing with a hot iron or heat press. I discovered Pindou (PIN-doo; 拼豆, approximately "piecing beans together") when I watched Maqaroon's video [How to Make Perler Beads Look Professional](https://www.youtube.com/watch?v=jfPZmNVr360). I bought a kit similar to the one they recommended.

## Get it and run it

**Use it online:** https://dani-the-alien.github.io/pindou-studio/ (nothing to install; works on phones and tablets too).

**Or run your own copy:**

```
git clone https://github.com/dani-the-alien/pindou-studio
cd pindou-studio
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open http://127.0.0.1:8000 in a current Chrome, Edge, Firefox or Safari. (`--bind 127.0.0.1` keeps it to this computer; without it, other devices on your network can open it too.) Any static web host works as well.

Your current design autosaves in the browser, **tied to that exact address and browser**: opening it at another address, port or browser starts fresh. Use **Save** to keep a design as a `.pindou.json` file, and **Open** to load it anywhere.

**One tab edits at a time.** All tabs at one address share that autosave, so if Pindou Studio is open in a second tab, that tab shows "Open in another tab" instead of editing. **Edit here instead** moves editing there: the other tab saves and hands over its design first. If the other tab can't answer (a dialog such as Print is open in it, or it's asleep in the background), switch to it or close it. This needs a secure address (https, `localhost` or `127.0.0.1`); over plain http on a network address (`http://192.168.…`) every tab edits on its own, and the app warns when it sees a second tab.

**Desktop app on Linux:** `bash desktop/install.sh` adds a Pindou Studio entry to the app menu, backed by a small local server that only this computer can reach. It's built for Bazzite / KDE Plasma and works on most systemd Linux desktops; nothing needs root. Run it again to update. [`desktop/INSTALL-AGENT.md`](desktop/INSTALL-AGENT.md) walks an AI assistant through doing this for someone.

## Features

- **Draw by hand**: pencil, eraser (or right-click), flood fill, eyedropper, swap every bead of one color, undo/redo. New, resize, Open, image import and palette switches can all be undone too.
- **Palette views**: color families, hue (rainbow), value (light → dark), saturation, or MARD series order. Sorting uses OKLCH, so hues line up with color names.
- **Image → pattern**: a tray-grid picker sets the size (click 2 × 3 to fit the picture into that many trays). Colors are matched with CIEDE2000. Options: a maximum number of colors (it merges whichever color is cheapest to lose, so small details like eyes survive), only the beads you own, Floyd–Steinberg dithering, and background removal. Large conversions run in the background with a progress readout.
- **Multi-tray layout**: designs up to 624 × 624 beads. Tray boundaries are drawn on the canvas. Tray presets are 52, 72, 78 and 104 pegs per side, plus custom sizes. Focus mode shows one board at a time, with that board's own peg numbering and bead counts.
- **Bead counts** per color, for the whole design or one tray.
- **Export**:
  - PNG pattern with a color legend; bead codes are printed in the cells for designs up to 416 beads per side.
  - CSV of bead counts, with a column per tray when the design spans more than one.
  - Print sheets: an overview, plus one page per tray to build from. A small single-tray design prints as one page with codes. The browser's own Print (Ctrl+P) works too.
- **My collection**: mark which colors you own, then filter the palette or limit image conversion to them.
- **Phones, tablets and foldables**: on a phone the tools sit along the bottom and a row of quick colors (current, recent, and the colors in your design) is always in reach; ▴ opens the full palette and panels as a sheet. Small screens fold New/Image/Open/Save/Export into a ⋯ menu. Tablets in portrait dock the panels under the canvas. A foldable bent at its hinge puts the canvas on one half and the controls on the other.
- **Exports say where they came from**: PNG patterns and printed sheets carry a small "Made with Pindou Studio" line with the app's address.
- **Share as a link**: **Share** puts the whole design into a link (in the part after `#`, which browsers don't send to any server), ready to copy or send. Opening it gives the other person their own copy; if they already have a design open, they're asked first, and Undo brings theirs back. Very detailed designs (most photo conversions bigger than about 100 × 100) don't fit in a link; save the file for those. To bookmark a design, turn on **Keep this design's link in the address bar** in the Share dialog, then bookmark the page as usual. Links made in a copy running on your own computer (`localhost`, `127.0.0.1`, the desktop install) point at the public site, so they work for whoever you send them to.
- **QR codes**: **Show QR code** in the Share dialog turns the link into a QR code to scan with a phone. In the Export menu, **Add a QR code (PNG & print)** puts one below the legend of the PNG and on an extra last page when printing. A QR code holds links up to about 2,900 characters, which fits most simple designs; a one-tray, 8–16 color line-art design comes to roughly 500–1,200.

## Shortcuts

| Keys | Action |
|---|---|
| P or B · E · F or G · I · R · H | Pencil · Eraser · Fill · Eyedropper · Swap color · Pan |
| Space (hold), middle-drag, two fingers | Pan |
| Mouse wheel, Ctrl+wheel, pinch, + / = / - / 0 | Zoom in and out; 0 fits the design (or the focused tray) |
| Shift+wheel, trackpad scroll | Pan |
| Ctrl+Z · Ctrl+Shift+Z or Ctrl+Y | Undo · Redo |
| Ctrl+S | Save the project |
| [ · ] · Esc | Previous / next tray · leave tray focus, or close the menu, the ⋯ menu or the phone color sheet |
| ← → · Home · End (in the quick-color row) | Move along the quick colors |

On a Mac, Cmd works in place of Ctrl. Single-key shortcuts are ignored while you're typing in a text box or a dropdown has focus.

## Development

See [`AGENTS.md`](AGENTS.md) for how the code is laid out and what's easy to break. In short:

```
node tests/run.cjs                 # browser tests (needs Node, Playwright and its Chromium)
tools/bump-version.sh 1.1.0        # after changing js/ or styles.css; also updates index.html
tools/bump-version.sh --check      # confirms the version is consistent
python3 tools/gen-palettes.py      # after changing data/; regenerates js/palettes.js
```

The running version is shown in the status bar (on phones and other small screens, at the bottom of the ⋯ menu). If the page and its scripts ever come from different versions (a browser reusing cached files), the app says so and asks for a full reload (Ctrl+Shift+R).

## Palette data

`data/mard-221.json` and `data/mard-291.json` are copied unchanged from [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data) at commit `178dafb` (2026-05-19), folders `mard-221-alfonse-doudou` and `mard-291-github` (MIT, see `data/LICENSE-pindou-color-data`). `js/palettes.js` is generated from them by `tools/gen-palettes.py`, which sorts the codes and marks H1 as the clear bead.

There is no official machine-readable MARD hex list; these values are community approximations, and screens vary. The two palettes come from **different sources**:

- **MARD 221** is the alfonse.online / doudougongfang data.
- **MARD 291**'s first 221 codes come from get-colors-from-beans.

They agree on 144 codes and differ on 77. Most differences are tiny (median ΔE2000 ≈ 0.75; 62 of the 77 are under 2). A few are large: H13, A25, F11 and G8 differ by ΔE2000 9.5–15.6. Several of those look like hex typos in one of the sources (H13 is `#F4EDF1` in one and `#F4EFD1` in the other), though it isn't known which side is right. Because of this, switching between the two palettes shifts those 77 colors slightly. For close calls, compare against a physical MARD color card.

H1 is treated as the clear (transparent) bead and is never used when converting pictures.

## Credits

- **Pindou Studio** by Dani, written together with Claude (Anthropic) in Claude Code.
- **MARD palette data** as compiled and published by [HansBug/pindou-color-data](https://github.com/HansBug/pindou-color-data) (MIT). Its 221-color set traces back to the alfonse.online / doudougongfang MARD pages, and its 291-color set to [get-colors-from-beans](https://git.xiongxiao.me/abearxiong/get-colors-from-beans) by abearxiong; the underlying hex values were gathered from public tool sites. [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors) was consulted for comparison during development; it isn't the source of the bundled values.
- **CIEDE2000** color difference, implemented following G. Sharma, W. Wu & E. N. Dalal, "The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical observations", *Color Research & Application* 30(1), 2005, and checked against their test data.
- **OKLab / OKLCH** color space by Björn Ottosson (2020), used to sort and group the palette.
- **Dithering** uses the Floyd–Steinberg error-diffusion algorithm (1976).
- **QR codes** are encoded by Project Nayuki's [QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library) (MIT), included as `js/qrcodegen.js`. The tests check them with [jsQR](https://github.com/cozmo/jsQR) by Cosmo Wolfe (Apache 2.0), kept in `tests/vendor/` and not part of the app.

## License

MIT, see `LICENSE`. The bundled MARD palette data is separately MIT-licensed as published by HansBug (`data/LICENSE-pindou-color-data`). Pindou Studio isn't affiliated with or endorsed by MARD.
