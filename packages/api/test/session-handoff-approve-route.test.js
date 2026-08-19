/**
 * F225 ②b session-handoff approve/reject route tests.
 * 验证 user-auth dispatcher 把 approveSessionHandoff 的 commit-point 事务正确 wire 到真实 infra：
 * requestSeal 适配（对象签名 + cat_initiated_handoff）、enqueueContinuation（agent/continuation +
 * idempotencyKey=proposalId, ④ B5）、processNext kick（KD-6）、gate 失败不 seal、ownership。
 * commit-point 逻辑本身由 session-handoff-approve.test.js 纯函数测试覆盖；这里测 wire。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  approveSessionHandoff as approve,
  buildSessionHandoffApp as buildApp,
  buildSessionHandoffDeps as buildDeps,
  rejectSessionHandoff as reject,
  seedSessionHandoffProposal as seedProposal,
} from './helpers/session-handoff-route-fixture.js';

describe('session-handoff approve/reject route (F225 ②b)', () => {
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
    assert.equal(deps.enqueueCalls[0].ownerAuthProvenance, 'strict');
    assert.equal(deps.enqueueCalls[0].sourceCategory, 'continuation', 'system-pinned continuation');
    assert.equal(deps.enqueueCalls[0].idempotencyKey, p.proposalId, 'idempotency keyed by proposalId (B5)');
    assert.deepEqual(deps.enqueueCalls[0].targetCats, ['opus'], 'same catId continuation');
    assert.equal(deps.processNextCalls.length, 1, 'processNext kicked (KD-6)');
    assert.ok(deps.session.catHandoffNote, 'note persisted to session before seal');
    assert.equal(deps.finalizeCalls.length, 1, 'session finalized — not left in sealing for the reaper (砚砚 P1-1)');
    assert.equal(deps.finalizeCalls[0].sessionId, 'sess_1', 'finalized the sealed session');
  });

  it('trusted-browser compatibility approval preserves compatibility_fallback on the continuation', async () => {
    const deps = buildDeps();
    deps.session.userId = 'default-user';
    const p = seedProposal(deps, { userId: 'default-user' });
    const app = await buildApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/api/session-handoff/${p.proposalId}/approve`,
      headers: { origin: 'http://localhost:3003' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deps.enqueueCalls[0].ownerAuthProvenance, 'compatibility_fallback');
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
    const signals = [];
    const app = await buildApp(deps, { onProposalReject: (signal) => signals.push(signal) });
    const res = await reject(app, p.proposalId);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'rejected');
    assert.equal(deps.store.get(p.proposalId).humanDispositionLedgerEntry.episode.decision, 'rejected');
    assert.equal(deps.store.get(p.proposalId).humanDispositionLedgerEntry.envelope, undefined);
    assert.equal(signals.length, 1, 'F192 signal remains downstream of the durable F281 transition');
    assert.equal(deps.sealCalls.length, 0);
  });

  it('strictly captures every F225 reason and rejects client-supplied identity', async () => {
    const reasons = ['not_important', 'wrong_lane', 'bad_evidence', 'not_now', 'wrong'];
    for (const reasonCode of reasons) {
      const deps = buildDeps();
      const p = seedProposal(deps);
      const app = await buildApp(deps);
      const res = await reject(app, p.proposalId, 'user_1', { feedback: { reasonCode } });
      assert.equal(res.statusCode, 200, reasonCode);
      assert.deepEqual(deps.store.get(p.proposalId).latestHumanDisposition, { reasonCode });
    }

    const deps = buildDeps();
    const other = seedProposal(deps);
    const spoofed = seedProposal(deps);
    const app = await buildApp(deps);
    assert.equal(
      (await reject(app, other.proposalId, 'user_1', { feedback: { reasonCode: 'other', detail: '  更合适的原因  ' } }))
        .statusCode,
      200,
    );
    assert.deepEqual(deps.store.get(other.proposalId).latestHumanDisposition, {
      reasonCode: 'other',
      detail: '更合适的原因',
    });

    const spoof = await reject(app, spoofed.proposalId, 'user_1', {
      feedback: { reasonCode: 'wrong', ownerUserId: 'attacker' },
    });
    assert.equal(spoof.statusCode, 400);
    assert.equal(deps.store.get(spoofed.proposalId).status, 'pending');
    assert.equal(deps.store.get(spoofed.proposalId).latestHumanDisposition, undefined);
  });

  it('dedupes exact reject replay but rejects changed feedback', async () => {
    const deps = buildDeps();
    const p = seedProposal(deps);
    const app = await buildApp(deps);
    const feedback = { feedback: { reasonCode: 'wrong_lane' } };

    assert.equal((await reject(app, p.proposalId, 'user_1', feedback)).statusCode, 200);
    const replay = await reject(app, p.proposalId, 'user_1', feedback);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().deduped, true);

    const conflict = await reject(app, p.proposalId, 'user_1', {
      feedback: { reasonCode: 'bad_evidence' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(deps.store.get(p.proposalId).latestHumanDisposition, { reasonCode: 'wrong_lane' });
  });

  it('fails closed for legacy rejected rows and never treats expired as rejected', async () => {
    const deps = buildDeps();
    const legacy = seedProposal(deps);
    const expired = seedProposal(deps);
    deps.store.markExpired(expired.proposalId);
    const canonicalGet = deps.store.get.bind(deps.store);
    const legacySnapshot = { ...canonicalGet(legacy.proposalId), status: 'rejected', updatedAt: 1 };
    deps.store.get = (proposalId) => (proposalId === legacy.proposalId ? legacySnapshot : canonicalGet(proposalId));
    const canonicalReject = deps.store.markRejected.bind(deps.store);
    deps.store.markRejected = (proposalId, input) =>
      proposalId === legacy.proposalId
        ? { outcome: 'legacy_unmigrated', proposal: legacySnapshot }
        : canonicalReject(proposalId, input);
    const app = await buildApp(deps);

    const legacyReplay = await reject(app, legacy.proposalId);
    assert.equal(legacyReplay.statusCode, 409);
    assert.equal(legacyReplay.json().reason, 'legacy_disposition_unmigrated');

    const late = await reject(app, expired.proposalId, 'user_1', { feedback: { reasonCode: 'wrong' } });
    assert.equal(late.statusCode, 409);
    assert.equal(deps.store.get(expired.proposalId).status, 'expired');
    assert.equal(deps.store.get(expired.proposalId).latestHumanDisposition, undefined);
  });

  it('staged publication blocks approve and reject before any handoff effect', async () => {
    const deps = buildDeps();
    const approveProposal = seedProposal(deps, { anchored: false });
    const rejectProposal = seedProposal(deps, { anchored: false });
    const app = await buildApp(deps);

    assert.equal((await approve(app, approveProposal.proposalId)).statusCode, 409);
    assert.equal((await reject(app, rejectProposal.proposalId)).statusCode, 409);
    assert.equal(deps.store.get(approveProposal.proposalId).status, 'pending');
    assert.equal(deps.store.get(rejectProposal.proposalId).status, 'pending');
    assert.equal(deps.sealCalls.length, 0);
    assert.equal(deps.enqueueCalls.length, 0);
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
    deps.store.markRejected(p.proposalId, { decidedAt: 400 }); // settled
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
