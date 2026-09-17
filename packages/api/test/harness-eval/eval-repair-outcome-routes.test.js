import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

import { evalRepairOutcomeRoutes } from '../../dist/routes/eval-repair-outcome-routes.js';

const owner = (ownerFeatureId, ownerStateRef, version) =>
  version === undefined ? { ownerFeatureId, ownerStateRef } : { ownerFeatureId, ownerStateRef, version };
const targetVersionRef = {
  ...owner('F311', 'capability:f311-investor-roadshow-expression', 'owner-binding-v1'),
  assetKind: 'capability',
  assetId: 'f311-investor-roadshow-expression',
};
const boundRefs = {
  caseRef: owner('F266', 'eval-repair-case:case-1'),
  proposalRef: owner('F266', 'eval-repair-proposal:proposal-1'),
  approvalRef: owner('F246', 'approval:proposal-1'),
  ownerAuthorizationRef: owner('F311', 'owner-authorization:authorization-1'),
  targetVersionRef,
  interventionRef: owner('F311', 'capability:f311-investor-roadshow-expression'),
};

describe('F313 owner outcome callback routes', () => {
  let app;
  let record;
  let calls;

  beforeEach(async () => {
    calls = { intervention: [], outcome: [] };
    record = {
      invocationId: 'inv-owner-1',
      callbackToken: 'token-owner-1',
      userId: 'default-user',
      catId: 'codex-sol',
      threadId: 'thread-owner-1',
      ownerAuthProvenance: 'strict',
      originTriggerMessageId: 'message-owner-1',
      clientMessageIds: new Set(),
      createdAt: Date.now() - 1_000,
      expiresAt: null,
      state: 'active',
    };
    app = Fastify({ logger: false });
    await app.register(evalRepairOutcomeRoutes, {
      callbackRegistry: {
        async verify(invocationId, callbackToken) {
          return invocationId === record.invocationId && callbackToken === record.callbackToken
            ? { ok: true, record }
            : { ok: false, reason: 'invalid_token' };
        },
      },
      ownerUserId: 'default-user',
      service: {
        async recordIntervention(input) {
          calls.intervention.push(structuredClone(input));
          return { status: 'recorded', kind: 'no_change' };
        },
        async recordOutcome(input) {
          calls.outcome.push(structuredClone(input));
          return { status: 'blocked', reason: 'outcome_receipt_not_found' };
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('passes refs only after strict callback-owner verification', async () => {
    const receiptRef = owner('F311', 'owner-receipt:no-change-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/eval-repair-interventions',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: { ...boundRefs, receiptRef },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls.intervention, [{ ...boundRefs, receiptRef }]);
  });

  it('rejects missing/forged owner origin and body-authored origin with zero service calls', async () => {
    for (const mutate of [
      () => delete record.originTriggerMessageId,
      () => {
        record.originTriggerMessageId = 'message-owner-1';
        record.ownerAuthProvenance = 'unknown';
      },
      () => {
        record.ownerAuthProvenance = 'strict';
        record.userId = 'attacker';
      },
    ]) {
      mutate();
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/eval-repair-interventions',
        headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
        payload: { ...boundRefs, receiptRef: owner('F311', 'owner-receipt:no-change-1') },
      });
      assert.ok([403, 409].includes(response.statusCode));
    }
    record.ownerAuthProvenance = 'strict';
    record.userId = 'default-user';
    record.originTriggerMessageId = 'message-owner-1';
    const bodyOrigin = await app.inject({
      method: 'POST',
      url: '/api/callbacks/eval-repair-interventions',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: {
        ...boundRefs,
        receiptRef: owner('F311', 'owner-receipt:no-change-1'),
        originMessageId: 'forged',
      },
    });
    assert.equal(bodyOrigin.statusCode, 400);
    assert.deepEqual(calls, { intervention: [], outcome: [] });
  });

  it('returns forged/missing receipt blockers without manufacturing an event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/eval-repair-outcomes',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: {
        ...boundRefs,
        interventionReceiptRef: owner('F311', 'owner-receipt:no-change-1'),
        outcomeReceiptRef: owner('F311', 'owner-outcome:forged'),
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().reason, 'outcome_receipt_not_found');
    assert.equal(calls.outcome.length, 1);
  });

  it('keeps authenticated receipt commands unavailable while the owner runtime is dormant', async () => {
    const dormant = Fastify({ logger: false });
    await dormant.register(evalRepairOutcomeRoutes, {
      callbackRegistry: {
        async verify(invocationId, callbackToken) {
          return invocationId === record.invocationId && callbackToken === record.callbackToken
            ? { ok: true, record }
            : { ok: false, reason: 'invalid_token' };
        },
      },
      ownerUserId: 'default-user',
    });
    await dormant.ready();
    try {
      const response = await dormant.inject({
        method: 'POST',
        url: '/api/callbacks/eval-repair-interventions',
        headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
        payload: { ...boundRefs, receiptRef: owner('F311', 'owner-receipt:no-change-1') },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { status: 'blocked', reason: 'outcome_route_unavailable' });
      assert.deepEqual(calls, { intervention: [], outcome: [] });
    } finally {
      await dormant.close();
    }
  });
});
