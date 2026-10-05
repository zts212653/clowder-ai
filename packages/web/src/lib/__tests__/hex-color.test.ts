import { describe, expect, it } from 'vitest';
import { parseHexColor, tintOf } from '../hex-color';

/**
 * F322 B — the tint behind a reply pill/bar is the identity colour at a fixed alpha. Appending the alpha byte to the string
 * is only a colour for a six-digit hex, so the tint is built from the parsed colour instead.
 */
describe('parseHexColor', () => {
  it('reads the 3, 4, 6 and 8 digit spellings, with the hash', () => {
    expect(parseHexColor('#6666ff')).toEqual({ rgb: [102, 102, 255], alpha: 1 });
    expect(parseHexColor('#66f')).toEqual({ rgb: [102, 102, 255], alpha: 1 });
    expect(parseHexColor('#66ff')).toEqual({ rgb: [102, 102, 255], alpha: 1 });
    expect(parseHexColor('#6666ffff')).toEqual({ rgb: [102, 102, 255], alpha: 1 });
    expect(parseHexColor('#6666ff80')?.alpha).toBeCloseTo(128 / 255, 5);
    expect(parseHexColor('#66f8')?.alpha).toBeCloseTo(136 / 255, 5);
  });

  it('is not a hex without the hash, with a wrong length, or as another CSS colour', () => {
    for (const bad of ['6666ff', '#6666f', '#6666ff0', '#6666ff000', 'rgb(1,2,3)', 'var(--x)', '', 'red', '#gggggg']) {
      expect(parseHexColor(bad), bad).toBeUndefined();
    }
  });
});

describe('tintOf', () => {
  it('returns a six-digit hex exactly as written with the alpha byte after it (case kept)', () => {
    expect(tintOf('#6666ff', '20')).toBe('#6666ff20');
    expect(tintOf('#8B5CF6', '18')).toBe('#8B5CF618');
    expect(tintOf('#8b5cf6', '20')).toBe('#8b5cf620');
  });

  it('gives an opaque 3, 4 or 8 digit spelling the same tint as its six-digit form', () => {
    for (const spelling of ['#66f', '#66F', '#66ff', '#6666ffff', '#6666FFFF']) {
      expect(tintOf(spelling, '20'), spelling).toBe('#6666ff20');
    }
    expect(tintOf('#abc', '18')).toBe('#aabbcc18');
  });

  it('makes no tint for a translucent colour or for something that is not a hex (the property is left unset)', () => {
    for (const none of [
      '#6666ff80',
      '#66f8',
      '#6666ff00',
      'rgba(1,2,3,.5)',
      'var(--cat-x)',
      'hsl(0 0% 0%)',
      '',
      'oops',
    ]) {
      expect(tintOf(none, '20'), none).toBeUndefined();
    }
  });

  it('never returns a string that is not a valid six-digit-plus-alpha hex', () => {
    for (const spelling of ['#6666ff', '#66f', '#66ff', '#6666ffff', '#ABCDEF', '#fff', '#000000']) {
      expect(tintOf(spelling, '20'), spelling).toMatch(/^#[0-9a-f]{8}$/i);
    }
  });
});
