// Color utilities: hex -> rgb, sRGB -> CIELAB (D65) and OKLCH, CIEDE2000 distance.
(function () {
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function rgbToLab(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    let x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    let y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
    let z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const POW25_7 = Math.pow(25, 7);

  function deltaE2000(l1, l2) {
    const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
    const Cb7 = Math.pow((C1 + C2) / 2, 7);
    const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + POW25_7)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    let h1p = Math.atan2(b1, a1p) * deg; if (h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * deg; if (h2p < 0) h2p += 360;
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) > 180) hbp += (hbp < 360 ? 360 : -360);
      hbp /= 2;
    }
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
      + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
    const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Cbp7 = Math.pow(Cbp, 7);
    const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
    const Lm = (Lbp - 50) * (Lbp - 50);
    const Sl = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
    const Rt = -Math.sin(2 * dTheta * rad) * Rc;
    const tl = dLp / Sl, tc = dCp / Sc, th = dHp / Sh;
    return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
  }

  // Label color for a bead swatch: whichever of near-black (#111) or white has the
  // higher WCAG contrast ratio against it.
  function contrastText(hex) {
    const [r, g, b] = hexToRgb(hex);
    const L = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
    const DARK = 0.0056; // relative luminance of #111
    return (L + 0.05) / (DARK + 0.05) >= 1.05 / (L + 0.05) ? '#111' : '#fff';
  }

  // OKLCH (Björn Ottosson's OKLab in polar form). Used for sorting/grouping the
  // palette, because its hue angles line up with color names far better than
  // CIELAB's do. L is 0..1, C is roughly 0..0.32 for sRGB colors, H is degrees.
  function rgbToOklch(r, g, b) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    let H = Math.atan2(Bb, A) * deg; if (H < 0) H += 360;
    return { L, C: Math.hypot(A, Bb), H };
  }

  window.Color = { hexToRgb, rgbToLab, rgbToOklch, deltaE2000, contrastText };
})();
