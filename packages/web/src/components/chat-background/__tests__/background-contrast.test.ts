import { describe, expect, it } from 'vitest';
import { backgroundContrast, type Rgb, readableBackgroundOpacity } from '../background-contrast';

function pixels(color: Rgb) {
  const data = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) data.set([...color, 255], i * 4);
  return { data, width: 10, height: 10 };
}
const areas = [{ x: 0, y: 0, width: 10, height: 10 }];
describe('sharp background readability', () => {
  it('finds a passing high opacity when the unblended surface and midpoint are unreadable', () => {
    const image = pixels([157, 157, 157]);
    const palette = { veil: [147, 123, 105] as Rgb, text: [38, 32, 31] as Rgb };
    expect(backgroundContrast(image, areas, palette, 'light', 0)).toBeLessThan(4.5);
    expect(backgroundContrast(image, areas, palette, 'light', 0.2)).toBeLessThan(4.5);
    expect(backgroundContrast(image, areas, palette, 'light', 0.4)).toBeGreaterThanOrEqual(4.5);
    expect(readableBackgroundOpacity(image, areas, palette, 'light')).toBe(0.4);
  });
  it('keeps exact interpolated percentile contrast after optimizing opaque, translucent and repeated pixels', () => {
    const image = pixels([0, 0, 0]);
    for (let i = 0; i < 100; i++)
      image.data.set([(i * 71) % 256, (i * 37) % 256, (i * 13) % 256, [0, 90, 255, 255][i % 4]], i * 4);
    const linear = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    const light = (rgb: Rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    for (const palette of [
      { veil: [234, 228, 218] as Rgb, text: [88, 84, 84] as Rgb },
      { veil: [62, 61, 60] as Rgb, text: [177, 173, 172] as Rgb },
      { veil: [176, 84, 14] as Rgb, text: [253, 249, 248] as Rgb },
    ])
      for (const opacity of [0, 0.13, 0.2, 0.4]) {
        const text = light(palette.text);
        const lightText = text > light(palette.veil);
        const sorted = Array.from({ length: 100 }, (_, i) => {
          const alpha = (opacity * image.data[i * 4 + 3]) / 255;
          return light(
            palette.veil.map((v, channel) => v * (1 - alpha) + image.data[i * 4 + channel] * alpha) as unknown as Rgb,
          );
        }).sort((a, b) => a - b);
        const rank = 99 * (lightText ? 0.95 : 0.05);
        const low = sorted[Math.floor(rank)];
        const background = low + (sorted[Math.ceil(rank)] - low) * (rank - Math.floor(rank));
        const expected = lightText ? (text + 0.05) / (background + 0.05) : (background + 0.05) / (text + 0.05);
        expect(backgroundContrast(image, areas, palette, 'light', opacity)).toBeCloseTo(expected, 12);
      }
  });
  it('uses an inverse surface’s own contrast direction even in the light theme', () => {
    const image = pixels([255, 255, 255]);
    const palette = { veil: [105, 54, 30] as Rgb, text: [255, 255, 255] as Rgb };
    const opacity = readableBackgroundOpacity(image, areas, palette, 'light');
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(0.4);
    expect(backgroundContrast(image, areas, palette, 'light', opacity)).toBeGreaterThanOrEqual(4.5);
    expect(backgroundContrast(image, areas, palette, 'light', opacity + 0.01)).toBeLessThan(4.5);
  });
  it('finds the strongest passing whole percentage, rather than a fixed preference for every image', () => {
    const image = pixels([0, 0, 0]);
    const palette = { veil: [255, 251, 246] as Rgb, text: [111, 107, 99] as Rgb };
    const opacity = readableBackgroundOpacity(image, areas, palette, 'light');
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(0.1);
    expect(backgroundContrast(image, areas, palette, 'light', opacity)).toBeGreaterThanOrEqual(4.5);
    expect(backgroundContrast(image, areas, palette, 'light', opacity + 0.01)).toBeLessThan(4.5);
    expect(readableBackgroundOpacity(pixels(palette.veil), areas, palette, 'light')).toBe(0.4);
  });
  it('checks the bright 5% in dark mode and respects transparent pixels', () => {
    const palette = { veil: [24, 23, 21] as Rgb, text: [163, 158, 148] as Rgb };
    const bright = pixels([255, 255, 255]);
    const opacity = readableBackgroundOpacity(bright, areas, palette, 'dark');
    expect(opacity).toBeLessThan(0.2);
    expect(backgroundContrast(bright, areas, palette, 'dark', opacity)).toBeGreaterThanOrEqual(4.5);
    expect(backgroundContrast(bright, areas, palette, 'dark', opacity + 0.01)).toBeLessThan(4.5);
    bright.data.fill(0);
    expect(readableBackgroundOpacity(bright, areas, palette, 'dark')).toBe(0.4);
  });
  it('lets the weakest text area decide, without averaging it with a large safe region', () => {
    const image = pixels([255, 251, 246]);
    for (let i = 0; i < 20; i++) image.data.set([0, 0, 0, 255], i * 4);
    const palette = { veil: [255, 251, 246] as Rgb, text: [111, 107, 99] as Rgb };
    const textAreas = [
      { x: 0, y: 0, width: 10, height: 2 },
      { x: 0, y: 2, width: 10, height: 8 },
    ];
    expect(readableBackgroundOpacity(image, textAreas, palette, 'light')).toBeLessThan(0.1);
  });
});
