// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { scoreKeywordRelevance, tokenizeKeyword } = await import('../dist/utils/keyword-relevance.js');

describe('F148 Phase B: keyword relevance scoring (AC-B2)', () => {
  it('returns 1.0 when all terms match', () => {
    const score = scoreKeywordRelevance('Redis CAS optimistic locking discussion', ['redis', 'cas']);
    assert.equal(score, 1.0);
  });

  it('returns 0.5 when half the terms match', () => {
    const score = scoreKeywordRelevance('Redis cluster configuration guide', ['redis', 'cas']);
    assert.equal(score, 0.5);
  });

  it('returns 0 when no terms match', () => {
    const score = scoreKeywordRelevance('Deploy pipeline CI/CD setup', ['redis', 'cas']);
    assert.equal(score, 0);
  });

  it('handles empty terms array', () => {
    const score = scoreKeywordRelevance('Some content', []);
    assert.equal(score, 0);
  });

  it('is case insensitive', () => {
    const score = scoreKeywordRelevance('REDIS is great', ['redis']);
    assert.equal(score, 1.0);
  });

  it('matches partial words (substring)', () => {
    const score = scoreKeywordRelevance('The deployment was successful', ['deploy']);
    assert.equal(score, 1.0);
  });
});

describe('F148 Phase B: tokenizeKeyword', () => {
  it('splits multi-word keyword into lowercase terms', () => {
    const terms = tokenizeKeyword('Redis CAS');
    assert.deepEqual(terms, ['redis', 'cas']);
  });

  it('returns empty for empty string', () => {
    const terms = tokenizeKeyword('');
    assert.deepEqual(terms, []);
  });

  it('trims whitespace', () => {
    const terms = tokenizeKeyword('  Redis   CAS  ');
    assert.deepEqual(terms, ['redis', 'cas']);
  });
});
