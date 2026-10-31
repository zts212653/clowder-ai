import { describe, expect, it } from 'vitest';
import * as video from '../types/video-project.js';
import { videoProjectCanvasRegionSchema } from '../types/video-project-review.js';
import { screening } from './video-project-screening.fixtures.js';

describe('decoded display to project canvas mapping', () => {
  it('uses explicit letterbox content bounds and keeps canvas coordinates separate', () => {
    const value = screening();
    const withBars = {
      ...value,
      mapping: {
        ...value.mapping,
        frame: {
          ...value.mapping.frame,
          contentRect: { x: 0, y: 100, width: 1280, height: 520 },
        },
      },
    };
    const region = {
      coordinateSpace: 'display-pixels' as const,
      width: 1280,
      height: 720,
      rotation: 0 as const,
      bbox: { x: 128, y: 152, width: 256, height: 104 },
    };
    expect(video.displayRegionToProjectCanvas(withBars, region)).toEqual({
      coordinateSpace: 'canvas-pixels',
      width: 1920,
      height: 1080,
      rotation: 0,
      bbox: { x: 192, y: 108, width: 384, height: 216 },
    });
    expect(video.displayRegionToProjectCanvas(withBars, { ...region, bbox: { ...region.bbox, y: 0 } })).toBe(null);
    expect(video.displayPointToProjectCanvas(withBars, { x: 0, y: 99 })).toBe(null);
    expect(video.displayPointToProjectCanvas(withBars, { x: 0, y: 100 })).toEqual({ x: 0, y: 0 });
  });
  it.each([
    [0, 0, 0],
    [90, 0, 1080],
    [180, 1920, 1080],
    [270, 1920, 0],
  ] as const)('undoes canvas-to-display rotation %s', (rotation, x, y) => {
    const value = screening();
    const rotated = { ...value, mapping: { ...value.mapping, frame: { ...value.mapping.frame, rotation } } };
    expect(video.displayPointToProjectCanvas(rotated, { x: 0, y: 0 })).toEqual({ x, y });
  });
  it.each([
    [0, 192, 108, 384, 216],
    [90, 192, 756, 384, 216],
    [180, 1344, 756, 384, 216],
    [270, 1344, 108, 384, 216],
  ] as const)('maps rotation %s to an independently parseable canvas rectangle', (rotation, x, y, width, height) => {
    const value = screening();
    const rotated = { ...value, mapping: { ...value.mapping, frame: { ...value.mapping.frame, rotation } } };
    const region = {
      coordinateSpace: 'display-pixels' as const,
      width: 1280,
      height: 720,
      rotation: 0 as const,
      bbox: { x: 128, y: 72, width: 256, height: 144 },
    };
    const original = structuredClone(region);
    const mapped = videoProjectCanvasRegionSchema.parse(video.displayRegionToProjectCanvas(rotated, region));
    expect(mapped.coordinateSpace).toBe('canvas-pixels');
    expect(mapped.bbox.x).toBeCloseTo(x, 10);
    expect(mapped.bbox.y).toBeCloseTo(y, 10);
    expect(mapped.bbox.width).toBe(width);
    expect(mapped.bbox.height).toBe(height);
    expect(region).toEqual(original);
  });
  it('rejects mismatching display dimensions, invalid pixels and clipped boxes', () => {
    const region = {
      coordinateSpace: 'display-pixels' as const,
      width: 1920,
      height: 1080,
      rotation: 0 as const,
      bbox: { x: 100, y: 100, width: 100, height: 100 },
    };
    expect(video.displayRegionToProjectCanvas(screening(), region)).toBe(null);
    for (const point of [
      { x: -1, y: 0 },
      { x: 1280, y: 0 },
      { x: NaN, y: 0 },
    ])
      expect(video.displayPointToProjectCanvas(screening(), point)).toBe(null);
    const value = screening();
    expect(
      video.videoProjectScreeningSchema.safeParse({
        ...value,
        mapping: {
          ...value.mapping,
          frame: {
            ...value.mapping.frame,
            contentRect: { x: 0, y: 700, width: 1280, height: 30 },
          },
        },
      }).success,
    ).toBe(false);
  });
});
