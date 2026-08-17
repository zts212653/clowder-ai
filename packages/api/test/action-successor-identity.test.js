import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { canonicalizeActionIdentity, ActionSuccessorIdentityError } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { ACTION_SUBJECT_REF_DESCRIPTION, actionSuccessorMetadataSchema } = await import('@cat-cafe/shared');

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

  it('keeps schema and runtime diagnostics aligned for an invalid subjectRef', () => {
    const subjectRef = 'github:zts212653/cat-cafe#3677@181099d2';
    const parsed = actionSuccessorMetadataSchema.safeParse({
      subjectRef,
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    });

    assert.equal(parsed.success, false);
    assert.ok(parsed.error.issues.some((issue) => issue.message.includes(ACTION_SUBJECT_REF_DESCRIPTION)));
    assert.throws(
      () =>
        canonicalizeActionIdentity({
          tenantScope: 'user-1',
          subjectRef,
          actionFamily: 'review',
          successorSlot: 'reviewer',
        }),
      (error) =>
        error instanceof ActionSuccessorIdentityError &&
        error.code === 'invalid_subject_ref' &&
        error.message.includes(ACTION_SUBJECT_REF_DESCRIPTION),
    );
  });
});
