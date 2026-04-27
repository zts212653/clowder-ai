import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankToConfidence } from '../dist/domains/memory/f163-types.js';

describe('rankToConfidence (Phase E)', () => {
  it('rank 0 (first result) is high', () => {
    assert.equal(rankToConfidence(0), 'high');
  });

  it('rank 1 (second result) is high', () => {
    assert.equal(rankToConfidence(1), 'high');
  });

  it('rank 2 is mid', () => {
    assert.equal(rankToConfidence(2), 'mid');
  });

  it('rank 4 is mid', () => {
    assert.equal(rankToConfidence(4), 'mid');
  });

  it('rank 5 is low', () => {
    assert.equal(rankToConfidence(5), 'low');
  });

  it('rank 9 is low', () => {
    assert.equal(rankToConfidence(9), 'low');
  });
});
