import { describe, expect, it } from 'vitest';
import { inkContrast, readableInkOn } from '../readable-ink';

/**
 * F322 B — text drawn on an identity-colour fill (the owner avatar's "ME", an initial on a cat disc) must read on the fill
 * the user configured, not on the theme's surface: a fill can be dark in a dark theme and the surface dark too. The ink is
 * chosen from the fill itself, never from a hex someone wrote beside it.
 */
describe('readableInkOn', () => {
  it('picks light ink on the cocoa default and on the saved reddish colour, dark ink on the light cocoa', () => {
    expect(readableInkOn('#6B5443')).toBe('#ffffff');
    expect(readableInkOn('#815b5b')).toBe('#ffffff');
    expect(readableInkOn('#E9DCCF')).toBe('#000000');
  });

  it('always reads: whatever the fill, the chosen ink is at least 4.5:1 on it', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const fill = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          const ink = readableInkOn(fill);
          expect(ink, fill).toBeDefined();
          expect(inkContrast(ink as string, fill), `${fill} with ${ink}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('says nothing for something that is not a hex colour, instead of guessing an ink', () => {
    for (const bad of ['', 'red', '#12', '#12345', 'var(--x)', 'oklch(0.5 0.1 20)', '#gggggg']) {
      expect(readableInkOn(bad), bad).toBeUndefined();
    }
  });

  it('accepts the short form and any case', () => {
    expect(readableInkOn('#FFF')).toBe('#000000');
    expect(readableInkOn('#000')).toBe('#ffffff');
  });

  it('takes every spelling of an opaque colour the CSS and the config accept, and picks the same ink as the 6-digit form', () => {
    // The config chain (humanColorState, hexToOklch) accepts #RRGGBBAA, and CSS paints #RRGGBBAA / #RGBA; an opaque one
    // (alpha ff / f) is the same fill as without alpha, so it must get the same ink - not the theme-surface fallback.
    for (const [eight, six] of [
      ['#6666ffff', '#6666ff'],
      ['#6666FFFF', '#6666ff'],
      ['#6B5443ff', '#6B5443'],
      ['#E9DCCFFF', '#E9DCCF'],
      ['#000000ff', '#000000'],
    ] as const) {
      expect(readableInkOn(eight), eight).toBe(readableInkOn(six));
    }
    expect(readableInkOn('#fffF')).toBe(readableInkOn('#fff'));
    expect(readableInkOn('#000F')).toBe(readableInkOn('#000'));
  });

  it('keeps the 4.5:1 guarantee over opaque 8-digit fills too', () => {
    for (let r = 0; r <= 255; r += 85) {
      for (let g = 0; g <= 255; g += 85) {
        for (let b = 0; b <= 255; b += 85) {
          const fill = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}ff`;
          const ink = readableInkOn(fill);
          expect(ink, fill).toBeDefined();
          expect(inkContrast(ink as string, fill.slice(0, 7)), fill).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('makes no claim for a translucent fill: what shows through is the theme, which this function cannot see', () => {
    for (const translucent of ['#6666ff80', '#6666ff00', '#6666fffe', '#0000', '#fff8']) {
      expect(readableInkOn(translucent), translucent).toBeUndefined();
    }
  });

  it('says nothing for a spelling CSS would not paint as a colour, since then there is no fill to write on', () => {
    for (const unpainted of ['6666ff', '#6666f', '#6666ffffff', '##6666ff', ' #6666ff x']) {
      expect(readableInkOn(unpainted), unpainted).toBeUndefined();
    }
  });
});
