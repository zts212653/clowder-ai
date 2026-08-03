import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { canonicalizeActionIdentity, ActionSuccessorIdentityError } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);

describe('F167 Phase S action successor identity', () => {
  it('canonicalizes PR identity without putting thread or cat into the key', () => {
    const identity = canonicalizeActionIdentity({
      tenantScope: 'user-1',
      subjectRef: 'PR:Owner/Repo#2868',
      actionFamily: 'merge',
      successorSlot: 'reviewer',
    });

    assert.equal(identity.subjectRef, 'pr:owner/repo#2868');
    assert.equal(identity.key, 'user-1\u001fpr:owner/repo#2868\u001fmerge\u001freviewer');
    assert.equal(identity.key.includes('thread-'), false);
    assert.equal(identity.key.includes('codex'), false);
  });

  it('rejects an arbitrary slot instead of allowing key-space evasion', () => {
    assert.throws(
      () =>
        canonicalizeActionIdentity({
          tenantScope: 'user-1',
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer-2',
        }),
      (error) => error instanceof ActionSuccessorIdentityError && error.code === 'invalid_successor_slot',
    );
  });

  it('rejects an unknown action family rather than treating free text as identity', () => {
    assert.throws(
      () =>
        canonicalizeActionIdentity({
          tenantScope: 'user-1',
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'please-merge-this',
          successorSlot: 'reviewer',
        }),
      (error) => error instanceof ActionSuccessorIdentityError && error.code === 'invalid_action_family',
    );
  });
});
