/**
 * F174 Phase F — L3 Authority residual cleanup (api-side).
 *
 * AC-F1: schedule.ts no longer reads `createdBy` / `triggerUserId` from body
 * AC-F3: telemetry counter for fallback-only legacy-creds hits in preHandler
 *
 * AC-F2 lives in mcp-server/test/phase-f-headers-only-auth.test.js — cloud
 * Codex P2 (PR #1388): API tests must not depend on mcp-server/dist
 * (clean-workspace `pnpm --filter @cat-cafe/api test` would module-not-found).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('F174 Phase F: L3 Authority cleanup (AC-F1)', () => {
  test('AC-F1: deriveScheduleActor ignores body.createdBy when no callbackAuth', async () => {
    const { deriveScheduleActorForTest } = await import('../dist/routes/schedule.js');
    const actor = deriveScheduleActorForTest({ headers: {}, callbackAuth: undefined }, { createdBy: 'spoofed-cat-id' });
    assert.notEqual(actor.createdBy, 'spoofed-cat-id', 'body.createdBy must be ignored');
    assert.equal(actor.createdBy, 'user', 'browser-initiated schedules use literal user');
  });

  test('AC-F1: deriveScheduleActor uses callbackAuth.catId when present (verified path)', async () => {
    const { deriveScheduleActorForTest } = await import('../dist/routes/schedule.js');
    const actor = deriveScheduleActorForTest(
      {
        headers: {},
        callbackAuth: {
          invocationId: 'inv-1',
          callbackToken: 'tok-1',
          catId: 'opus',
          userId: 'user-1',
          threadId: 'thread-1',
          clientMessageIds: new Set(),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      },
      { createdBy: 'spoofed-cat-id' },
    );
    assert.equal(actor.createdBy, 'opus', 'verified callbackAuth.catId wins');
    assert.equal(actor.triggerUserId, 'user-1');
  });
});

describe('F174 Phase F: legacy fallback telemetry (AC-F3)', () => {
  let resetCallbackAuthFallbackForTest;
  let getLegacyFallbackCount;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    resetCallbackAuthFallbackForTest = mod.resetLegacyFallbackHitsForTest;
    getLegacyFallbackCount = mod.getLegacyFallbackHitCount;
    if (typeof resetCallbackAuthFallbackForTest === 'function') resetCallbackAuthFallbackForTest();
  });

  test('AC-F3: recordLegacyFallbackHit increments counter', async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    assert.equal(typeof mod.recordLegacyFallbackHit, 'function', 'recorder must exist');
    assert.equal(typeof getLegacyFallbackCount, 'function', 'snapshot must exist');
    const before = getLegacyFallbackCount();
    mod.recordLegacyFallbackHit({ tool: 'post-message' });
    mod.recordLegacyFallbackHit({ tool: 'register-pr-tracking' });
    const after = getLegacyFallbackCount();
    assert.equal(after - before, 2);
  });

  test('AC-F3: snapshot exposes per-tool legacy fallback counts', async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    mod.recordLegacyFallbackHit({ tool: 'post-message' });
    mod.recordLegacyFallbackHit({ tool: 'post-message' });
    mod.recordLegacyFallbackHit({ tool: 'register-pr-tracking' });
    const snap = mod.getCallbackAuthFailureSnapshot();
    assert.ok(snap.legacyFallbackHits, 'snapshot must include legacyFallbackHits');
    assert.equal(snap.legacyFallbackHits.byTool['post-message'], 2);
    assert.equal(snap.legacyFallbackHits.byTool['register-pr-tracking'], 1);
    assert.equal(snap.legacyFallbackHits.total, 3);
  });
});
