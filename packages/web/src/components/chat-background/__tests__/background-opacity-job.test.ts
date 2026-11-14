import { expect, it } from 'vitest';
import { type BackgroundPalette, readableBackgroundOpacity, type SampleArea } from '../background-contrast';
import { readableOpacityFor, type ViewportSample } from '../background-opacity-job';

function viewport(width: number, height: number, shade: (x: number, y: number) => number): ViewportSample {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data.set([shade(x, y), shade(x, y), shade(x, y), 255], offset);
    }
  const areas: SampleArea[] = [
    { x: 0, y: 0, width, height: height / 2 },
    { x: 0, y: height / 2, width, height: height / 2 },
  ];
  return { pixels: { data, width, height }, areas };
}

it('keeps the strictest readable limit across every viewport and palette, as the main-thread search did', () => {
  const viewports = [viewport(24, 16, (x) => x * 10), viewport(12, 20, (_, y) => 255 - y * 12)];
  const palettes: Record<'light' | 'dark', BackgroundPalette[]> = {
    light: [
      { veil: [250, 248, 244], text: [40, 36, 32] },
      { veil: [236, 230, 222], text: [96, 88, 80] },
    ],
    dark: [{ veil: [28, 26, 24], text: [232, 228, 220] }],
  };
  const expected = { light: 0.4, dark: 0.4 };
  for (const { pixels, areas } of viewports) {
    for (const palette of palettes.light)
      expected.light = Math.min(expected.light, readableBackgroundOpacity(pixels, areas, palette, 'light'));
    for (const palette of palettes.dark)
      expected.dark = Math.min(expected.dark, readableBackgroundOpacity(pixels, areas, palette, 'dark'));
  }
  expect(readableOpacityFor({ viewports, palettes })).toEqual(expected);
  expect(expected.light).toBeLessThan(0.4);
});
