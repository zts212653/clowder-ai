import { describe, expect, it } from 'vitest';
import { getCatStatusType } from '../ThreadCatStatus';

/**
 * F118 D2: spawning status must be recognized as 'working' by aggregate functions.
 *
 * P1 from codex review: split-pane / sidebar showed 'idle' during spawning
 * because aggregateStatus only checked streaming|pending, not spawning.
 */
describe('getCatStatusType recognizes spawning as working', () => {
  it('returns working when a cat is spawning', () => {
    expect(getCatStatusType({ opus: 'spawning' })).toBe('working');
  });

  it('returns working when one cat spawning and another done', () => {
    expect(getCatStatusType({ opus: 'spawning', codex: 'done' })).toBe('working');
  });

  it('returns error when one cat errors even if another is spawning', () => {
    expect(getCatStatusType({ opus: 'spawning', codex: 'error' })).toBe('error');
  });

  it('returns working when mixing spawning with streaming', () => {
    expect(getCatStatusType({ opus: 'spawning', codex: 'streaming' })).toBe('working');
  });
});
