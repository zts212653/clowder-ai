import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { derivePrGroup } = await import('../dist/domains/community/derivePrGroup.js');

describe('derivePrGroup', () => {
  it('returns completed when closedAt is set', () => {
    assert.equal(derivePrGroup({ closedAt: Date.now() }), 'completed');
  });

  it('returns re-review-needed: new commit + CI pass', () => {
    assert.equal(
      derivePrGroup({
        ci: {
          headSha: 'abc123',
          lastFingerprint: 'old456:pass',
          lastBucket: 'pass',
        },
      }),
      're-review-needed',
    );
  });

  it('returns in-review: same commit fingerprint', () => {
    assert.equal(
      derivePrGroup({
        ci: {
          headSha: 'abc123',
          lastFingerprint: 'abc123:pass',
          lastBucket: 'pass',
        },
      }),
      'in-review',
    );
  });

  it('returns in-review: new commit but CI fail', () => {
    assert.equal(
      derivePrGroup({
        ci: {
          headSha: 'abc123',
          lastFingerprint: 'old456:fail',
          lastBucket: 'fail',
        },
      }),
      'in-review',
    );
  });

  it('returns in-review: new commit but CI pending', () => {
    assert.equal(
      derivePrGroup({
        ci: {
          headSha: 'abc123',
          lastFingerprint: 'old456:pending',
          lastBucket: 'pending',
        },
      }),
      'in-review',
    );
  });

  it('returns has-conflict when mergeState is CONFLICTING', () => {
    assert.equal(
      derivePrGroup({
        conflict: { mergeState: 'CONFLICTING' },
      }),
      'has-conflict',
    );
  });

  it('returns in-review for MERGEABLE state', () => {
    assert.equal(
      derivePrGroup({
        conflict: { mergeState: 'MERGEABLE' },
      }),
      'in-review',
    );
  });

  it('returns in-review for empty automation state', () => {
    assert.equal(derivePrGroup({}), 'in-review');
  });

  it('returns in-review for undefined automation state', () => {
    assert.equal(derivePrGroup(undefined), 'in-review');
  });

  it('returns completed when taskStatus is done (CiCdRouter close path)', () => {
    assert.equal(derivePrGroup({}, 'done'), 'completed');
  });

  it('taskStatus done takes priority over active automationState', () => {
    assert.equal(
      derivePrGroup(
        {
          ci: { headSha: 'new', lastFingerprint: 'old:pass', lastBucket: 'pass' },
          conflict: { mergeState: 'CONFLICTING' },
        },
        'done',
      ),
      'completed',
    );
  });

  it('completed takes priority over conflict', () => {
    assert.equal(
      derivePrGroup({
        closedAt: Date.now(),
        conflict: { mergeState: 'CONFLICTING' },
      }),
      'completed',
    );
  });

  it('re-review-needed takes priority over conflict', () => {
    assert.equal(
      derivePrGroup({
        ci: {
          headSha: 'new',
          lastFingerprint: 'old:pass',
          lastBucket: 'pass',
        },
        conflict: { mergeState: 'CONFLICTING' },
      }),
      're-review-needed',
    );
  });
});
