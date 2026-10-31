import { describe, expect, it } from 'vitest';
import { compareScreeningPosition } from '../video-project/compare-alignment';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

describe('frozen screening semantic alignment', () => {
  it('aligns a shorter new shot to the old stable shot and scales its playback rate', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)]);
    const next = comparisonSide('new', [comparisonShot('shot-1', 0, 50), comparisonShot('shot-2', 50, 100)]);
    expect(compareScreeningPosition(next, old, 2.5)).toEqual({ kind: 'aligned', leftMediaTime: 5, rateScale: 2 });
    expect(compareScreeningPosition(next, old, 10)).toEqual({ kind: 'aligned', leftMediaTime: 15, rateScale: 1 });
  });
  it('preserves each media start/timebase through inserted and resized shots', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)], 0, 1000);
    const next = comparisonSide(
      'new',
      [comparisonShot('shot-1', 0, 100), comparisonShot('new-shot', 100, 50), comparisonShot('shot-2', 150, 50)],
      0,
      5000,
    );
    expect(compareScreeningPosition(next, old, 22.5)).toEqual({ kind: 'aligned', leftMediaTime: 16, rateScale: 2 });
    expect(compareScreeningPosition(next, old, 16)).toEqual({ kind: 'missing', reason: 'segment-missing' });
  });
  it('uses a shared active VisualUse position when its appearance interval moved', () => {
    const before = comparisonShot('shot-1', 0, 100),
      after = comparisonShot('shot-1', 0, 100);
    before.visuals = [{ id: 'actor', generated: { color: 'red' }, startTick: 50, endTick: 90 }];
    after.visuals = [{ id: 'actor', generated: { color: 'blue' }, startTick: 10, endTick: 30 }];
    expect(compareScreeningPosition(comparisonSide('new', [after]), comparisonSide('old', [before]), 2)).toEqual({
      kind: 'aligned',
      leftMediaTime: 7,
      rateScale: 2,
    });
  });
  it('does not turn a mapping hole or unmapped ending into equal elapsed seconds', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100)]);
    const next = comparisonSide('new', [comparisonShot('shot-1', 0, 100)], 50);
    expect(compareScreeningPosition(next, old, 12)).toEqual({ kind: 'missing', reason: 'unmapped' });
    old.screening.mapping.segments = [
      { ...old.screening.mapping.segments[0], projectStartTick: 50, mediaStartPts: 5000 },
    ];
    expect(compareScreeningPosition(next, old, 2)).toEqual({ kind: 'missing', reason: 'unmapped' });
  });
  it('keeps an explicitly selected absent visual missing instead of borrowing a sibling', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100)]);
    const next = comparisonSide('new', [comparisonShot('shot-1', 0, 100)]);
    expect(compareScreeningPosition(next, old, 2, 'missing-visual')).toEqual({
      kind: 'missing',
      reason: 'visual-missing',
    });
  });
  it('rejects a head snapshot substituted for the frozen selected input', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100)]);
    const next = comparisonSide('new', [comparisonShot('shot-1', 0, 100)]);
    next.input = { ...next.input, ownerRevision: 3 };
    expect(compareScreeningPosition(next, old, 2)).toEqual({ kind: 'missing', reason: 'input-mismatch' });
  });
  it('uses independently probed media timebases and piecewise playback speeds', () => {
    const old = comparisonSide('old', [comparisonShot('shot-1', 0, 100)]);
    const next = comparisonSide('new', [comparisonShot('shot-1', 0, 100)]);
    old.screening.media.media.timebase = { numerator: 1, denominator: 2000 };
    expect(compareScreeningPosition(next, old, 5)).toEqual({ kind: 'aligned', leftMediaTime: 2.5, rateScale: 0.5 });
    old.screening.media.media.timebase = { numerator: 1, denominator: 1000 };
    old.screening.mapping.segments[0].mediaEndPts = 1000;
    next.screening.mapping.segments = [
      { mediaStartPts: 0, mediaEndPts: 5000, projectStartTick: 0, projectEndTick: 50, refs: ['render:1'] },
      { mediaStartPts: 5000, mediaEndPts: 6000, projectStartTick: 50, projectEndTick: 100, refs: ['render:1'] },
    ];
    const firstPiece = compareScreeningPosition(next, old, 2.5);
    expect(firstPiece).toMatchObject({ kind: 'aligned', leftMediaTime: 0.25 });
    if (firstPiece.kind === 'aligned') expect(firstPiece.rateScale).toBeCloseTo(0.1, 12);
    expect(compareScreeningPosition(next, old, 5.5)).toEqual({ kind: 'aligned', leftMediaTime: 0.75, rateScale: 0.5 });
  });
});
