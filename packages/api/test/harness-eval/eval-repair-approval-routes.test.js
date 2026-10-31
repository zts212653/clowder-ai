import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

import { evalRepairApprovalRoutes } from '../../dist/routes/eval-repair-approval-routes.js';

describe('F313 eval repair Approval routes', () => {
  let app;
  let calls;
  let service;
  let record;

  beforeEach(async () => {
    calls = { propose: [], decide: [], materialize: [] };
    record = {
      invocationId: 'inv-1',
      callbackToken: 'token-1',
      userId: 'owner-user',
      catId: 'codex-sol',
      threadId: 'thread-f313',
      originTriggerMessageId: 'message-origin-1',
      clientMessageIds: new Set(),
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    };
    service = {
      async propose(input) {
        calls.propose.push(structuredClone(input));
        return {
          status: 'published',
          proposalId: 'proposal-1',
          approvalPublicationRef: 'approval-envelope:F266:proposal-1',
        };
      },
      async decide(input) {
        calls.decide.push(structuredClone(input));
        return {
          status:
            input.decision === 'accept'
              ? 'accepted'
              : input.decision === 'reject'
                ? 'rejected'
                : 'closed_without_decision',
        };
      },
      async materialize(proposalId) {
        calls.materialize.push(proposalId);
        return { status: 'materialized', receipt: {} };
      },
    };
    app = Fastify({ logger: false });
    await app.register(evalRepairApprovalRoutes, {
      callbackRegistry: {
        async verify(invocationId, callbackToken) {
          return invocationId === record.invocationId && callbackToken === record.callbackToken
            ? { ok: true, record }
            : { ok: false, reason: 'invalid_token' };
        },
      },
      service,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts only opaque case/action ref plus idempotency key and derives principal from auth record', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-eval-repair',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { caseActionRef: 'case-action:f266:opaque', clientMessageId: 'client-1' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.propose.length, 1);
    assert.deepEqual(calls.propose[0], {
      caseActionRef: 'case-action:f266:opaque',
      clientMessageId: 'client-1',
      principal: {
        invocationId: 'inv-1',
        userId: 'owner-user',
        catId: 'codex-sol',
        threadId: 'thread-f313',
        originMessageId: 'message-origin-1',
      },
    });
  });

  it('rejects body-authored owner, thread, origin, or target fields with zero service calls', async () => {
    for (const forged of [
      { ownerUserId: 'attacker' },
      { threadId: 'thread-other' },
      { originMessageId: 'message-other' },
      { targetVersionRef: { version: 'attacker' } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/propose-eval-repair',
        headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
        payload: {
          caseActionRef: 'case-action:f266:opaque',
          clientMessageId: `client-${Object.keys(forged)[0]}`,
          ...forged,
        },
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.propose.length, 0);
  });

  it('blocks missing authenticated origin before proposal/card/event work', async () => {
    delete record.originTriggerMessageId;
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-eval-repair',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
      payload: { caseActionRef: 'case-action:f266:opaque', clientMessageId: 'client-1' },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'origin_unbound');
    assert.equal(calls.propose.length, 0);
  });

  it('returns a typed route-unavailable blocker with zero proposal or decision effects', async () => {
    const unavailable = Fastify({ logger: false });
    await unavailable.register(evalRepairApprovalRoutes, {
      callbackRegistry: {
        async verify() {
          return { ok: true, record };
        },
      },
    });
    await unavailable.ready();
    try {
      const proposed = await unavailable.inject({
        method: 'POST',
        url: '/api/callbacks/propose-eval-repair',
        headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' },
        payload: { caseActionRef: 'case-action:f266:opaque', clientMessageId: 'client-1' },
      });
      assert.equal(proposed.statusCode, 503);
      assert.deepEqual(proposed.json(), { status: 'blocked', reason: 'approval_route_unavailable' });

      const decided = await unavailable.inject({
        method: 'POST',
        url: '/api/eval-repair-proposals/proposal-1/approve',
        headers: { 'x-cat-cafe-user': 'owner-user' },
      });
      assert.equal(decided.statusCode, 503);
      assert.deepEqual(decided.json(), { status: 'blocked', reason: 'approval_route_unavailable' });
      assert.deepEqual(calls, { propose: [], decide: [], materialize: [] });
    } finally {
      await unavailable.close();
    }
  });

  it('requires user identity for decisions and materializes only after accept', async () => {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/eval-repair-proposals/proposal-1/approve',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const approved = await app.inject({
      method: 'POST',
      url: '/api/eval-repair-proposals/proposal-1/approve',
      headers: { 'x-cat-cafe-user': 'owner-user' },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(calls.decide.at(-1).decidedByUserId, 'owner-user');
    assert.deepEqual(calls.materialize, ['proposal-1']);

    service.decide = async (input) => {
      calls.decide.push(structuredClone(input));
      return { status: 'duplicate', resolution: 'accepted' };
    };
    const replayedApproval = await app.inject({
      method: 'POST',
      url: '/api/eval-repair-proposals/proposal-1/approve',
      headers: { 'x-cat-cafe-user': 'owner-user' },
    });
    assert.equal(replayedApproval.statusCode, 200);
    assert.deepEqual(calls.materialize, ['proposal-1', 'proposal-1'], 'accepted replay must recover materialization');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/eval-repair-proposals/proposal-2/reject',
      headers: { 'x-cat-cafe-user': 'owner-user' },
      payload: { reasonCode: 'wrong_target', reasonText: 'The target moved' },
    });
    assert.equal(rejected.statusCode, 200);
    assert.deepEqual(calls.materialize, ['proposal-1', 'proposal-1']);
  });
});
