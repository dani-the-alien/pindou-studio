#!/usr/bin/env python3
"""Regenerate js/palettes.js from data/mard-221.json and data/mard-291.json.

    python3 tools/gen-palettes.py          # write js/palettes.js
    python3 tools/gen-palettes.py --check  # exit 1 if js/palettes.js is out of date

There is one MARD palette: every code in either list (the 291-color list contains
all 221 codes). For each color:
  - hex: from the 221-color list (the cross-checked "Alfonse + doudougongfang"
    version) where it has the code, otherwise from the 291-color list;
  - alt: the 291-color list's hex, where it differs (the app's "Check my colors"
    lets people pick between them where they differ visibly);
  - in221: true for codes in the 221-color retail set (a "My collection" preset).
Codes are sorted by series letters, then number (A1, A2, ... A10, ..., ZG8), and H1
is marked as the clear (transparent) bead.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = {"221": "data/mard-221.json", "291": "data/mard-291.json"}
HEADER = ("// Generated from data/*.json (HansBug/pindou-color-data, MIT) by tools/gen-palettes.py. "
          "Hex values are community approximations, not official MARD values.\n")


def order(code):
    m = re.fullmatch(r"([A-Z]+)(\d+)", code)
    if not m:
        sys.exit(f"unexpected color code: {code!r}")
    return (m.group(1), int(m.group(2)))


def load(path):
    data = json.loads((ROOT / path).read_text(encoding="utf-8"))
    out = {}
    for c in data["colors"]:
        if c["code"] in out:
            sys.exit(f"{path}: duplicate color code {c['code']}")
        out[c["code"]] = c["hex"].upper()
    return out


def build():
    a, b = load(SOURCES["221"]), load(SOURCES["291"])
    missing = sorted(set(a) - set(b), key=order)
    if missing:
        sys.exit(f"codes in the 221 list but not the 291 list: {missing}")
    colors = []
    for code in sorted(b, key=order):
        c = {"code": code, "hex": a.get(code, b[code])}
        if code in a and a[code] != b[code]:
            c["alt"] = b[code]
        if code in a:
            c["in221"] = True
        if code == "H1":
            c["transparent"] = True
        colors.append(c)
    out = {"mard": {"name": "MARD", "description": "MARD beads: the 221-color retail set plus the extended "
                    "P/Q/R/T/Y/ZG series (source: HansBug/pindou-color-data)", "colors": colors}}
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
