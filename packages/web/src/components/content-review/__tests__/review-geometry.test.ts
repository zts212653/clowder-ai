import { describe, expect, it } from 'vitest';
import { browserTimeToTick, pointInMedia, regionBetween, tickToBrowserTime } from '../review-geometry';

describe('immutable media review coordinates', () => {
  it('ignores letterboxing and keeps pixel anchors identical under desktop/mobile resize', () => {
    const media = { width: 900, height: 600 };
    expect(pointInMedia({ x: 200, y: 110 }, { left: 20, top: 10, width: 900, height: 600 }, media)).toEqual({
      x: 180,
      y: 100,
    });
    expect(pointInMedia({ x: 70, y: 260 / 3 }, { left: 10, top: 20, width: 300, height: 200 }, media)?.x).toBeCloseTo(
      180,
    );
    const boxed = { left: 0, top: 0, width: 300, height: 300 };
    expect(pointInMedia({ x: 20, y: 20 }, boxed, media)).toBeNull();
    expect(pointInMedia({ x: 300, y: 300 }, boxed, media, true)).toEqual({ x: 900, y: 600 });
    expect(regionBetween({ x: 120, y: 150 }, { x: 20, y: 10 })).toEqual({
      kind: 'image-region',
      x: 20,
      y: 10,
      width: 100,
      height: 140,
    });
  });
  it('uses rational presentation timestamps instead of a guessed frame rate', () => {
    const media = {
      kind: 'video' as const,
      width: 1080,
      height: 1920,
      codedWidth: 1920,
      codedHeight: 1080,
      rotation: 90 as const,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      streamId: '0:0x1',
      streamIndex: 0,
      timebase: { numerator: 1, denominator: 90000 },
      startTick: 9000,
      durationTicks: 180000,
      containerStartSeconds: 0.1,
    };
    expect(browserTimeToTick(0.4, media)).toBe(36000);
    expect(tickToBrowserTime(45000, media)).toBeCloseTo(0.5);
    expect(browserTimeToTick(0.1, media)).toBe(media.startTick);
  });
  it('keeps the actual displayed nonzero MP4 presentation timestamp without applying its container offset twice', () => {
    const media = {
      kind: 'video' as const,
      width: 360,
      height: 640,
      codedWidth: 640,
      codedHeight: 360,
      rotation: 90 as const,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      streamId: '0:0x1',
      streamIndex: 0,
      timebase: { numerator: 1, denominator: 12800 },
      startTick: 25600,
      durationTicks: 37376,
      containerStartSeconds: 2,
    };
    // Real Chrome frame pixels matched independent FFmpeg frame 3, PTS 27136, at rVFC mediaTime=2.12.
    expect(browserTimeToTick(2.12, media)).toBe(27136);
    expect(tickToBrowserTime(27136, media)).toBe(2.12);
  });
});
