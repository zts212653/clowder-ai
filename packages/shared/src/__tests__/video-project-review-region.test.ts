import { describe, expect, it } from 'vitest';
import { videoProjectScreeningSelectionSchema } from '../types/video-project-message.js';
import * as review from '../types/video-project-review.js';
import { displayRegionToProjectCanvas } from '../types/video-project-screening-frame.js';
import { digest } from './video-project.fixtures.js';
import { screening } from './video-project-screening.fixtures.js';

const displayRegion = {
  coordinateSpace: 'display-pixels' as const,
  width: 1280,
  height: 720,
  rotation: 0 as const,
  bbox: { x: 128, y: 72, width: 256, height: 144 },
};
const canvasRegion = {
  coordinateSpace: 'canvas-pixels' as const,
  width: 1920,
  height: 1080,
  rotation: 0 as const,
  bbox: { x: 192, y: 108, width: 384, height: 216 },
};

describe('explicit project review coordinate spaces', () => {
  it('keeps the original display region and its serialization exactly unchanged', () => {
    const old = { ...displayRegion, rotation: 180 as const };
    expect(review.videoProjectReviewRegionSchema.parse(old)).toEqual(old);
    expect(JSON.stringify(review.videoProjectReviewRegionSchema.parse(old))).toBe(JSON.stringify(old));
  });
  it('roundtrips canvas coordinates only as an explicit moment variant', () => {
    expect(review.videoProjectCanvasRegionSchema.parse(canvasRegion)).toEqual(canvasRegion);
    const target = {
      kind: 'moment' as const,
      tick: 10,
      endTick: 20,
      timebase: { numerator: 1, denominator: 30 },
      region: canvasRegion,
    };
    expect(review.videoProjectReviewTargetSchema.parse(target)).toEqual(target);
    const anchor = { kind: 'video-project' as const, baseRevision: digest, baseOwnerRevision: 1, target };
    expect(review.videoProjectReviewAnchorSchema.parse(JSON.parse(JSON.stringify(anchor)))).toEqual(anchor);
  });
  it('preserves both the original display evidence and separately mapped canonical target', () => {
    const region = displayRegionToProjectCanvas(screening(), displayRegion);
    const selection = {
      id: 'select-1',
      mediaRange: { startPts: 0, endPts: 512 },
      displayRegion,
      target: { kind: 'moment' as const, tick: 0, endTick: 1, timebase: { numerator: 1, denominator: 30 }, region },
    };
    expect(videoProjectScreeningSelectionSchema.parse(selection)).toEqual(selection);
  });
  it('keeps artwork and original display evidence display-only', () => {
    expect(review.videoProjectReviewRegionSchema.safeParse(canvasRegion).success).toBe(false);
    expect(
      review.videoProjectReviewTargetSchema.safeParse({
        kind: 'artwork',
        assetVersionRef: 'image-1',
        region: canvasRegion,
      }).success,
    ).toBe(false);
    expect(
      videoProjectScreeningSelectionSchema.safeParse({
        id: 'select-1',
        mediaRange: { startPts: 0, endPts: 512 },
        target: { kind: 'project' },
        displayRegion: canvasRegion,
      }).success,
    ).toBe(false);
  });
  it('rejects unsupported spaces, overflow, and canvas orientation metadata', () => {
    for (const region of [
      { ...canvasRegion, coordinateSpace: 'css-pixels' },
      { ...canvasRegion, rotation: 90 },
      { ...canvasRegion, width: 0 },
      { ...canvasRegion, bbox: { ...canvasRegion.bbox, x: 1800 } },
      { ...canvasRegion, guessedDisplayWidth: 1280 },
    ])
      expect(review.videoProjectCanvasRegionSchema.safeParse(region).success).toBe(false);
  });
});
