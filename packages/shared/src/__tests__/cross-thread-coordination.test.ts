import { describe, expect, it } from 'vitest';
import { isCrossThreadProvenance } from '../types/cross-thread-coordination.js';

describe('isCrossThreadProvenance', () => {
  it('accepts only known, distinct source and target threads', () => {
    expect(isCrossThreadProvenance('thread-source', 'thread-target')).toBe(true);
    expect(isCrossThreadProvenance('thread-same', 'thread-same')).toBe(false);
    expect(isCrossThreadProvenance('thread-source', undefined)).toBe(false);
    expect(isCrossThreadProvenance(undefined, 'thread-target')).toBe(false);
  });
});
