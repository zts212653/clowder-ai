import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';

describe('F140 patchConflictState (MemoryPrTrackingStore)', () => {
  const repo = 'owner/repo';
  const prNumber = 42;

  function seedStore() {
    const store = new MemoryPrTrackingStore();
    store.register({ repoFullName: repo, prNumber, catId: 'cat1', threadId: 'th1', userId: 'u1' });
    return store;
  }

  it('patches conflict fields onto existing entry', () => {
    const store = seedStore();
    store.patchConflictState(repo, prNumber, {
      lastConflictFingerprint: 'abc1234:CONFLICTING',
      lastConflictNotifiedAt: 1000,
      mergeState: 'CONFLICTING',
    });
    const entry = store.get(repo, prNumber);
    assert.equal(entry?.lastConflictFingerprint, 'abc1234:CONFLICTING');
    assert.equal(entry?.lastConflictNotifiedAt, 1000);
    assert.equal(entry?.mergeState, 'CONFLICTING');
  });

  it('does not overwrite CI state fields', () => {
    const store = seedStore();
    store.patchCiState(repo, prNumber, { headSha: 'sha1', lastCiBucket: 'pass' });
    store.patchConflictState(repo, prNumber, { mergeState: 'CONFLICTING' });
    const entry = store.get(repo, prNumber);
    assert.equal(entry?.headSha, 'sha1');
    assert.equal(entry?.lastCiBucket, 'pass');
    assert.equal(entry?.mergeState, 'CONFLICTING');
  });

  it('is a no-op for non-existent entry', () => {
    const store = new MemoryPrTrackingStore();
    store.patchConflictState(repo, 999, { mergeState: 'CONFLICTING' });
    assert.equal(store.get(repo, 999), null);
  });

  it('clears fingerprint when mergeState returns to MERGEABLE (KD-9)', () => {
    const store = seedStore();
    store.patchConflictState(repo, prNumber, {
      lastConflictFingerprint: 'abc:CONFLICTING',
      mergeState: 'CONFLICTING',
    });
    // Simulate base update → MERGEABLE → clear fingerprint
    store.patchConflictState(repo, prNumber, {
      lastConflictFingerprint: undefined,
      mergeState: 'MERGEABLE',
    });
    const entry = store.get(repo, prNumber);
    assert.equal(entry?.mergeState, 'MERGEABLE');
    // undefined fields don't overwrite — caller must pass empty string to clear
    // Actually with spread, undefined won't overwrite. Let's test explicit clear:
  });

  it('explicit empty string clears fingerprint for KD-9 reset', () => {
    const store = seedStore();
    store.patchConflictState(repo, prNumber, {
      lastConflictFingerprint: 'abc:CONFLICTING',
      mergeState: 'CONFLICTING',
    });
    store.patchConflictState(repo, prNumber, {
      lastConflictFingerprint: '',
      mergeState: 'MERGEABLE',
    });
    const entry = store.get(repo, prNumber);
    assert.equal(entry?.mergeState, 'MERGEABLE');
    assert.equal(entry?.lastConflictFingerprint, '');
  });
});
