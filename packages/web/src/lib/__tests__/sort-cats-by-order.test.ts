import { describe, expect, it } from 'vitest';
import { sortCatsByOrder } from '../sort-cats-by-order';

describe('sortCatsByOrder', () => {
  const cats = [
    { id: 'opus' },
    { id: 'sonnet' },
    { id: 'opus-45' },
    { id: 'opus-47' },
    { id: 'codex' },
    { id: 'gpt52' },
  ];

  it('returns cats unchanged when catOrder is empty', () => {
    expect(sortCatsByOrder(cats, [])).toEqual(cats);
  });

  it('pins cats in catOrder order first, preserves original order for rest', () => {
    const result = sortCatsByOrder(cats, ['opus-47', 'gpt52']);
    expect(result.map((c) => c.id)).toEqual(['opus-47', 'gpt52', 'opus', 'sonnet', 'opus-45', 'codex']);
  });

  it('ignores catIds in catOrder that do not exist in cats', () => {
    const result = sortCatsByOrder(cats, ['ghost', 'opus-47']);
    expect(result[0]!.id).toBe('opus-47');
    expect(result).toHaveLength(cats.length);
  });

  it('does not mutate input array', () => {
    const original = [...cats];
    sortCatsByOrder(cats, ['opus-47']);
    expect(cats).toEqual(original);
  });

  it('deduplicates catOrder ids — each cat appears at most once', () => {
    const result = sortCatsByOrder(cats, ['opus', 'opus', 'codex', 'codex']);
    const ids = result.map((c) => c.id);
    expect(ids).toEqual(['opus', 'codex', 'sonnet', 'opus-45', 'opus-47', 'gpt52']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
