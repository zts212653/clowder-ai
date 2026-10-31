/**
 * Concierge Phase B Route tests (F229 Phase B)
 *
 * Covers:
 * - GET  /api/concierge/confirmations — mount-time confirmation state query
 * - POST /api/concierge/triage — create TriagePlan + dispatch
 * - POST /api/concierge/triage/:planId/confirm — confirm a proposed plan
 * - POST /api/concierge/triage/:planId/cancel — cancel a proposed plan
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const USER_HEADER = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
/** For requests without a body — omit content-type to avoid Fastify JSON parse error */
const USER_HEADER_NO_BODY = { 'x-cat-cafe-user': 'test-user' };

async function buildApp() {
  const { conciergeRoutes } = await import('../dist/routes/concierge.js');
  const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
  const { ConciergeThreadService } = await import('../dist/domains/concierge/ConciergeThreadService.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { MemoryConciergeRelayStore } = await import('../dist/domains/concierge/ConciergeRelayStore.js');
  const { MemoryConciergeConfirmationStore } = await import('../dist/domains/concierge/ConciergeConfirmationStore.js');
  const { MemoryConciergeTriagePlanStore } = await import('../dist/domains/concierge/ConciergeTriagePlanStore.js');
  const { MemoryConciergeInvestigationJobStore } = await import(
    '../dist/domains/concierge/ConciergeInvestigationJobStore.js'
  );
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

  const conciergeConfigStore = new MemoryConciergeConfigStore();
  const threadStore = new ThreadStore();
  const conciergeThreadService = new ConciergeThreadService({ threadStore, conciergeConfigStore });
  const conciergeRelayStore = new MemoryConciergeRelayStore();
  const conciergeConfirmationStore = new MemoryConciergeConfirmationStore();
  const conciergeTriagePlanStore = new MemoryConciergeTriagePlanStore();
  const conciergeInvestigationJobStore = new MemoryConciergeInvestigationJobStore();
  const messageStore = new MessageStore();

  const app = Fastify();

  // Stub POST /api/messages for relay dispatch
  app.post('/api/messages', async (_req, reply) => {
    reply.status(200);
    return { id: 'msg-stub-1', status: 'ok' };
  });

  await app.register(conciergeRoutes, {
    conciergeConfigStore,
    conciergeThreadService,
    conciergeRelayStore,
    conciergeConfirmationStore,
    conciergeTriagePlanStore,
    conciergeInvestigationJobStore,
    messageStore,
  });

  return {
    app,
    conciergeConfirmationStore,
    conciergeTriagePlanStore,
    conciergeInvestigationJobStore,
    conciergeRelayStore,
  };
}

// ---------------------------------------------------------------------------
// GET /api/concierge/confirmations — mount-time state query
// ---------------------------------------------------------------------------

describe('GET /api/concierge/confirmations', () => {
  it('returns empty array when no confirmations', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
      headers: USER_HEADER,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.confirmations, []);
  });

  it('returns user confirmations sorted by createdAt desc', async () => {
    const { app, conciergeConfirmationStore } = await buildApp();

    await conciergeConfirmationStore.create({
      id: 'c1',
      userId: 'test-user',
      messageId: 'msg-1',
      action: { kind: 'concierge_teleport', threadId: 'thread-1' },
      status: 'rendered',
      createdAt: 100,
      updatedAt: 100,
    });
    await conciergeConfirmationStore.create({
      id: 'c2',
      userId: 'test-user',
      messageId: 'msg-2',
      action: {
        kind: 'concierge_relay',
        targetThreadId: 'thread-2',
        targetCats: ['codex'],
        originalText: 'test',
        sourceMessageId: 'src-1',
      },
      status: 'confirmed',
      createdAt: 200,
      updatedAt: 200,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
      headers: USER_HEADER,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.confirmations.length, 2);
    assert.strictEqual(body.confirmations[0].id, 'c2'); // most recent first
  });

  it('401 without identity', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
    });
    assert.strictEqual(res.statusCode, 401);
  });

  it('does not return other user confirmations', async () => {
    const { app, conciergeConfirmationStore } = await buildApp();
    await conciergeConfirmationStore.create({
      id: 'c-other',
      userId: 'other-user',
      messageId: 'msg-x',
      action: { kind: 'concierge_teleport', threadId: 'thread-x' },
      status: 'rendered',
      createdAt: 100,
      updatedAt: 100,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
      headers: USER_HEADER,
    });
    const body = JSON.parse(res.body);
    assert.strictEqual(body.confirmations.length, 0);
  });

  it('P1: includes terminal TriagePlan states on the assistant confirmation message', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();
    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-completed',
      userId: 'test-user',
      sourceMessageId: 'msg-user-1',
      confirmationMessageId: 'msg-assistant-1',
      originalText: '帮我开个新调查',
      intent: 'propose_thread',
      target: { query: 'Redis 调查' },
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });
    await conciergeTriagePlanStore.updateStatus('plan-completed', 'completed');
    await conciergeTriagePlanStore.create({
      id: 'plan-cancelled',
      userId: 'test-user',
      sourceMessageId: 'msg-user-2',
      confirmationMessageId: 'msg-assistant-2',
      originalText: '取消传话',
      intent: 'relay',
      target: { threadId: 'thread-1', targetCats: ['codex'] },
      status: 'proposed',
      createdAt: now - 1,
      updatedAt: now - 1,
    });
    await conciergeTriagePlanStore.updateStatus('plan-cancelled', 'cancelled');

    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
      headers: USER_HEADER,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const completed = body.confirmations.find((entry) => entry.action?.planId === 'plan-completed');
    assert.ok(completed);
    assert.strictEqual(completed.messageId, 'msg-assistant-1');
    assert.strictEqual(completed.status, 'confirmed');
    assert.strictEqual(completed.action.kind, 'concierge_triage_confirm');

    const cancelled = body.confirmations.find((entry) => entry.action?.planId === 'plan-cancelled');
    assert.ok(cancelled);
    assert.strictEqual(cancelled.messageId, 'msg-assistant-2');
    assert.strictEqual(cancelled.status, 'cancelled');
    assert.strictEqual(cancelled.action.kind, 'concierge_triage_cancel');
  });

  it('P1: skips terminal TriagePlan states before the confirmation message id is linked', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();
    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-unlinked',
      userId: 'test-user',
      sourceMessageId: 'msg-user-only',
      originalText: '帮我开个新调查',
      intent: 'propose_thread',
      target: { query: 'Redis 调查' },
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });
    await conciergeTriagePlanStore.updateStatus('plan-unlinked', 'completed');

    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/confirmations',
      headers: USER_HEADER,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.ok(!body.confirmations.some((entry) => entry.action?.planId === 'plan-unlinked'));
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/triage — create TriagePlan
// ---------------------------------------------------------------------------

