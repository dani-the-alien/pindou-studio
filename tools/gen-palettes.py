#!/usr/bin/env python3
"""Regenerate js/palettes.js from data/mard-221.json and data/mard-291.json.

    python3 tools/gen-palettes.py          # write js/palettes.js
    python3 tools/gen-palettes.py --check  # exit 1 if js/palettes.js is out of date

What it does beyond copying the data:
  - keeps only code and hex (upper-cased) for each color;
  - sorts by series letters, then number (A1, A2, ... A10, ..., ZG8), which moves
    series Q in front of R in the 291-color file;
  - marks H1 as the clear (transparent) bead;
  - adds a display name and source description per palette.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PALETTES = [
    ("mard221", "data/mard-221.json", "MARD 221",
     "Common retail set (source: alfonse/doudougongfang via HansBug/pindou-color-data)"),
    ("mard291", "data/mard-291.json", "MARD 291",
     "Extended set incl. P/Q/R/T/Y/ZG series (source: get-colors-from-beans via HansBug/pindou-color-data)"),
]
HEADER = ("// Generated from data/*.json (HansBug/pindou-color-data, MIT). "
          "Hex values are community approximations, not official MARD values.\n")


def order(code):
    m = re.fullmatch(r"([A-Z]+)(\d+)", code)
    if not m:
        sys.exit(f"unexpected color code: {code!r}")
    return (m.group(1), int(m.group(2)))


def build():
    out = {}
    for key, path, name, desc in PALETTES:
        data = json.loads((ROOT / path).read_text(encoding="utf-8"))
        colors = sorted(({"code": c["code"], "hex": c["hex"].upper()} for c in data["colors"]),
                        key=lambda c: order(c["code"]))
        codes = [c["code"] for c in colors]
        if len(set(codes)) != len(codes):
            sys.exit(f"{path}: duplicate color codes")
        for c in colors:
            if c["code"] == "H1":
                c["transparent"] = True
        out[key] = {"name": name, "description": desc, "colors": colors}
    return HEADER + "window.PALETTES = " + json.dumps(out, separators=(",", ":")) + ";\n"


def main():
    target = ROOT / "js" / "palettes.js"
    text = build()
    if "--check" in sys.argv:
        if target.read_text(encoding="utf-8") != text:
            sys.exit("js/palettes.js is out of date: run python3 tools/gen-palettes.py")
        print("OK: js/palettes.js matches data/")
        return
    target.write_text(text, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
