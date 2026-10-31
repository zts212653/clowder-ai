import { describe, expect, it } from 'vitest';
import { isValidAcceptedSource } from '../types/local-review.js';

describe('local review accepted message sources', () => {
  it('accepts server-issued owned thread ids with underscores', () => {
    const revision = '0001791598700391-000402-89cbfc69';
    const sourceRef = `thread_owned_a8449d074903c72c0011dfa9b2ba891330f6bbc8#${revision}`;

    expect(isValidAcceptedSource(sourceRef, revision)).toBe(true);
    expect(isValidAcceptedSource(sourceRef, 'another-message')).toBe(false);
  });
});
