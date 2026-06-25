import { describe, expect, it } from 'vitest';
import { hexToOklch, tintedLight } from '../color-utils';

describe('tintedLight', () => {
  it('blends hex color toward white at given ratio', () => {
    // Pure black (#000000) at 0.08 toward white → rgb(242, 242, 242) (white * 0.92 + black * 0.08)
    // Actually: base + (accent - base) * ratio = 255 + (0 - 255) * 0.08 = 255 - 20.4 = 235
    const result = tintedLight('#000000', 0.08);
    expect(result).toBe('rgb(235, 235, 235)');
  });

  it('returns near-white for low ratio with a colored accent', () => {
    // Ragdoll primary #7C9FD4 at 0.08 toward white
    // R: 255 + (124 - 255) * 0.08 = 255 - 10.48 = 244.52 → 245
    // G: 255 + (159 - 255) * 0.08 = 255 - 7.68 = 247.32 → 247
    // B: 255 + (212 - 255) * 0.08 = 255 - 3.44 = 251.56 → 252
    const result = tintedLight('#7C9FD4', 0.08);
    expect(result).toBe('rgb(245, 247, 252)');
  });

  it('returns the accent color itself at ratio 1.0', () => {
    const result = tintedLight('#FF0000', 1.0);
    expect(result).toBe('rgb(255, 0, 0)');
  });

  it('returns white at ratio 0', () => {
    const result = tintedLight('#FF0000', 0);
    expect(result).toBe('rgb(255, 255, 255)');
  });
});

describe('hexToOklch (F056 Phase E AC-E4 migration helper)', () => {
  /** 算法正确性 — pure RGB primaries with W3C reference values */
  it('white #FFFFFF → L=1, C=0', () => {
    const { l, c } = hexToOklch('#FFFFFF');
    expect(l).toBeCloseTo(1, 3);
    expect(c).toBeCloseTo(0, 3);
  });

  it('black #000000 → L=0, C=0', () => {
    const { l, c } = hexToOklch('#000000');
    expect(l).toBeCloseTo(0, 3);
    expect(c).toBeCloseTo(0, 3);
  });

  it('pure red #FF0000 → L≈0.628, C≈0.258, H≈29° (warm-red zone)', () => {
    const { l, c, h } = hexToOklch('#FF0000');
    expect(l).toBeCloseTo(0.628, 2);
    expect(c).toBeGreaterThan(0.2);
    expect(h).toBeGreaterThan(25);
    expect(h).toBeLessThan(35);
  });

  it('pure green #00FF00 → L≈0.866, H≈142° (green zone)', () => {
    const { l, c, h } = hexToOklch('#00FF00');
    expect(l).toBeCloseTo(0.866, 2);
    expect(c).toBeGreaterThan(0.2);
    expect(h).toBeGreaterThan(135);
    expect(h).toBeLessThan(150);
  });

  it('pure blue #0000FF → L≈0.452, H≈264° (blue zone)', () => {
    const { l, c, h } = hexToOklch('#0000FF');
    expect(l).toBeCloseTo(0.452, 2);
    expect(c).toBeGreaterThan(0.2);
    expect(h).toBeGreaterThan(258);
    expect(h).toBeLessThan(270);
  });

  /** Cat catalog real hex — verify hue classification + chroma > 0
   *  (具体 L/C/H 值由算法生成，作为 schema migration 输入，无需 pin) */
  it('opus 紫 #9B7EBD → H 落在紫色色相 (280°-310°)', () => {
    const { c, h } = hexToOklch('#9B7EBD');
    expect(c).toBeGreaterThan(0.05); // 有明显彩度
    expect(h).toBeGreaterThan(280);
    expect(h).toBeLessThan(315);
  });

  it('codex 绿 #5B8C5A → H 落在绿色色相 (130°-160°)', () => {
    const { c, h } = hexToOklch('#5B8C5A');
    expect(c).toBeGreaterThan(0.05);
    expect(h).toBeGreaterThan(130);
    expect(h).toBeLessThan(160);
  });

  it('gemini 蓝 #5B9BD5 → H 落在蓝色色相 (225°-260°)', () => {
    const { c, h } = hexToOklch('#5B9BD5');
    expect(c).toBeGreaterThan(0.05);
    expect(h).toBeGreaterThan(225);
    expect(h).toBeLessThan(260);
  });

  it('cocreator 橙 #E29578 → H 落在暖橙色相 (30°-50°)', () => {
    const { c, h } = hexToOklch('#E29578');
    expect(c).toBeGreaterThan(0.05);
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThan(50);
  });

  /** Parser robustness */
  it('accepts hex without leading #', () => {
    const withHash = hexToOklch('#5B8C5A');
    const noHash = hexToOklch('5B8C5A');
    expect(withHash.l).toBeCloseTo(noHash.l, 6);
    expect(withHash.c).toBeCloseTo(noHash.c, 6);
    expect(withHash.h).toBeCloseTo(noHash.h, 4);
  });

  it('throws on empty string', () => {
    expect(() => hexToOklch('')).toThrow('Invalid hex color');
  });

  it('throws on invalid characters', () => {
    expect(() => hexToOklch('#zzzzzz')).toThrow('Invalid hex color');
  });

  it('throws on wrong length', () => {
    expect(() => hexToOklch('#12')).toThrow('Invalid hex color');
    expect(() => hexToOklch('#12345')).toThrow('Invalid hex color');
  });

  it('rejects 4-digit #RGBA shorthand (unsupported)', () => {
    expect(() => hexToOklch('#abcd')).toThrow('Invalid hex color');
  });

  it('parses 3-digit hex shorthand to same color as 6-digit', () => {
    // #F00 should be ≈ #FF0000 (both pure red)
    const short = hexToOklch('#F00');
    const long = hexToOklch('#FF0000');
    expect(short.l).toBeCloseTo(long.l, 2);
    expect(short.h).toBeCloseTo(long.h, 1);
  });
});
