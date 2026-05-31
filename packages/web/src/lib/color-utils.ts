/**
 * Color utilities for dynamic cat theme rendering.
 * Converts hex colors from API to rgba for glow/shadow effects.
 */

/** Blend a hex color toward white by ratio (0→white, 1→accent). Symmetric to tintedDark. */
export function tintedLight(hex: string, ratio: number, base = '#FFFFFF'): string {
  const parse = (h: string) => [
    Number.parseInt(h.slice(1, 3), 16),
    Number.parseInt(h.slice(3, 5), 16),
    Number.parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(base);
  return `rgb(${Math.round(r2 + (r1 - r2) * ratio)}, ${Math.round(g2 + (g1 - g2) * ratio)}, ${Math.round(b2 + (b1 - b2) * ratio)})`;
}

/** Convert hex color (3/6/8 digit) to rgba string */
export function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '');
  let r: number, g: number, b: number;
  if (cleaned.length === 3) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ============================================================
 * F056 Phase E AC-E10 — OKLCH → sRGB → WCAG contrast pipeline
 *
 * 算法源：CSS Color Module Level 4 (W3C)。纯函数，零依赖。
 * 用于跑 WCAG 对比度自动测试，保证 token 派生对 ≥ 4.5:1 (normal text)
 * 或 ≥ 3:1 (large text / icons)。
 * ============================================================ */

export interface OklchColor {
  l: number; // [0, 1]
  c: number; // [0, ~0.4]
  h: number; // [0, 360]
}

/** OKLCH → OKLab（极坐标 → 直角坐标） */
function oklchToOklab(L: number, C: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  return [L, C * Math.cos(hRad), C * Math.sin(hRad)];
}

/** OKLab → linear sRGB（W3C 矩阵反变换） */
function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const lp = L + 0.3963377774 * a + 0.2158037573 * b;
  const mp = L - 0.1055613458 * a - 0.0638541728 * b;
  const sp = L - 0.0894841775 * a - 1.291485548 * b;
  const lc = lp ** 3;
  const mc = mp ** 3;
  const sc = sp ** 3;
  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

/** Clamp into [0, 1] (out-of-gamut 处理：直接截断，足够 WCAG 用) */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * WCAG relative luminance — 输入 linear sRGB（已经过 gamma 反变换）。
 * 公式：L = 0.2126 R + 0.7152 G + 0.0722 B
 */
function relativeLuminance(rLin: number, gLin: number, bLin: number): number {
  return 0.2126 * clamp01(rLin) + 0.7152 * clamp01(gLin) + 0.0722 * clamp01(bLin);
}

/**
 * Compute WCAG contrast ratio between two OKLCH colors.
 * Returns ratio in [1, 21]. WCAG AA: ≥4.5 normal text / ≥3 large text.
 *
 * @example
 *   oklchContrast({ l: 0.30, c: 0.10, h: 297 }, { l: 0.94, c: 0.05, h: 297 })
 *   // → ~7.8 (opus text vs opus surface in light mode)
 */
export function oklchContrast(fg: OklchColor, bg: OklchColor): number {
  const [fgL, fgA, fgB] = oklchToOklab(fg.l, fg.c, fg.h);
  const [bgL, bgA, bgB] = oklchToOklab(bg.l, bg.c, bg.h);
  const fgLin = oklabToLinearRgb(fgL, fgA, fgB);
  const bgLin = oklabToLinearRgb(bgL, bgA, bgB);
  const fgY = relativeLuminance(...fgLin);
  const bgY = relativeLuminance(...bgLin);
  const [light, dark] = fgY > bgY ? [fgY, bgY] : [bgY, fgY];
  return (light + 0.05) / (dark + 0.05);
}

/* ============================================================
 * F056 Phase E AC-E4 — hex → OKLCH 反推（一次性 migration helper）
 *
 * 从老 cat-template.json 的 primary hex 反推 hue/chroma，
 * 用于 schema 升级时 fallback 算 hue（避免手动转换 14 只猫的 hex）。
 *
 * 算法：sRGB → linear sRGB → OKLab → OKLCH（W3C CSS Color Module Level 4）
 * ============================================================ */

/** sRGB byte [0, 255] → linear sRGB [0, 1]（gamma 反变换） */
function srgbByteToLinear(byte: number): number {
  const v = byte / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** linear sRGB → OKLab（W3C 矩阵正变换） */
function linearRgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.629978701 * b;
  const lp = Math.cbrt(l);
  const mp = Math.cbrt(m);
  const sp = Math.cbrt(s);
  return [
    0.2104542553 * lp + 0.793617785 * mp - 0.0040720468 * sp,
    1.9779984951 * lp - 2.428592205 * mp + 0.4505937099 * sp,
    0.0259040371 * lp + 0.7827717662 * mp - 0.808675766 * sp,
  ];
}

/** OKLab → OKLCH（直角 → 极坐标） */
function oklabToOklch(L: number, a: number, b: number): OklchColor {
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/**
 * Convert hex color to OKLCH coordinates.
 * Supports #RGB / #RRGGBB / #RRGGBBAA (alpha discarded).
 *
 * @example
 *   hexToOklch('#9B7EBD')  // opus 紫 → { l: ~0.625, c: ~0.107, h: ~297 }
 *   hexToOklch('#5B8C5A')  // codex 绿 → { l: ~0.563, c: ~0.099, h: ~145 }
 */
export function hexToOklch(hex: string): OklchColor {
  const cleaned = hex.replace('#', '');
  if (![3, 6, 8].includes(cleaned.length) || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }
  let r: number, g: number, b: number;
  if (cleaned.length === 3) {
    r = Number.parseInt(cleaned[0] + cleaned[0], 16);
    g = Number.parseInt(cleaned[1] + cleaned[1], 16);
    b = Number.parseInt(cleaned[2] + cleaned[2], 16);
  } else {
    r = Number.parseInt(cleaned.slice(0, 2), 16);
    g = Number.parseInt(cleaned.slice(2, 4), 16);
    b = Number.parseInt(cleaned.slice(4, 6), 16);
  }
  const rLin = srgbByteToLinear(r);
  const gLin = srgbByteToLinear(g);
  const bLin = srgbByteToLinear(b);
  const [oL, oa, ob] = linearRgbToOklab(rLin, gLin, bLin);
  return oklabToOklch(oL, oa, ob);
}
