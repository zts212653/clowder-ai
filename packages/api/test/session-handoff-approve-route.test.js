/**
 * F225 ②b session-handoff approve/reject route tests.
 * 验证 user-auth dispatcher 把 approveSessionHandoff 的 commit-point 事务正确 wire 到真实 infra：
 * requestSeal 适配（对象签名 + cat_initiated_handoff）、enqueueContinuation（agent/continuation +
 * idempotencyKey=proposalId, ④ B5）、processNext kick（KD-6）、gate 失败不 seal、ownership。
 * commit-point 逻辑本身由 session-handoff-approve.test.js 纯函数测试覆盖；这里测 wire。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('session-handoff approve/reject route (F225 ②b)', () => {
  let InMemorySessionHandoffProposalStore;
  let sessionHandoffApproveRoutes;

  beforeEach(async () => {
    ({ InMemorySessionHandoffProposalStore } = await import(
      '../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
    ));
    ({ sessionHandoffApproveRoutes } = await import('../dist/routes/session-handoff-approve-routes.js'));
  });

  function buildDeps({ sealAccepted = true, sessionActive = true } = {}) {
    const store = new InMemorySessionHandoffProposalStore();
    const session = {
      id: 'sess_1',
      status: 'active',
      catId: 'opus',
      threadId: 'thread_1',
      userId: 'user_1',
    };
    const sessionChainStore = {
      get: async (id) => (id === session.id ? session : null),
      getActive: async (catId, threadId) =>
        sessionActive && catId === session.catId && threadId === session.threadId ? session : null,
      update: async (id, patch) => {
        if (id === session.id) Object.assign(session, patch);
        return session;
      },
    };
    const sealCalls = [];
    const finalizeCalls = [];
    const sessionSealer = {
      requestSeal: async ({ sessionId, reason }) => {
        sealCalls.push({ sessionId, reason });
        return { accepted: sealAccepted, status: sealAccepted ? 'sealing' : 'sealed' };
      },
      finalize: async ({ sessionId }) => {
        finalizeCalls.push({ sessionId });
      },
    };
    const enqueueCalls = [];
    const invocationQueue = {
      enqueue: (input) => {
        enqueueCalls.push(input);
        return { outcome: 'enqueued', entry: { id: `entry_${enqueueCalls.length}` } };
      },
    };
    const processNextCalls = [];
    const queueProcessor = {
      processNext: async (threadId, userId) => {
        processNextCalls.push({ threadId, userId });
        return { started: true };
      },
    };
    return {
      store,
      session,
      sessionChainStore,
      sessionSealer,
      invocationQueue,
      queueProcessor,
      sealCalls,
      finalizeCalls,
      enqueueCalls,
      processNextCalls,
    };
  }

  async function buildApp(deps, routeOpts = {}) {
    const app = Fastify();
    await app.register(sessionHandoffApproveRoutes, {
      handoffProposalStore: deps.store,
      sessionChainStore: deps.sessionChainStore,
      sessionSealer: deps.sessionSealer,
      invocationQueue: deps.invocationQueue,
      queueProcessor: deps.queueProcessor,
      socketManager: { emitToUser() {}, broadcastToRoom() {} },
      ...routeOpts,
    });
    return app;
  }

  const seedProposal = (deps) =>
    deps.store.create({
      sourceThreadId: 'thread_1',
      sourceSessionId: 'sess_1',
      sourceCatId: 'opus',
      userId: 'user_1',
      note: { done: 'wired ②a', nextSteps: 'wire ②b' },
    });

  const approve = (app, proposalId, userId = 'user_1') =>
    app.inject({
      method: 'POST',
      url: `/api/session-handoff/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': userId },
    });
  const reject = (app, proposalId, userId = 'user_1') =>
    app.inject({
      method: 'POST',
      url: `/api/session-handoff/${proposalId}/reject`,
      headers: { 'x-cat-cafe-user': userId },
    });

  it('approve happy path: seal(cat_initiated_handoff) + enqueue continuation + finalize + processNext', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 200);
    const json = res.json();
    assert.equal(json.status, 'approved');
    assert.equal(json.sealedSessionId, 'sess_1');
    assert.ok(json.continuationEntryId, 'continuationEntryId returned');

    assert.equal(deps.sealCalls.length, 1);
    assert.equal(deps.sealCalls[0].reason, 'cat_initiated_handoff', 'sealed with handoff reason');
    assert.equal(deps.enqueueCalls.length, 1);
    assert.equal(deps.enqueueCalls[0].source, 'agent');
    assert.equal(deps.enqueueCalls[0].sourceCategory, 'continuation', 'system-pinned continuation');
    assert.equal(deps.enqueueCalls[0].idempotencyKey, p.proposalId, 'idempotency keyed by proposalId (B5)');
    assert.deepEqual(deps.enqueueCalls[0].targetCats, ['opus'], 'same catId continuation');
    assert.equal(deps.processNextCalls.length, 1, 'processNext kicked (KD-6)');
    assert.ok(deps.session.catHandoffNote, 'note persisted to session before seal');
    assert.equal(deps.finalizeCalls.length, 1, 'session finalized — not left in sealing for the reaper (砚砚 P1-1)');
    assert.equal(deps.finalizeCalls[0].sessionId, 'sess_1', 'finalized the sealed session');
  });

  it('seal rejected → 409 seal_rejected, no continuation enqueued', async () => {
    const deps = buildDeps({ sealAccepted: false });
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'seal_rejected');
    assert.equal(deps.enqueueCalls.length, 0, 'no continuation when commit point not reached');
    assert.equal(deps.finalizeCalls.length, 0, 'no finalize when seal not accepted (still pre-commit)');
  });

  it('session no longer active → 409 session_changed (no seal)', async () => {
    const deps = buildDeps({ sessionActive: false });
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'session_changed');
    assert.equal(deps.sealCalls.length, 0, 'never sealed');
  });

  it('approve pre-commit fail (session_changed) emits proposal_updated so a mounted card learns expiry (gpt52 P2)', async () => {
    const deps = buildDeps({ sessionActive: false });
    const p = seedProposal(deps);
    const emits = [];
    const app = await buildApp(deps, {
      socketManager: {
        emitToUser: (userId, event, data) => emits.push({ userId, event, data }),
        broadcastToRoom() {},
      },
    });
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().reason, 'session_changed');
    // the proposal was markExpired'd pre-commit → a proposal_updated must fire so the mounted card
    // updates instead of sitting at `pending` until reload.
    const emit = emits.find((e) => e.event === 'proposal_updated');
    assert.ok(emit, 'proposal_updated emitted on pre-commit failure');
    assert.equal(emit.data.status, 'expired', 'emitted the now-expired proposal');
    assert.equal(res.json().status, 'expired', 'response also carries the settled status');
  });

  it('reject pending → rejected, never seals', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const res = await reject(app, p.proposalId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rejected');
    assert.equal(deps.sealCalls.length, 0);
  });

  it('approve by non-owner → 403', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const res = await approve(app, p.proposalId, 'someone_else');
    assert.equal(res.statusCode, 403);
    assert.equal(deps.sealCalls.length, 0);
  });

  it('approve already-approved → deduped, seal not run twice (idempotent)', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    await approve(app, p.proposalId);
    const res = await approve(app, p.proposalId);
    assert.equal(res.json().deduped, true);
    assert.equal(deps.sealCalls.length, 1, 'commit point crossed only once');
  });

  it('reject while approving → 409 (must not race a possibly-committed seal)', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    deps.store.claimForApproval(p.proposalId); // force 'approving'
    const app = await buildApp(deps);
    const res = await reject(app, p.proposalId);
    assert.equal(res.statusCode, 409);
  });

  it('approving in-flight (recent updatedAt) → 409 in-progress, live txn NOT killed (云端 P1)', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    deps.store.claimForApproval(p.proposalId); // → approving, updatedAt = now (a live in-flight approve)
    const app = await buildApp(deps, { approveStaleMs: 30000 });
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().status, 'approving');
    assert.equal(res.json().retryable, true);
    assert.equal(deps.store.get(p.proposalId).status, 'approving', 'live in-flight approve NOT expired');
    assert.equal(deps.sealCalls.length, 0, 'no recovery side effects triggered on a live txn');
  });

  it('approving stale (past threshold) → recover-forward, not blocked (crash recovery)', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    deps.store.claimForApproval(p.proposalId); // → approving
    // approveStaleMs=0 → any age treated as stale → recover; session still active + no seal → expire
    const app = await buildApp(deps, { approveStaleMs: 0 });
    const res = await approve(app, p.proposalId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().status, 'expired', 'stale approving recovered: pre-commit → expired');
  });

  it('GET /api/session-handoff/:id returns durable status + ownership 403 (云端 P2)', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    deps.store.markRejected(p.proposalId); // settled
    const app = await buildApp(deps);
    const ok = await app.inject({
      method: 'GET',
      url: `/api/session-handoff/${p.proposalId}`,
      headers: { 'x-cat-cafe-user': 'user_1' },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().proposal.status, 'rejected', 'durable status surfaced for card hydration');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/session-handoff/${p.proposalId}`,
      headers: { 'x-cat-cafe-user': 'someone_else' },
    });
    assert.equal(denied.statusCode, 403);
  });
});
