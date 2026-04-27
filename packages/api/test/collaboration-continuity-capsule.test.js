import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  buildCapsuleFromRouteState,
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
});
