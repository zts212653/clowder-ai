import { describe, expect, it } from 'vitest';
import { type PianoRowMeasurement, pianoKeyAtOffset, projectPianoGeometry } from '../message-piano/piano-geometry';

const row = (id: string, top: number, bottom: number): PianoRowMeasurement => ({
  id,
  top,
  bottom,
  error: false,
  awaitingResponse: false,
});

describe('one real scale for piano keys and the viewport', () => {
  it('preserves header/footer blank space, unequal heights, and preceding-row gaps', () => {
    const geometry = projectPianoGeometry(
      [row('short', 50, 100), row('long', 120, 420), row('last', 420, 600)],
      1000,
      200,
      400,
      100,
    );
    expect(geometry?.keys.map((key) => key.id)).toEqual(['short', 'long', 'last']);
    for (const [index, [top, height]] of [
      [5, 7],
      [12, 30],
      [42, 18],
    ].entries()) {
      expect(geometry?.keys[index].trackTop).toBeCloseTo(top, 12);
      expect(geometry?.keys[index].trackHeight).toBeCloseTo(height, 12);
    }
    expect(geometry?.thumbTop).toBe(40);
    expect(geometry?.thumbHeight).toBe(20);
  });

  it('omits zero-height carriers while preserving exact subpixel keys for nine hundred rows', () => {
    const rows = [row('carrier', 0, 0), ...Array.from({ length: 900 }, (_, i) => row(`m-${i}`, i + 50, i + 51))];
    const geometry = projectPianoGeometry(rows, 1000, 20, 980, 100);
    expect(geometry?.keys).toHaveLength(900);
    expect(geometry?.keys[0].trackTop).toBe(5);
    expect(geometry?.keys[0].trackHeight).toBe(0.1);
    expect(geometry?.thumbHeight).toBe(3);
    expect(geometry?.grabHeight).toBe(16);
    expect(geometry?.grabTop).toBe(84);
    expect(geometry?.thumbTop).toBe(97);
  });

  it.each([-100, 0, 1000])('keeps visual and pointer bands inside the track at scroll position %i', (scrollTop) => {
    const geometry = projectPianoGeometry([row('m', 0, 1000)], 1000, 10, scrollTop, 50);
    expect(geometry).not.toBeNull();
    expect(geometry?.thumbTop).toBeGreaterThanOrEqual(0);
    expect((geometry?.thumbTop ?? 0) + (geometry?.thumbHeight ?? 0)).toBeLessThanOrEqual(50);
    expect(geometry?.grabTop).toBeGreaterThanOrEqual(0);
    expect((geometry?.grabTop ?? 0) + (geometry?.grabHeight ?? 0)).toBeLessThanOrEqual(50);
  });

  it('locates dense individual targets without coalescing adjacent rows', () => {
    const geometry = projectPianoGeometry(
      Array.from({ length: 900 }, (_, i) => row(`m-${i}`, i, i + 1)),
      1000,
      100,
      400,
      200,
    );
    expect(geometry).not.toBeNull();
    const keys = geometry?.keys ?? [];
    expect(pianoKeyAtOffset(keys, 421.5)).toBe(421);
    expect(pianoKeyAtOffset(keys, -20)).toBe(0);
    expect(pianoKeyAtOffset(keys, 1100)).toBe(899);
  });

  it.each([
    [100, 100, 50],
    [1000, 100, 0],
    [Number.NaN, 100, 50],
  ])('retains the native indicator when geometry cannot operate (%j)', (content, viewport, track) => {
    expect(projectPianoGeometry([row('m', 0, 100)], content, viewport, 0, track)).toBeNull();
  });

  it('does not replace the indicator when all loaded rows are empty carriers', () => {
    expect(projectPianoGeometry([row('empty', 500, 500)], 1000, 100, 400, 200)).toBeNull();
  });
});
