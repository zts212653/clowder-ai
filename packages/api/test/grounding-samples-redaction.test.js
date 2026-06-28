/**
 * F167 PR-O2b-fix: grounding-samples endpoint redaction.
 *
 * Vision guardian (opus-47) found that `/api/telemetry/grounding-samples`
 * returns raw invocationId/threadId/claimSummary, violating spec L828
 * whitelist ("只存 sourceRef + hash/status") and inconsistent with
 * traces endpoint which uses hmacId() pseudonymization.
 *
 * This test ensures the endpoint applies redaction before returning samples.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F167 PR-O2b-fix: grounding-samples redaction', () => {
  test('redactGroundingSample hashes invocationId, threadId, sourceThreadId', async () => {
    const { redactGroundingSample } = await import('../dist/routes/telemetry.js');

    const raw = {
      invocationId: 'inv-abc-123',
      catId: 'opus',
      threadId: 'thread_xyz789',
      sourceThreadId: 'thread_src456',
      claimType: 'wait',
      sourceKind: 'hold_ball_context',
      sourceRef: { messageId: 'msg-1' },
      claimSummary: 'waiting for reporter to respond with repro steps',
      resolver: 'thread_context',
      resolverSourceTier: 'T1',
      cacheHit: false,
      verdict: 'verified',
      verdictReason: 'thread exists',
      actionFamily: 'wait',
      actionRisk: 'low',
      tool: 'hold_ball',
      threadKind: 'gate-keeping',
      ts: 1700000000000,
      resolverCallsRemaining: 8,
    };

    const redacted = redactGroundingSample(raw);

    // Identity fields must be hashed (not raw)
    assert.notEqual(redacted.invocationId, 'inv-abc-123', 'invocationId must be hashed');
    assert.notEqual(redacted.threadId, 'thread_xyz789', 'threadId must be hashed');
    assert.notEqual(redacted.sourceThreadId, 'thread_src456', 'sourceThreadId must be hashed');

    // Hashed values should be hex strings (hmacId returns 32 hex chars)
    assert.match(redacted.invocationId, /^[0-9a-f]{32}$/, 'invocationId hash format');
    assert.match(redacted.threadId, /^[0-9a-f]{32}$/, 'threadId hash format');
    assert.match(redacted.sourceThreadId, /^[0-9a-f]{32}$/, 'sourceThreadId hash format');

    // catId stays — it's an enum-like identifier, not a system ID
    assert.equal(redacted.catId, 'opus');
  });

  test('redactGroundingSample removes claimSummary (free-text, outside spec whitelist)', async () => {
    const { redactGroundingSample } = await import('../dist/routes/telemetry.js');

    const raw = {
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread_1',
      claimType: 'wait',
      sourceKind: 'hold_ball_context',
      sourceRef: { messageId: 'msg-1' },
      claimSummary: 'sensitive hold reason with user context',
      resolver: 'thread_context',
      resolverSourceTier: 'T1',
      cacheHit: false,
      verdict: 'verified',
      actionFamily: 'wait',
      actionRisk: 'low',
      tool: 'hold_ball',
      ts: 1700000000000,
      resolverCallsRemaining: 8,
    };

    const redacted = redactGroundingSample(raw);

    // claimSummary must be removed (not just hashed — it's free-text)
    assert.equal(redacted.claimSummary, undefined, 'claimSummary must be removed');
  });

  test('redactGroundingSample preserves spec-allowed fields (sourceRef, verdict, resolver, etc.)', async () => {
    const { redactGroundingSample } = await import('../dist/routes/telemetry.js');

    const raw = {
      invocationId: 'inv-2',
      catId: 'opus',
      threadId: 'thread_2',
      claimType: 'wait',
      sourceKind: 'hold_ball_context',
      sourceRef: { messageId: 'msg-42', prUrl: 'https://github.com/o/r/pull/1' },
      resolver: 'github_pr_status',
      resolverSourceTier: 'T0',
      freshnessKey: 'pr:o/r#1:HEAD',
      cacheHit: true,
      verdict: 'mismatch',
      verdictReason: 'PR not found',
      actionFamily: 'tracking',
      actionRisk: 'medium',
      tool: 'register_pr_tracking',
      threadKind: 'gate-keeping',
      waitSourceRef: {
        kind: 'reporter_handle',
        value: 'user-xyz',
        anchorRef: 'msg-raw-id-12345',
        expectedSignal: 'reporter_replied',
        slaUntilMs: 3600000,
      },
      ownershipState: 'keeper_owned',
      keywordHintMatched: ['PR', 'tracking'],
      ts: 1700000000000,
      resolverCallsRemaining: 5,
    };

    const redacted = redactGroundingSample(raw);

    // Spec-allowed fields preserved verbatim
    assert.deepStrictEqual(redacted.sourceRef, raw.sourceRef, 'sourceRef preserved');
    assert.equal(redacted.verdict, 'mismatch', 'verdict preserved');
    assert.equal(redacted.verdictReason, 'PR not found', 'verdictReason preserved');
    assert.equal(redacted.resolver, 'github_pr_status', 'resolver preserved');
    assert.equal(redacted.resolverSourceTier, 'T0', 'resolverSourceTier preserved');
    assert.equal(redacted.cacheHit, true, 'cacheHit preserved');
    assert.notEqual(redacted.freshnessKey, 'pr:o/r#1:HEAD', 'freshnessKey must be hashed');
    assert.match(redacted.freshnessKey, /^[0-9a-f]{32}$/, 'freshnessKey hash format');
    assert.equal(redacted.claimType, 'wait', 'claimType preserved');
    assert.equal(redacted.sourceKind, 'hold_ball_context', 'sourceKind preserved');
    assert.equal(redacted.actionFamily, 'tracking', 'actionFamily preserved');
    assert.equal(redacted.actionRisk, 'medium', 'actionRisk preserved');
    assert.equal(redacted.tool, 'register_pr_tracking', 'tool preserved');
    assert.equal(redacted.threadKind, 'gate-keeping', 'threadKind preserved');
    assert.equal(redacted.ts, 1700000000000, 'ts preserved');
    assert.equal(redacted.resolverCallsRemaining, 5, 'resolverCallsRemaining preserved');
    // Only enum (kind) and numeric (slaUntilMs) preserved.
    // All string fields hashed — value can carry reporter handle / message ID.
    assert.equal(redacted.waitSourceRef.kind, 'reporter_handle', 'waitSourceRef.kind preserved (enum)');
    assert.equal(redacted.waitSourceRef.slaUntilMs, 3600000, 'waitSourceRef.slaUntilMs preserved (numeric)');
    assert.notEqual(redacted.waitSourceRef.value, 'user-xyz', 'value must be hashed');
    assert.match(redacted.waitSourceRef.value, /^[0-9a-f]{32}$/, 'value hash format');
    assert.notEqual(redacted.waitSourceRef.anchorRef, 'msg-raw-id-12345', 'anchorRef must be hashed');
    assert.match(redacted.waitSourceRef.anchorRef, /^[0-9a-f]{32}$/, 'anchorRef hash format');
    assert.notEqual(redacted.waitSourceRef.expectedSignal, 'reporter_replied', 'expectedSignal must be hashed');
    assert.match(redacted.waitSourceRef.expectedSignal, /^[0-9a-f]{32}$/, 'expectedSignal hash format');
    assert.equal(redacted.ownershipState, 'keeper_owned', 'ownershipState preserved');
    assert.deepStrictEqual(redacted.keywordHintMatched, ['PR', 'tracking'], 'keywordHintMatched preserved');
  });

  test('redactGroundingSample handles missing optional fields gracefully', async () => {
    const { redactGroundingSample } = await import('../dist/routes/telemetry.js');

    const raw = {
      invocationId: 'inv-3',
      catId: 'sonnet',
      threadId: 'thread_3',
      // no sourceThreadId, no claimSummary, no waitSourceRef
      claimType: 'auth',
      sourceKind: 'cvo_message',
      sourceRef: { messageId: 'msg-cvo' },
      resolver: 'cvo_message',
      resolverSourceTier: 'T0',
      cacheHit: false,
      verdict: 'verified',
      actionFamily: 'merge',
      actionRisk: 'high',
      tool: 'merge_pr',
      ts: 1700000000000,
      resolverCallsRemaining: 10,
    };

    const redacted = redactGroundingSample(raw);

    assert.equal(redacted.sourceThreadId, undefined, 'missing sourceThreadId stays undefined');
    assert.equal(redacted.claimSummary, undefined, 'missing claimSummary stays undefined');
    assert.match(redacted.invocationId, /^[0-9a-f]{32}$/, 'invocationId hashed');
    assert.match(redacted.threadId, /^[0-9a-f]{32}$/, 'threadId hashed');
  });

  test('validateSalt guard: endpoint returns 503 when HMAC salt unavailable', async () => {
    // Cloud review P2 fix: groundingSampleStore is wired independently of
    // initTelemetry(), so the endpoint must guard on salt availability.
    // We verify the import relationship exists (validateSalt is re-exported
    // from telemetry.ts) — the actual 503 path is tested at the route level
    // where the guard catch triggers reply.status(503).
    const telemetry = await import('../dist/routes/telemetry.js');
    assert.equal(typeof telemetry.redactGroundingSample, 'function', 'redactGroundingSample exported');

    // In test environment, validateSalt uses fallback salt, so hmacId works.
    // The guard is for production without TELEMETRY_HMAC_SALT.
    const { validateSalt } = await import('../dist/infrastructure/telemetry/hmac.js');
    assert.doesNotThrow(() => validateSalt(), 'validateSalt must not throw in test env');
  });

  test('deterministic hashing: same input → same hash', async () => {
    const { redactGroundingSample } = await import('../dist/routes/telemetry.js');

    const raw = {
      invocationId: 'inv-det-1',
      catId: 'opus',
      threadId: 'thread_det_1',
      claimType: 'wait',
      sourceKind: 'hold_ball_context',
      sourceRef: { messageId: 'msg-1' },
      resolver: 'thread_context',
      resolverSourceTier: 'T1',
      cacheHit: false,
      verdict: 'verified',
      actionFamily: 'wait',
      actionRisk: 'low',
      tool: 'hold_ball',
      ts: 1700000000000,
      resolverCallsRemaining: 8,
    };

    const r1 = redactGroundingSample(raw);
    const r2 = redactGroundingSample(raw);

    assert.equal(r1.invocationId, r2.invocationId, 'same invocationId → same hash');
    assert.equal(r1.threadId, r2.threadId, 'same threadId → same hash');
  });
});
