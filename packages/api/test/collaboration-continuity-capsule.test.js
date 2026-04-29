import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  buildCapsuleFromRouteState,
  completeCapsuleForCompact,
  completeCapsuleForSeal,
  formatContinuationPrompt,
  isCollaborationContinuityCapsuleV1,
} = await import('../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js');

describe('CollaborationContinuityCapsule', () => {
  it('builds route capsule from structured state without model prose', () => {
    const partial = buildCapsuleFromRouteState({
      threadId: 'thread-1',
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 3,
      directMessageFrom: 'opus',
      a2aTriggerMessageId: 'msg-opus',
      a2aEnabled: true,
      a2aDepth: 1,
      maxA2ADepth: 3,
    });

    assert.deepEqual(partial, {
      v: 1,
      threadId: 'thread-1',
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 3,
      directMessageFrom: 'opus',
      a2aTriggerMessageId: 'msg-opus',
      a2aEnabled: true,
      a2aDepth: 1,
      maxA2ADepth: 3,
      ballState: 'in_progress',
      continuationReason: 'threshold_seal',
    });
  });

  it('completes and validates a seal capsule', () => {
    const partial = buildCapsuleFromRouteState({
      threadId: 'thread-1',
      catId: 'codex',
      mode: 'independent',
      a2aEnabled: false,
    });

    const capsule = completeCapsuleForSeal(partial, {
      invocationId: 'inv-1',
      createdAt: 1234,
      seal: {
        sessionId: 'sess-1',
        sessionSeq: 2,
        reason: 'threshold',
        healthSnapshot: { fillRatio: 0.91 },
      },
    });

    assert.equal(isCollaborationContinuityCapsuleV1(capsule), true);
    assert.equal(capsule.invocationId, 'inv-1');
    assert.equal(capsule.seal.sessionId, 'sess-1');
  });

  it('completes compact capsule from route state without requiring a sealed digest', () => {
    const partial = buildCapsuleFromRouteState({
      threadId: 'thread-compact',
      catId: 'codex',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      directMessageFrom: 'opus',
      a2aTriggerMessageId: 'msg-a2a',
      a2aEnabled: true,
    });

    const capsule = completeCapsuleForCompact(partial, { createdAt: 5678 });

    assert.equal(isCollaborationContinuityCapsuleV1(capsule), true);
    assert.equal(capsule.continuationReason, 'compact_boundary');
    assert.equal(capsule.createdAt, 5678);
    assert.equal(capsule.directMessageFrom, 'opus');
    assert.equal(capsule.a2aTriggerMessageId, 'msg-a2a');
    assert.equal(capsule.seal, undefined);
  });

  it('rejects malformed compact capsules instead of injecting untrusted state', () => {
    assert.equal(
      completeCapsuleForCompact({
        v: 1,
        threadId: 'thread-compact',
        catId: 'codex',
        mode: 'serial',
        a2aEnabled: true,
        ballState: 'in_progress',
        continuationReason: 'compact_boundary',
        directMessageFrom: '',
      }),
      null,
    );
  });

  it('rejects already-completed sealed capsules as compact route state', () => {
    const sealed = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-compact',
        catId: 'codex',
        mode: 'independent',
        a2aEnabled: false,
      }),
      {
        invocationId: 'inv-old',
        createdAt: 1234,
        seal: { sessionId: 'sess-old', sessionSeq: 1, reason: 'threshold' },
      },
    );

    assert.equal(completeCapsuleForCompact(sealed), null);
  });

  it('formats continuation prompt as system control text, not assistant prose replay', () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-1',
        createdAt: 1234,
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const prompt = formatContinuationPrompt(capsule);

    assert.match(prompt, /previous session was sealed/i);
    assert.match(prompt, /thread-1/);
    assert.doesNotMatch(prompt, /Ready for gpt52 review/);
  });

  it('formats continuation prompt with required work-state recovery before acting', () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-1',
        createdAt: 1234,
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const prompt = formatContinuationPrompt(capsule);

    assert.match(prompt, /confirm the current working environment/i);
    assert.match(prompt, /unfinished work/i);
    assert.match(prompt, /session chain/i);
    assert.match(prompt, /evidence/i);
    assert.match(prompt, /continue the previous unfinished work/i);
    assert.match(prompt, /git status --short --branch/i);
    assert.match(prompt, /do not create a new worktree/i);
  });
});
