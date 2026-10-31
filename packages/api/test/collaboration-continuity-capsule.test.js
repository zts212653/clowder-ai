import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  buildCapsuleFromRouteState,
  buildDispatchHandledContinuationCapsule,
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

  it('validates and explains an automatic native runtime replacement without threshold or handoff language', () => {
    const capsule = {
      v: 1,
      threadId: 'thread-runtime-recovery',
      catId: 'codex-sol',
      invocationId: 'inv-runtime-recovery',
      mode: 'independent',
      a2aEnabled: true,
      ballState: 'in_progress',
      continuationReason: 'runtime_replacement',
      createdAt: 2_000,
      seal: { sessionId: 'session-old', sessionSeq: 2, reason: 'cli_session_replaced' },
      replacement: {
        cause: 'active_writer_reborn',
        previousNativeThreadId: 'native-old',
        detectedAt: 1_900,
        attempt: 1,
        diagnostics: {
          observedAt: 1_900,
          classification: 'native_active_turn_without_local_lease',
          confidence: 'medium',
          localHostLease: { state: 'not_observed', source: 'carrier_affinity' },
          nativeThread: {
            readOutcome: 'succeeded',
            threadId: 'native-old',
            status: 'active',
            activeTurn: { turnId: 'turn-old', startedAt: 1_800 },
          },
          writerClientIdentity: 'unavailable',
        },
      },
    };

    assert.equal(isCollaborationContinuityCapsuleV1(capsule), true);
    const prompt = formatContinuationPrompt(capsule);
    assert.match(prompt, /automatic native runtime recovery/i);
    assert.match(prompt, /native-old/);
    assert.match(prompt, /session was replaced/i);
    assert.doesNotMatch(prompt, /threshold|manual|handoff/i);
  });

  it('builds a dispatch-handled continuation without replaying the settled A2A carrier', () => {
    const capsule = buildDispatchHandledContinuationCapsule({
      threadId: 'thread-1',
      catId: 'codex',
      invocationId: 'inv-dispatch-handled',
      dispositionAt: 2_000,
    });

    assert.equal(isCollaborationContinuityCapsuleV1(capsule), true);
    assert.equal(capsule.continuationReason, 'dispatch_handled');
    assert.equal(capsule.a2aTriggerMessageId, undefined);
    assert.equal(capsule.directMessageFrom, undefined);
    assert.equal(capsule.createdAt, 2_000);

    const prompt = formatContinuationPrompt(capsule);
    assert.match(prompt, /A2A carrier was terminally handled/i);
    assert.match(prompt, /independently grounded.*unfinished work/i);
    assert.match(prompt, /do not.*dispose.*settled source carrier/i);
  });
});
