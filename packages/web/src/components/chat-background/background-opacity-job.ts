import type { BackgroundOpacity } from '@cat-cafe/shared';
import { type BackgroundPalette, readableBackgroundOpacity, type SampleArea } from './background-contrast';

export interface ViewportSample {
  pixels: { data: Uint8ClampedArray; width: number; height: number };
  areas: SampleArea[];
}

export interface BackgroundOpacityJob {
  viewports: ViewportSample[];
  palettes: Record<'light' | 'dark', BackgroundPalette[]>;
}

/** The whole-percent search over every pixel: pure, so it runs off the interactive thread. */
export function readableOpacityFor(job: BackgroundOpacityJob): BackgroundOpacity {
  const opacity = { light: 0.4, dark: 0.4 };
  for (const { pixels, areas } of job.viewports) {
    for (const palette of job.palettes.light)
      opacity.light = Math.min(opacity.light, readableBackgroundOpacity(pixels, areas, palette, 'light'));
    for (const palette of job.palettes.dark)
      opacity.dark = Math.min(opacity.dark, readableBackgroundOpacity(pixels, areas, palette, 'dark'));
  }
  return opacity;
}