describe('POST /api/concierge/triage', () => {
  it('creates a triage plan with intent=relay', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '帮我问砚砚 bug 修了没',
        intent: 'relay',
        target: {
          threadId: 'thread-abc',
          threadTitle: '砚砚的 thread',
          targetCats: ['codex'],
        },
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.planId);
    assert.strictEqual(body.status, 'proposed');

    // Verify persisted
    const plan = await conciergeTriagePlanStore.get(body.planId);
    assert.ok(plan);
    assert.strictEqual(plan.intent, 'relay');
    assert.strictEqual(plan.status, 'proposed');
    assert.strictEqual(plan.originalText, '帮我问砚砚 bug 修了没');
  });

  it('creates a triage plan with intent=go', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-2',
        originalText: '带我去看看那个 thread',
        intent: 'go',
        target: { threadId: 'thread-xyz', threadTitle: 'Target thread' },
      },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).status, 'proposed');
  });

  it('creates a triage plan with intent=propose_thread', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-3',
        originalText: '帮我开个新 thread 调查这个问题',
        intent: 'propose_thread',
        target: { query: '调查 Redis 性能问题' },
      },
    });
    assert.strictEqual(res.statusCode, 200);
  });

  it('creates a triage plan with intent=investigate', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-4',
        originalText: '帮我查查 F229 的进度',
        intent: 'investigate',
        target: { query: 'F229 进度' },
      },
    });
    assert.strictEqual(res.statusCode, 200);
  });

  it('rejects invalid intent', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: 'test',
        intent: 'invalid_intent',
        target: {},
      },
    });
    assert.strictEqual(res.statusCode, 400);
  });

  it('401 without identity', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      payload: {
        sourceMessageId: 'msg-1',
        originalText: 'test',
        intent: 'relay',
        target: { threadId: 't-1' },
      },
    });
    assert.strictEqual(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/triage/:planId/confirm — confirm plan
// ---------------------------------------------------------------------------

describe('POST /api/concierge/triage/:planId/confirm', () => {
  it('completes go intent and returns target threadId for frontend navigation', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    // Use 'go' intent — no backend dispatch needed (frontend handles navigation)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '带我去看看',
        intent: 'go',
        target: { threadId: 'thread-1' },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    // Confirm it — 'go' completes server-side and returns the target for frontend navigation.
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(confirmRes.statusCode, 200);
    const body = JSON.parse(confirmRes.body);
    assert.strictEqual(body.status, 'completed');
    assert.strictEqual(body.threadId, 'thread-1');

    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'completed');
  });

  it('404 for unknown plan', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage/nonexistent/confirm',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('403 for other user plan', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();
    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-other',
      userId: 'other-user',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'relay',
      target: { threadId: 'thread-1' },
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage/plan-other/confirm',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 403);
  });

  it('auto-dispatches relay after confirmation', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    // Need a concierge thread for relay dispatch (no body → no content-type)
    const threadRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(threadRes.statusCode, 200);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '帮我问砚砚',
        intent: 'relay',
        target: { threadId: 'thread-abc', targetCats: ['codex'] },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    // Confirm → should auto-dispatch relay
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(confirmRes.statusCode, 200);
    assert.strictEqual(JSON.parse(confirmRes.body).status, 'completed');

    // Plan should be completed with relayReceiptId
    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'completed');
    assert.ok(plan.result?.relayReceiptId);
  });

  it('P1: uniquely-resolved relay confirm does not 422 when frontend echoes targetCats from action payload', async () => {
    // Bug: buildTriageConfirmActions puts targetCats in the else-branch payload
    // for uniquely-resolved targets. Frontend reads payload and sends it back.
    // Server's validateSelectedTargetCats checks candidateCats (empty) → 422.
    const { app, conciergeTriagePlanStore } = await buildApp();

    const threadRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(threadRes.statusCode, 200);

    // Create a relay plan with uniquely-resolved target (targetCats, NOT candidateCats)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '帮我传话给砚砚',
        intent: 'relay',
        target: { threadId: 'thread-abc', targetCats: ['codex'] },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    // Frontend echoes targetCats from the confirm action payload — this is the bug trigger.
    // Before the fix, this returns 422 "No candidate targetCats are available for this plan"
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER,
      payload: { targetCats: ['codex'] },
    });
    assert.strictEqual(confirmRes.statusCode, 200, `Expected 200 but got ${confirmRes.statusCode}: ${confirmRes.body}`);
    assert.strictEqual(JSON.parse(confirmRes.body).status, 'completed');

    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'completed');
  });

  it('P1: uniquely-resolved relay ignores client attempt to rewrite targetCats to a different cat', async () => {
    // Security regression: a malicious/buggy client could POST targetCats: ['opus']
    // to a plan that was uniquely resolved to ['codex']. Without the guard,
    // dispatchPlan would overwrite the target, misrouting the relay.
    const { app, conciergeTriagePlanStore } = await buildApp();

    const threadRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(threadRes.statusCode, 200);

    // Create a relay plan uniquely resolved to codex
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '帮我传话给砚砚',
        intent: 'relay',
        target: { threadId: 'thread-abc', targetCats: ['codex'] },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    // Attacker sends a different catId — server must ignore it
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER,
      payload: { targetCats: ['opus'] },
    });
    assert.strictEqual(confirmRes.statusCode, 200, `Expected 200 but got ${confirmRes.statusCode}: ${confirmRes.body}`);
    assert.strictEqual(JSON.parse(confirmRes.body).status, 'completed');

    // Critical: the plan must still use the original target, not the attacker's
    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'completed');
    assert.deepStrictEqual(
      plan.target.targetCats,
      ['codex'],
      'Server must use stored targetCats, not client-submitted ones',
    );
  });

  it('P1: dispatches ambiguous relay after user-selected targetCats are supplied', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    const threadRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(threadRes.statusCode, 200);

    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-select-cat',
      userId: 'test-user',
      sourceMessageId: 'msg-1',
      originalText: '帮我问问',
      intent: 'relay',
      target: { threadId: 'thread-abc', threadTitle: '多人 thread', candidateCats: ['codex', 'opus'] },
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });

    const confirmRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage/plan-select-cat/confirm',
      headers: USER_HEADER,
      payload: { targetCats: ['codex'] },
    });
    assert.strictEqual(confirmRes.statusCode, 200);
    assert.strictEqual(JSON.parse(confirmRes.body).status, 'completed');

    const plan = await conciergeTriagePlanStore.get('plan-select-cat');
    assert.strictEqual(plan.status, 'completed');
    assert.deepStrictEqual(plan.target.targetCats, ['codex']);
    assert.ok(plan.result?.relayReceiptId);
  });

  it('422s invalid relay plans instead of silently confirming without dispatch', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();
    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-missing-cats',
      userId: 'test-user',
      sourceMessageId: 'msg-1',
      originalText: '帮我问砚砚',
      intent: 'relay',
      target: { threadId: 'thread-1' },
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage/plan-missing-cats/confirm',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 422);
    const body = JSON.parse(res.body);
    assert.match(body.error, /Invalid relay target/);

    const plan = await conciergeTriagePlanStore.get('plan-missing-cats');
    assert.strictEqual(plan.status, 'failed');
  });

  it('auto-dispatches propose_thread after confirmation', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '开个新 thread 讨论 bug',
        intent: 'propose_thread',
        target: { query: 'Bug 调查' },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(confirmRes.statusCode, 200);
    assert.strictEqual(JSON.parse(confirmRes.body).status, 'completed');

    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'completed');
    assert.ok(plan.result?.proposedThreadId);
  });

  it('409 for non-proposed plan', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();
    const now = Date.now();
    await conciergeTriagePlanStore.create({
      id: 'plan-confirmed',
      userId: 'test-user',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'relay',
      target: { threadId: 'thread-1' },
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage/plan-confirmed/confirm',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 409);
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/triage/:planId/cancel — cancel plan
// ---------------------------------------------------------------------------

describe('POST /api/concierge/triage/:planId/cancel', () => {
  it('transitions proposed → cancelled', async () => {
    const { app, conciergeTriagePlanStore } = await buildApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '传话给砚砚',
        intent: 'relay',
        target: { threadId: 'thread-1', targetCats: ['codex'] },
      },
    });
    const { planId } = JSON.parse(createRes.body);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/cancel`,
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(cancelRes.statusCode, 200);
    assert.strictEqual(JSON.parse(cancelRes.body).status, 'cancelled');

    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'cancelled');
  });
});

// ---------------------------------------------------------------------------
// Investigation dispatch (Phase B2)
// ---------------------------------------------------------------------------

describe('POST /api/concierge/triage/:planId/confirm — investigate intent', () => {
  it('creates InvestigationJob on investigate confirm', async () => {
    const { app, conciergeTriagePlanStore, conciergeInvestigationJobStore } = await buildApp();

    // Create concierge thread first
    const threadRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(threadRes.statusCode, 200);

    // Create investigate triage plan
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: '帮我查一下砚砚那个 Redis bug',
        intent: 'investigate',
        target: { query: '砚砚 Redis bug 修复状态' },
      },
    });
    assert.strictEqual(createRes.statusCode, 200, `Create failed: ${createRes.body}`);
    const { planId } = JSON.parse(createRes.body);

    // Confirm the investigation
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER,
      payload: {},
    });
    assert.strictEqual(confirmRes.statusCode, 200, `Confirm failed: ${confirmRes.body}`);
    const confirmBody = JSON.parse(confirmRes.body);
    assert.strictEqual(confirmBody.status, 'dispatched');
    assert.ok(confirmBody.investigationJobId, 'Should return investigationJobId');

    // Verify TriagePlan status — fire-and-forget worker may have already propagated
    // 'completed' by the time we read (Memory store has no real async delay).
    const plan = await conciergeTriagePlanStore.get(planId);
    assert.ok(
      ['dispatched', 'completed'].includes(plan.status),
      `Expected dispatched or completed but got ${plan.status}`,
    );
    assert.strictEqual(plan.result.investigationJobId, confirmBody.investigationJobId);

    // Verify InvestigationJob was created and processing started.
    // Worker runs fire-and-forget, so by the time we read the job it may already
    // be running or done (Memory store has no real async delay).
    const job = await conciergeInvestigationJobStore.get(confirmBody.investigationJobId);
    assert.ok(job, 'InvestigationJob should exist');
    assert.ok(['queued', 'running', 'done'].includes(job.status), `Expected queued/running/done but got ${job.status}`);
    assert.strictEqual(job.triagePlanId, planId);
    assert.strictEqual(job.query, '砚砚 Redis bug 修复状态');
    assert.ok(job.deadline > job.createdAt, 'deadline should be after createdAt');
  });

  // Cloud P2: dispatch failure must not leave plan stuck in 'confirmed'
  it('investigation dispatch failure marks plan as failed (not stuck confirmed)', async () => {
    const { app, conciergeTriagePlanStore, conciergeInvestigationJobStore } = await buildApp();

    // Create concierge thread first
    await app.inject({
      method: 'POST',
      url: '/api/concierge/thread',
      headers: USER_HEADER_NO_BODY,
    });

    // Create investigate triage plan
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/concierge/triage',
      headers: USER_HEADER,
      payload: {
        sourceMessageId: 'msg-1',
        originalText: 'test dispatch failure',
        intent: 'investigate',
        target: { query: 'test dispatch failure' },
      },
    });
    assert.strictEqual(createRes.statusCode, 200, `Create failed: ${createRes.body}`);
    const { planId } = JSON.parse(createRes.body);

    // Make job creation throw (simulates Redis failure during dispatch)
    const origCreate = conciergeInvestigationJobStore.create.bind(conciergeInvestigationJobStore);
    conciergeInvestigationJobStore.create = async () => {
      throw new Error('Redis connection refused');
    };

    // Confirm — dispatch will fail
    const confirmRes = await app.inject({
      method: 'POST',
      url: `/api/concierge/triage/${planId}/confirm`,
      headers: USER_HEADER,
      payload: {},
    });

    // Restore original
    conciergeInvestigationJobStore.create = origCreate;

    // Should return 502 (handled), not 500 (unhandled crash)
    assert.strictEqual(confirmRes.statusCode, 502, 'Dispatch failure should return 502');

    // Plan should be 'failed', not stuck in 'confirmed'
    const plan = await conciergeTriagePlanStore.get(planId);
    assert.strictEqual(plan.status, 'failed', 'Plan should be failed when dispatch throws, not stuck confirmed');
  });
});

// ---------------------------------------------------------------------------
// GET /api/concierge/investigation/:jobId — Investigation status
// ---------------------------------------------------------------------------

describe('GET /api/concierge/investigation/:jobId', () => {
  it('returns investigation job status', async () => {
    const { app, conciergeInvestigationJobStore } = await buildApp();

    // Manually create a job for direct testing
    const now = Date.now();
    const job = {
      id: 'test-job-1',
      userId: 'test-user',
      triagePlanId: 'plan-1',
      query: 'test query',
      scope: ['memory'],
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      deadline: now + 60_000,
    };
    await conciergeInvestigationJobStore.create(job);

    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/investigation/test-job-1',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.job.id, 'test-job-1');
    assert.strictEqual(body.job.status, 'running');
  });

  it('returns 404 for unknown job', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/investigation/nonexistent',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('returns 403 for job owned by another user', async () => {
    const { app, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();
    await conciergeInvestigationJobStore.create({
      id: 'other-job',
      userId: 'other-user',
      triagePlanId: 'plan-x',
      query: 'test',
      scope: ['memory'],
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      deadline: now + 60_000,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/investigation/other-job',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 403);
  });

  it('auto-cancels expired running job on status check (INV I3)', async () => {
    const { app, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();
    await conciergeInvestigationJobStore.create({
      id: 'expired-job',
      userId: 'test-user',
      triagePlanId: 'plan-exp',
      query: 'test',
      scope: ['memory'],
      status: 'running',
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
      startedAt: now - 120_000,
      deadline: now - 60_000, // Already past deadline
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/investigation/expired-job',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.job.status, 'cancelled', 'Expired job should be auto-cancelled');
    assert.ok(body.job.completedAt, 'Should have completedAt set');
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/investigation/:jobId/cancel — Cancel investigation
// ---------------------------------------------------------------------------

describe('POST /api/concierge/investigation/:jobId/cancel', () => {
  it('cancels a queued investigation', async () => {
    const { app, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();
    await conciergeInvestigationJobStore.create({
      id: 'cancel-job',
      userId: 'test-user',
      triagePlanId: 'plan-c',
      query: 'test',
      scope: ['memory'],
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      deadline: now + 60_000,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/investigation/cancel-job/cancel',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).status, 'cancelled');

    const job = await conciergeInvestigationJobStore.get('cancel-job');
    assert.strictEqual(job.status, 'cancelled');
  });

  it('cancelling investigation propagates cancelled to parent TriagePlan', async () => {
    const { app, conciergeTriagePlanStore, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();

    // Seed a dispatched triage plan
    await conciergeTriagePlanStore.create({
      id: 'plan-cancel',
      userId: 'test-user',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'investigate',
      target: { query: 'test query' },
      status: 'dispatched',
      createdAt: now,
      updatedAt: now,
      result: { investigationJobId: 'cancel-job-p' },
    });
    await conciergeInvestigationJobStore.create({
      id: 'cancel-job-p',
      userId: 'test-user',
      triagePlanId: 'plan-cancel',
      query: 'test',
      scope: ['memory'],
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      deadline: now + 60_000,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/investigation/cancel-job-p/cancel',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 200);

    const plan = await conciergeTriagePlanStore.get('plan-cancel');
    assert.strictEqual(plan.status, 'cancelled', 'Parent plan should be cancelled when job is cancelled');
  });

  it('auto-cancel on expired job propagates cancelled to parent TriagePlan', async () => {
    const { app, conciergeTriagePlanStore, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();

    await conciergeTriagePlanStore.create({
      id: 'plan-expire',
      userId: 'test-user',
      sourceMessageId: 'msg-1',
      originalText: 'test',
      intent: 'investigate',
      target: { query: 'test query' },
      status: 'dispatched',
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
    });
    await conciergeInvestigationJobStore.create({
      id: 'expired-job-p',
      userId: 'test-user',
      triagePlanId: 'plan-expire',
      query: 'test',
      scope: ['memory'],
      status: 'running',
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
      startedAt: now - 120_000,
      deadline: now - 60_000,
    });

    await app.inject({
      method: 'GET',
      url: '/api/concierge/investigation/expired-job-p',
      headers: USER_HEADER_NO_BODY,
    });

    const plan = await conciergeTriagePlanStore.get('plan-expire');
    assert.strictEqual(plan.status, 'cancelled', 'Parent plan should be cancelled on auto-expire');
  });

  it('rejects cancelling already-done investigation', async () => {
    const { app, conciergeInvestigationJobStore } = await buildApp();
    const now = Date.now();
    await conciergeInvestigationJobStore.create({
      id: 'done-job',
      userId: 'test-user',
      triagePlanId: 'plan-d',
      query: 'test',
      scope: ['memory'],
      status: 'done',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      deadline: now + 60_000,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/investigation/done-job/cancel',
      headers: USER_HEADER_NO_BODY,
    });
    assert.strictEqual(res.statusCode, 409);
  });
});
