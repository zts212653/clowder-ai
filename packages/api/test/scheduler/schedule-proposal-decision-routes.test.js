import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createDecisionFixture,
  createProposal,
  deleteProposal,
  NOW,
  OWNER,
  task,
} from './schedule-proposal-decision-fixture.js';

describe('schedule proposal decisions', () => {
  let fixture;
  let app;
  let dynamicStore;
  let store;
  let runner;
  let notifications;
  let socketEvents;

  beforeEach(async () => {
    fixture = await createDecisionFixture();
    ({ app, dynamicStore, store, runner, notifications, socketEvents } = fixture);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it('blocks staged approval before claim or scheduler effect', async () => {
    const proposal = createProposal();
    store.create(proposal);

    const response = await fixture.decide(proposal.proposalId, 'approve');

    assert.equal(response.statusCode, 409);
    assert.equal(store.getById(proposal.proposalId)?.status, 'pending');
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(runner.getTaskSummaries().length, 0);
  });

  it('blocks tombstoned approve and reject before claim or scheduler effect', async () => {
    for (const action of ['approve', 'reject']) {
      const value = createProposal({ proposalId: `schedule-tombstoned-${action}` });
      store.create(value);
      store.abortStaged(value.proposalId, 'card append failed');

      const response = await fixture.decide(value.proposalId, action);

      assert.equal(response.statusCode, 409);
      assert.equal(store.getById(value.proposalId)?.status, 'pending');
      assert.equal(dynamicStore.getAll().length, 0);
      assert.equal(runner.getTaskSummaries().length, 0);
    }
  });

  it('requires the configured owner session for reads and decisions', async () => {
    const value = createProposal({ proposalId: 'schedule-owner-auth' });
    store.create(value);
    fixture.anchor(value);

    const unauthenticatedRead = await app.inject({
      method: 'GET',
      url: `/api/schedule-proposals/${value.proposalId}`,
    });
    const wrongOwnerRead = await app.inject({
      method: 'GET',
      url: `/api/schedule-proposals/${value.proposalId}`,
      headers: { 'x-owner-session': 'other' },
    });
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/schedule-proposals/${value.proposalId}/approve`,
    });
    const wrongOwner = await app.inject({
      method: 'POST',
      url: `/api/schedule-proposals/${value.proposalId}/approve`,
      headers: { 'x-owner-session': 'other' },
    });

    assert.equal(unauthenticatedRead.statusCode, 401);
    assert.equal(wrongOwnerRead.statusCode, 403);
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(wrongOwner.statusCode, 403);
    assert.equal(store.getById(value.proposalId)?.status, 'pending');
    assert.equal(dynamicStore.getAll().length, 0);
  });

  it('rejects a remotely bootstrapped owner session when no separate owner gate is configured', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;
    try {
      const value = createProposal({ proposalId: 'schedule-remote-bootstrap-session' });
      store.create(value);
      fixture.anchor(value);

      const response = await app.inject({
        method: 'POST',
        url: `/api/schedule-proposals/${value.proposalId}/approve`,
        headers: { 'x-owner-session': 'true' },
        remoteAddress: '203.0.113.10',
      });

      assert.equal(response.statusCode, 403);
      assert.match(response.json().error, /non-localhost.*DEFAULT_OWNER_USER_ID/);
      assert.equal(store.getById(value.proposalId)?.status, 'pending');
      assert.equal(dynamicStore.getAll().length, 0);
    } finally {
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('approves a create exactly once with one persistent and runtime task', async () => {
    const proposal = createProposal({ proposalId: 'schedule-create-once' });
    store.create(proposal);
    fixture.anchor(proposal);

    const first = await fixture.decide(proposal.proposalId, 'approve');
    const second = await fixture.decide(proposal.proposalId, 'approve');

    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'approved');
    assert.equal(second.statusCode, 409);
    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(runner.getTaskSummaries().filter((task) => task.id === proposal.mutation.task.id).length, 1);
    assert.equal(notifications.length, 1);
  });

  it('rebases a relative once delay when the owner approves the proposal', async () => {
    const relativeOnceDelayMs = 600_000;
    const proposal = createProposal({
      proposalId: 'schedule-create-relative-once',
      mutation: {
        kind: 'create',
        task: task({ trigger: { type: 'once', fireAt: NOW + relativeOnceDelayMs } }),
        relativeOnceDelayMs,
      },
    });
    store.create(proposal);
    fixture.anchor(proposal);
    const approvedAtFloor = Date.now();

    const response = await fixture.decide(proposal.proposalId, 'approve');

    assert.equal(response.statusCode, 200);
    const persisted = dynamicStore.getById(proposal.mutation.task.id);
    assert.equal(persisted?.trigger.type, 'once');
    assert.ok(persisted.trigger.fireAt >= approvedAtFloor + relativeOnceDelayMs);
  });

  it('rejects an anchored create with zero scheduler effect', async () => {
    const proposal = createProposal({ proposalId: 'schedule-create-reject' });
    store.create(proposal);
    fixture.anchor(proposal);

    const response = await fixture.decide(proposal.proposalId, 'reject', { rejectionReason: 'not now' });

    assert.equal(response.statusCode, 200);
    assert.equal(store.getById(proposal.proposalId)?.status, 'rejected');
    assert.equal(dynamicStore.getAll().length, 0);
    assert.equal(runner.getTaskSummaries().length, 0);
  });

  it('emits proposal_updated after successful approve and reject decisions', async () => {
    const approved = createProposal({ proposalId: 'schedule-socket-approved' });
    store.create(approved);
    fixture.anchor(approved);
    const rejected = createProposal({ proposalId: 'schedule-socket-rejected' });
    store.create(rejected);
    fixture.anchor(rejected);

    assert.equal((await fixture.decide(approved.proposalId, 'approve')).statusCode, 200);
    assert.equal((await fixture.decide(rejected.proposalId, 'reject')).statusCode, 200);

    assert.deepEqual(
      socketEvents.map(({ userId, event, payload }) => ({
        userId,
        event,
        proposalId: payload.proposalId,
        status: payload.status,
      })),
      [
        {
          userId: OWNER,
          event: 'proposal_updated',
          proposalId: approved.proposalId,
          status: 'approved',
        },
        {
          userId: OWNER,
          event: 'proposal_updated',
          proposalId: rejected.proposalId,
          status: 'rejected',
        },
      ],
    );
  });

  it('returns the durable proposal status for authenticated card hydration', async () => {
    const value = createProposal({ proposalId: 'schedule-card-hydration' });
    store.create(value);
    fixture.anchor(value);
    assert.equal((await fixture.decide(value.proposalId, 'reject')).statusCode, 200);

    const response = await app.inject({
      method: 'GET',
      url: `/api/schedule-proposals/${value.proposalId}`,
      headers: { 'x-owner-session': 'true' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().proposal.proposalId, value.proposalId);
    assert.equal(response.json().proposal.status, 'rejected');
  });

  it('rejects an anchored delete and preserves the task', async () => {
    const target = task({ id: 'dyn-delete-reject' });
    dynamicStore.insert(target);
    fixture.register(target);
    const value = deleteProposal(target, { proposalId: 'schedule-delete-reject' });
    store.create(value);
    fixture.anchor(value);

    const response = await fixture.decide(value.proposalId, 'reject', { rejectionReason: 'keep it' });

    assert.equal(response.statusCode, 200);
    assert.equal(store.getById(value.proposalId)?.status, 'rejected');
    assert.ok(dynamicStore.getById(target.id));
    assert.equal(
      runner.getTaskSummaries().some((summary) => summary.id === target.id),
      true,
    );
  });

  it('recovers an applying create after its persistent effect checkpoint without duplicating the task', async () => {
    const value = createProposal({ proposalId: 'schedule-create-recovery' });
    store.create(value);
    fixture.anchor(value);
    store.claimForApproval(value.proposalId, NOW + 1);
    store.applyCreateEffect(value.proposalId, NOW + 2);

    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(runner.getTaskSummaries().length, 0, 'simulated crash happens before runtime registration');

    const response = await fixture.decide(value.proposalId, 'approve');

    assert.equal(response.statusCode, 200);
    assert.equal(store.getById(value.proposalId)?.status, 'approved');
    assert.equal(dynamicStore.getAll().length, 1);
    assert.equal(runner.getTaskSummaries().filter((summary) => summary.id === value.mutation.task.id).length, 1);
  });

  it('returns 409 on delete drift, restores pending and preserves the replacement', async () => {
    const original = task({ id: 'dyn-delete-drift' });
    dynamicStore.insert(original);
    const proposal = deleteProposal(original, { proposalId: 'schedule-delete-drift' });
    store.create(proposal);
    fixture.anchor(proposal);
    dynamicStore.upsert({
      ...original,
      trigger: { type: 'interval', ms: 30_000 },
    });

    const response = await fixture.decide(proposal.proposalId, 'approve');

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'SCHEDULE_TASK_DRIFT');
    assert.equal(store.getById(proposal.proposalId)?.status, 'pending');
    assert.ok(dynamicStore.getById(original.id));
  });

  it('approves a fingerprint-bound delete exactly once', async () => {
    const target = task({ id: 'dyn-delete-once' });
    dynamicStore.insert(target);
    fixture.register(target);
    const proposal = deleteProposal(target, { proposalId: 'schedule-delete-once' });
    store.create(proposal);
    fixture.anchor(proposal);

    const first = await fixture.decide(proposal.proposalId, 'approve');
    const second = await fixture.decide(proposal.proposalId, 'approve');

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(dynamicStore.getById(target.id), null);
    assert.equal(
      runner.getTaskSummaries().some((summary) => summary.id === target.id),
      false,
    );
    assert.equal(notifications.length, 1);
  });
});
