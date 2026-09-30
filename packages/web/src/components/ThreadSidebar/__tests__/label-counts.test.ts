import { describe, expect, it } from 'vitest';
import { countThreadsByLabel } from '../label-counts';

describe('countThreadsByLabel', () => {
  it('counts each thread once for each label and distinguishes unlabeled threads', () => {
    const result = countThreadsByLabel([{ labels: ['a', 'b', 'a'] }, { labels: ['a'] }, { labels: [] }, {}]);
    expect(result.byLabel).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    );
    expect(result.uncategorized).toBe(2);
  });

  it('returns no counts for an empty thread list', () => {
    expect(countThreadsByLabel([])).toEqual({ byLabel: new Map(), uncategorized: 0 });
  });
});
