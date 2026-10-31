import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFeatureIds } from '../dist/types/cross-thread-affordance.js';

describe('extractFeatureIds (F193 Phase E)', () => {
  it('extracts F-IDs from text', () => {
    assert.deepStrictEqual(extractFeatureIds('Fix F193 bug in F209'), ['F193', 'F209']);
  });

  it('deduplicates', () => {
    assert.deepStrictEqual(extractFeatureIds('F193 and F193 again'), ['F193']);
  });

  it('returns sorted', () => {
    assert.deepStrictEqual(extractFeatureIds('F209 then F042'), ['F042', 'F209']);
  });

  it('returns empty for no matches', () => {
    assert.deepStrictEqual(extractFeatureIds('no feature ids here'), []);
  });

  it('ignores partial matches', () => {
    // "F1" is too short (< 2 digits), "F12345" has 5 digits (> 4)
    assert.deepStrictEqual(extractFeatureIds('F1 and F12345'), []);
  });

  it('extracts from mixed text with feature IDs', () => {
    assert.deepStrictEqual(extractFeatureIds('Task: fix F193 cross-thread bug, relates to F128 propose_thread'), [
      'F128',
      'F193',
    ]);
  });

  it('handles word boundaries correctly', () => {
    // "STUFF42" should not match, but "F42" should
    assert.deepStrictEqual(extractFeatureIds('STUFF42 vs F42'), ['F42']);
  });

  // P1-1 fix: lowercase f support
  it('extracts lowercase f-IDs and normalizes to uppercase', () => {
    assert.deepStrictEqual(extractFeatureIds('fix f209 bug'), ['F209']);
  });

  it('handles mixed case F/f IDs', () => {
    assert.deepStrictEqual(extractFeatureIds('F193 and f209'), ['F193', 'F209']);
  });

  it('deduplicates across case variants', () => {
    assert.deepStrictEqual(extractFeatureIds('F193 and f193'), ['F193']);
  });
});
