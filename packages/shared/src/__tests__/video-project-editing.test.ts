import { describe, expect, it } from 'vitest';
import {
  resizeVideoProjectSegment,
  type VideoProjectSegment,
  videoProjectSegmentSchema,
} from '../types/video-project.js';

function shot(mode: 'even' | 'explicit' = 'even'): VideoProjectSegment {
  const starts = mode === 'even' ? [0, 35, 70] : [0, 40, 70];
  return {
    id: 'C08',
    kind: 'shot',
    label: 'C08',
    startTick: 1359,
    durationTicks: 105,
    switchMode: mode,
    visuals: starts.map((startTick, index) => ({
      id: `C08-${index}`,
      assetVersionRef: `artwork-${index}`,
      startTick,
      endTick: starts[index + 1] ?? 105,
    })),
    extensions: [{ namespace: 'future.renderer', schemaVersion: 9, payload: { zoom: 0.8 } }],
  };
}

function rejects(segment: unknown) {
  expect(videoProjectSegmentSchema.safeParse(segment).success).toBe(false);
}

describe('video project asset switching and duration edits', () => {
  it('rejects an even sequence whose start or end contradicts ceil-based switching', () => {
    const value = shot();
    rejects({
      ...value,
      visuals: value.visuals.map((visual, index) => (index === 1 ? { ...visual, startTick: 36 } : visual)),
    });
    rejects({
      ...value,
      visuals: value.visuals.map((visual, index) => (index === 0 ? { ...visual, endTick: 34 } : visual)),
    });
  });

  it('requires explicit cuts from zero with ordered starts and derived ends', () => {
    const value = shot('explicit');
    rejects({
      ...value,
      visuals: value.visuals.map((visual, index) => (index === 0 ? { ...visual, startTick: 1 } : visual)),
    });
    rejects({
      ...value,
      visuals: value.visuals.map((visual, index) => (index === 0 ? { ...visual, endTick: 39 } : visual)),
    });
    rejects({ ...value, visuals: [value.visuals[0], value.visuals[2], value.visuals[1]] });
    rejects({
      ...value,
      visuals: value.visuals.map((visual, index) => (index === 2 ? { ...visual, endTick: 104 } : visual)),
    });
  });

  it('counts only asset-backed visuals while generated layers remain independent', () => {
    const value = shot();
    value.visuals.splice(1, 0, { id: 'UI', generated: { kind: 'ui' }, startTick: 10, endTick: 100 });
    expect(videoProjectSegmentSchema.parse(value)).toEqual(value);
    expect(
      videoProjectSegmentSchema.parse({
        ...value,
        visuals: value.visuals.filter((visual) => visual.generated !== undefined),
      }),
    ).toMatchObject({ switchMode: 'even' });
  });

  it('leaves unspecified switching free to overlap, begin later and use independent ends', () => {
    const value = shot();
    delete value.switchMode;
    value.visuals[0] = { ...value.visuals[0], startTick: 10, endTick: 95 };
    expect(videoProjectSegmentSchema.parse(value)).toEqual(value);
  });

  it('resizes C08 from 105 to 108 with C08c beginning at absolute tick 1431', () => {
    const value = shot();
    const before = structuredClone(value);
    const resized = resizeVideoProjectSegment(value, 108);
    expect(resized.durationTicks).toBe(108);
    expect(resized.visuals.map(({ startTick, endTick }) => [startTick, endTick])).toEqual([
      [0, 36],
      [36, 72],
      [72, 108],
    ]);
    expect(resized.startTick + (resized.visuals[2]?.startTick ?? -1)).toBe(1431);
    expect(resized.extensions).toEqual(value.extensions);
    expect(value).toEqual(before);
    if (
      resized.extensions?.[0]?.payload &&
      typeof resized.extensions[0].payload === 'object' &&
      !Array.isArray(resized.extensions[0].payload)
    ) {
      resized.extensions[0].payload.zoom = 2;
    }
    expect(value).toEqual(before);
  });

  it('uses ceil rather than rounded division, including the safe-integer boundary', () => {
    const resized = resizeVideoProjectSegment(shot(), 7);
    expect(resized.visuals.map(({ startTick, endTick }) => [startTick, endTick])).toEqual([
      [0, 3],
      [3, 5],
      [5, 7],
    ]);
    const huge = resizeVideoProjectSegment({ ...shot(), startTick: 0 }, Number.MAX_SAFE_INTEGER);
    expect(huge.visuals.map(({ startTick, endTick }) => [startTick, endTick])).toEqual([
      [0, 3002399751580331],
      [3002399751580331, 6004799503160661],
      [6004799503160661, Number.MAX_SAFE_INTEGER],
    ]);
  });

  it('preserves explicit starts while deriving only their ends from the next cut or new duration', () => {
    const resized = resizeVideoProjectSegment(shot('explicit'), 120);
    expect(resized.visuals.map(({ startTick, endTick }) => [startTick, endTick])).toEqual([
      [0, 40],
      [40, 70],
      [70, 120],
    ]);
    expect(resizeVideoProjectSegment(shot('explicit'), 80).visuals[2]?.endTick).toBe(80);
    expect(() => resizeVideoProjectSegment(shot('explicit'), 70)).toThrow();
    expect(() => resizeVideoProjectSegment(shot('explicit'), 69)).toThrow();
  });

  it('extends full-span generated layers and preserves independent times without scaling', () => {
    const value = shot();
    value.visuals.push(
      { id: 'full-ui', generated: { kind: 'ui' }, startTick: 0, endTick: 105 },
      { id: 'overlay', generated: { kind: 'overlay' }, startTick: 10, endTick: 90 },
    );
    const resized = resizeVideoProjectSegment(value, 108);
    expect(resized.visuals.find((visual) => visual.id === 'full-ui')).toMatchObject({ startTick: 0, endTick: 108 });
    expect(resized.visuals.find((visual) => visual.id === 'overlay')).toMatchObject({ startTick: 10, endTick: 90 });
    expect(() => resizeVideoProjectSegment(value, 80)).toThrow();
  });

  it('rejects invalid durations, collapsed cuts and already contradictory source segments', () => {
    for (const duration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2]) {
      expect(() => resizeVideoProjectSegment(shot(), duration)).toThrow();
    }
    const bad = shot();
    bad.visuals[0] = { ...bad.visuals[0], endTick: 34 };
    expect(() => resizeVideoProjectSegment(bad, 108)).toThrow();
  });

  it('returns a validation failure for invalid segment duration without throwing during ceil computation', () => {
    for (const durationTicks of [1.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
      const segment = { ...shot(), durationTicks };
      expect(() => videoProjectSegmentSchema.safeParse(segment)).not.toThrow();
      rejects(segment);
    }
  });
});
