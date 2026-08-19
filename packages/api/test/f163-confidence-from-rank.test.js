import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankToMatchRank } from '../dist/domains/memory/f163-types.js';

describe('rankToMatchRank (F263)', () => {
  it('rank 0 (first result) is high', () => {
    assert.equal(rankToMatchRank(0), 'high');
  });

  it('rank 1 (second result) is high', () => {
    assert.equal(rankToMatchRank(1), 'high');
  });

  it('rank 2 is mid', () => {
    assert.equal(rankToMatchRank(2), 'mid');
  });

  it('rank 4 is mid', () => {
    assert.equal(rankToMatchRank(4), 'mid');
  });

  it('rank 5 is low', () => {
    assert.equal(rankToMatchRank(5), 'low');
  });

  it('rank 9 is low', () => {
    assert.equal(rankToMatchRank(9), 'low');
  });
});
