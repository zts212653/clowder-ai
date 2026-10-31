/**
 * F322 B — one reading of a CSS hex colour for the places that need the colour itself, not just to hand the string on.
 *
 * The config chain (humanColorState, hexToOklch) accepts #RGB, #RGBA, #RRGGBB and #RRGGBBAA, and an opaque colour in any
 * of those spellings is the same fill. A caller that builds another colour by writing characters after the string (an alpha
 * byte for a tint) only gets a colour back when the string is a six-digit hex: after #RRGGBBAA it makes ten digits, after
 * #RGB five, after #RGBA six digits of a DIFFERENT colour (#66ff + "20" is #66ff20, an opaque green). The browser drops an
 * invalid inline value and keeps the previous one, so a tint spelt that way silently stays in the old colour.
 */

export interface ParsedHex {
  rgb: [number, number, number];
  /** 0..1; 1 for the three- and six-digit forms. */
  alpha: number;
}

/** The colour a hex spelling paints, with the hash (without it CSS paints nothing); `undefined` when it is not a hex. */
export function parseHexColor(hex: string): ParsedHex | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return undefined;
  const digits = match[1].length <= 4 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const byte = (at: number) => Number.parseInt(digits.slice(at, at + 2), 16);
  return { rgb: [byte(0), byte(2), byte(4)], alpha: digits.length === 8 ? byte(6) / 255 : 1 };
}

/**
 * `color` painted at `alphaHex` (two hex digits, e.g. "20"), as a valid CSS colour - or `undefined` when no honest tint
 * exists: the colour is not a hex, or it is translucent (what shows through is the theme, which this cannot see, so no
 * tint is claimed for it; the property is then left unset, never written invalid).
 *
 * A six-digit hex comes back as `${color}${alphaHex}` exactly as it was written (case included); the other opaque
 * spellings are normalised to the lower-case six-digit form first.
 */
export function tintOf(color: string, alphaHex: string): string | undefined {
  const parsed = parseHexColor(color);
  if (!parsed || parsed.alpha < 1) return undefined;
  const written = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(written)) return `${written}${alphaHex}`;
  const six = parsed.rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
  return `#${six}${alphaHex}`;
}
