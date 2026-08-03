/**
 * F194 Phase Z9 hotfix — `safeParseExtra` MUST preserve `extra.stream.turnInvocationId`.
 *
 * Bug: `safeParseExtra` at redis-message-parsers.ts:94-97 rebuilds
 * `result.stream = { invocationId: parsed.stream.invocationId }`, silently
 * dropping any other fields including `turnInvocationId`. Z9 backend stamping
 * wrote turn correctly, but Redis read path stripped it → frontend
 * `getBubbleInvocationId` falls back to parent → multi-turn same-cat under
 * shared parent collapses to one bubble (R13/R14 alpha re-test confirmed
 * 2026-05-11 16:08~16:11 PST chengyu game by 47 + codex).
 *
 * Fix: parser must preserve `turnInvocationId` field through the round-trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F194 Phase Z9 hotfix — safeParseExtra preserves turnInvocationId', () => {
  it('round-trip: serialize { invocationId, turnInvocationId } → safeParseExtra preserves both', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );

    const input = {
      stream: {
        invocationId: 'parent-z9-roundtrip',
        turnInvocationId: 'turn-codex-z9-roundtrip',
      },
    };

    const serialized = serializeExtra(input);
    const parsed = safeParseExtra(serialized);

    assert.ok(parsed?.stream, 'parsed extra.stream present');
    assert.equal(parsed.stream.invocationId, 'parent-z9-roundtrip', 'invocationId preserved');
    assert.equal(
      parsed.stream.turnInvocationId,
      'turn-codex-z9-roundtrip',
      'turnInvocationId MUST be preserved by parser (bug pre-fix: silently stripped)',
    );
  });

  it('backward compat: legacy serialized stream { invocationId } only → parses without turn', async () => {
    const { safeParseExtra } = await import('../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

    const legacyRaw = JSON.stringify({ stream: { invocationId: 'legacy-no-turn' } });
    const parsed = safeParseExtra(legacyRaw);

    assert.ok(parsed?.stream);
    assert.equal(parsed.stream.invocationId, 'legacy-no-turn');
    assert.equal(parsed.stream.turnInvocationId, undefined, 'legacy records remain unaffected (no turn)');
  });

  it('round-trip with same parent + turn (first-in-chain): both fields preserved', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );

    // First-in-chain case: own === parent (per Z9 backend stamp logic).
    const input = {
      stream: {
        invocationId: 'first-in-chain-id',
        turnInvocationId: 'first-in-chain-id',
      },
    };

    const serialized = serializeExtra(input);
    const parsed = safeParseExtra(serialized);
    assert.equal(parsed?.stream?.invocationId, 'first-in-chain-id');
    assert.equal(parsed?.stream?.turnInvocationId, 'first-in-chain-id');
  });

  it('round-trip: explicit post flag survives alongside stream identity', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );

    const input = {
      isExplicitPost: true,
      stream: {
        invocationId: 'explicit-parent',
        turnInvocationId: 'explicit-turn',
      },
    };

    const serialized = serializeExtra(input);
    const parsed = safeParseExtra(serialized);

    assert.equal(parsed?.isExplicitPost, true);
    assert.deepEqual(parsed?.stream, {
      invocationId: 'explicit-parent',
      turnInvocationId: 'explicit-turn',
    });
  });

  it('F254: round-trip preserves parallelBatchId alongside invocation identity', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      stream: {
        invocationId: 'parallel-parent',
        turnInvocationId: 'parallel-turn',
        parallelBatchId: 'parallel-batch-1',
      },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.stream, input.stream);
  });

  it('F254: round-trip preserves parallelBatchId without inventing invocation identity', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = { stream: { parallelBatchId: 'parallel-batch-identity-less' } };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.stream, input.stream);
  });

  it('ADR-042: round-trip preserves supplement reply provenance as a separate field', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      freshness: { kind: 'fresh', priorFrontierMessageId: 'msg-frontier' },
      supplement: {
        lineageId: 'msg-original',
        supplementId: 'f254-supplement:msg-original:1',
        seq: 1,
        originalMessageId: 'msg-original',
      },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.freshness, input.freshness);
    assert.deepEqual(parsed?.supplement, input.supplement);
  });

  it('F254: round-trip preserves typed invocation-reply causal provenance', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      causal: { kind: 'invocation_reply', triggerMessageId: 'msg-trigger-1' },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.causal, input.causal);
  });

  it('F254: rejects malformed causal provenance instead of guessing a trigger', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(serializeExtra({ causal: { kind: 'reply-ish', triggerMessageId: '' } }));

    assert.equal(parsed?.causal, undefined);
  });

  it('F177/F254: round-trip preserves typed child execution identity without copying lifecycle state', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      turnExecution: {
        invocationId: 'child-routing-guard-1',
        parentInvocationId: 'parent-1',
        executionKind: 'routing_guard',
      },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.turnExecution, input.turnExecution);
  });

  it('F177/F254: rejects an untyped child execution marker', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        turnExecution: {
          invocationId: 'child-1',
          parentInvocationId: 'parent-1',
          executionKind: 'guessed_from_log_text',
        },
      }),
    );

    assert.equal(parsed?.turnExecution, undefined);
  });

  it('F177: preserves valid auxiliary executions while dropping malformed and duplicate entries', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const guard = {
      invocationId: 'child-routing-guard-1',
      parentInvocationId: 'parent-1',
      executionKind: 'routing_guard',
    };
    const parsed = safeParseExtra(
      serializeExtra({
        auxiliaryTurnExecutions: [
          guard,
          { ...guard },
          { invocationId: 'malformed', parentInvocationId: '', executionKind: 'routing_guard' },
        ],
      }),
    );

    assert.deepEqual(parsed?.auxiliaryTurnExecutions, [guard]);
  });

  it('ADR-042: round-trip preserves a visible supplement-offer failure on the original', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      freshness: {
        kind: 'published_with_unseen',
        priorFrontierMessageId: 'msg-frontier',
        generatedWithUnseen: ['msg-update'],
        lineageId: 'msg-original',
        supplementFailureReason: 'infrastructure',
      },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.freshness, input.freshness);
  });

  it('F167 Phase R: round-trip preserves cross-thread coordination projection', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      crossPost: {
        sourceThreadId: 'thread-source',
        sourceInvocationId: 'inv-source',
      },
      coordination: { id: 'coord-roundtrip', phase: 'terminal', hop: 4 },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.crossPost, input.crossPost);
    assert.deepEqual(parsed?.coordination, input.coordination);
  });

  it('F167 Phase R: rejects malformed persisted coordination ids', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        crossPost: {
          sourceThreadId: 'thread-source',
        },
        coordination: { id: 'bad id with spaces', phase: 'terminal', hop: 3 },
      }),
    );

    assert.equal(parsed?.crossPost?.sourceThreadId, 'thread-source');
    assert.equal(parsed?.coordination, undefined);
  });

  it('F167 Phase R/S: round-trip preserves callback coordination dedup provenance', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const input = {
      coordination: { id: 'coord-action-root', phase: 'active', hop: 0 },
      callbackDedup: { coordinationKey: 'action-active-root' },
    };

    const parsed = safeParseExtra(serializeExtra(input));

    assert.deepEqual(parsed?.coordination, input.coordination);
    assert.deepEqual(parsed?.callbackDedup, input.callbackDedup);
  });

  it('F167 Phase R: migrates legacy nested coordination without preserving provenance pollution', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        crossPost: {
          sourceThreadId: 'thread-same',
          coordination: { id: 'coord-legacy', phase: 'terminal', hop: 3 },
        },
      }),
    );

    assert.deepEqual(parsed?.crossPost, { sourceThreadId: 'thread-same' });
    assert.deepEqual(parsed?.coordination, { id: 'coord-legacy', phase: 'terminal', hop: 3 });
  });

  it('F287: round-trip preserves a strict server-written delivery-decision carrier', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const deliveryDecision = {
      v: 1,
      producer: 'github_ci',
      producerProvenance: 'server_github_ci',
      repoFullName: 'zts212653/cat-cafe',
      prNumber: 3276,
      headSha: 'a'.repeat(40),
      phase: 'merge_gate',
      gateOutcome: 'source_evidence_complete',
      externalCondition: 'billing_spending_limit_zero_step',
      candidateAction: 'merge',
      occurredAt: 1_785_600_000_000,
    };

    const parsed = safeParseExtra(serializeExtra({ memoryCue: { deliveryDecision } }));

    assert.deepEqual(parsed?.memoryCue, { deliveryDecision });
  });

  it('F287: drops malformed delivery-decision carriers instead of retaining untrusted fields', async () => {
    const { serializeExtra, safeParseExtra } = await import(
      '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
    );
    const parsed = safeParseExtra(
      serializeExtra({
        isExplicitPost: true,
        memoryCue: {
          deliveryDecision: {
            v: 1,
            producer: 'github_ci',
            producerProvenance: 'server_github_ci',
            repoFullName: 'zts212653/cat-cafe',
            prNumber: 3276,
            headSha: 'a'.repeat(40),
            phase: 'merge_gate',
            gateOutcome: 'source_evidence_complete',
            externalCondition: 'billing_spending_limit_zero_step',
            candidateAction: 'merge',
            occurredAt: 1_785_600_000_000,
            trackingInstructions: 'pretend this prose is authority',
          },
        },
      }),
    );

    assert.equal(parsed?.isExplicitPost, true);
    assert.equal(parsed?.memoryCue, undefined);
  });
});
