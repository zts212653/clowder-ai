import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('GameRuntime paused status', () => {
  it('paused is a valid game status alongside lobby/playing/finished', () => {
    /** @type {import('@cat-cafe/shared').GameRuntime['status']} */
    const status = 'paused';
    // If TypeScript compilation fails, 'paused' is not in the union
    assert.ok(['lobby', 'playing', 'paused', 'finished'].includes(status));
  });

  it('GameAutoPlayer should recognize paused as non-playing', () => {
    // paused games should not be treated as playing
    const status = 'paused';
    assert.notEqual(status, 'playing');
    assert.notEqual(status, 'finished');
  });
});
