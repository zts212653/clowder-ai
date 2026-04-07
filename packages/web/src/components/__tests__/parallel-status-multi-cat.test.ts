import { describe, expect, it } from 'vitest';
import { deriveActiveCats } from '../parallel-status-helpers';

describe('deriveActiveCats', () => {
  it('returns targetCats when no activeInvocations exist', () => {
    const result = deriveActiveCats(['opus', 'codex'], {});
    expect(result).toEqual(['opus', 'codex']);
  });

  it('returns cats from activeInvocations when targetCats is empty', () => {
    const result = deriveActiveCats([], {
      'inv-1': { catId: 'opus', mode: 'ideate' },
      'inv-2': { catId: 'codex', mode: 'ideate' },
    });
    expect(result).toEqual(expect.arrayContaining(['opus', 'codex']));
    expect(result).toHaveLength(2);
  });

  it('returns deduped union when cats overlap', () => {
    const result = deriveActiveCats(['opus'], {
      'inv-1': { catId: 'opus', mode: 'ideate' },
      'inv-2': { catId: 'codex', mode: 'ideate' },
    });
    expect(result).toEqual(expect.arrayContaining(['opus', 'codex']));
    expect(result).toHaveLength(2);
  });

  it('returns empty when both sources are empty', () => {
    const result = deriveActiveCats([], {});
    expect(result).toEqual([]);
  });

  it('preserves targetCats order, appending new cats from activeInvocations', () => {
    const result = deriveActiveCats(['opus'], {
      'inv-1': { catId: 'codex', mode: 'ideate' },
    });
    expect(result[0]).toBe('opus');
    expect(result[1]).toBe('codex');
  });

  it('dedupes multiple invocations for the same cat', () => {
    const result = deriveActiveCats(['opus'], {
      'inv-1': { catId: 'opus', mode: 'ideate' },
      'inv-2': { catId: 'opus', mode: 'ideate' },
      'inv-3': { catId: 'codex', mode: 'ideate' },
    });
    expect(result).toEqual(expect.arrayContaining(['opus', 'codex']));
    expect(result).toHaveLength(2);
  });

  it('multi-mention: second cat only in activeInvocations, not yet in targetCats', () => {
    const result = deriveActiveCats(['opus'], {
      'inv-main': { catId: 'opus', mode: 'ideate' },
      'inv-main-codex': { catId: 'codex', mode: 'ideate' },
    });
    expect(result).toEqual(expect.arrayContaining(['opus', 'codex']));
    expect(result).toHaveLength(2);
  });

  it('handles undefined activeInvocations gracefully', () => {
    const result = deriveActiveCats(['opus'], undefined);
    expect(result).toEqual(['opus']);
  });

  it('handles null activeInvocations gracefully', () => {
    const result = deriveActiveCats(['opus'], null);
    expect(result).toEqual(['opus']);
  });
});
