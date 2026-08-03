import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { F139ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F139ApprovalAdapter.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { ScheduleMutationProposalStore } from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';

const CREATED_AT = Date.parse('2026-07-23T12:00:00.000Z');

function task(id = 'dyn-f139-adapter') {
  return {
    id,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: CREATED_AT + 60_000 },
    params: { message: 'review me' },
    display: { label: 'Review me', category: 'system' },
    deliveryThreadId: 'thread-owner',
    enabled: true,
    createdBy: 'codex-sol',
    createdAt: new Date(CREATED_AT).toISOString(),
  };
}

function proposal(overrides = {}) {
  return {
    proposalId: 'schedule-proposal-adapter',
    ownerUserId: 'owner-user',
    requesterCatId: 'codex-sol',
    mutation: { kind: 'create', task: task() },
    status: 'pending',
    publication: { state: 'staged', stagedAt: CREATED_AT },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function setup() {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new ScheduleMutationProposalStore(db);
  return { db, store, adapter: new F139ApprovalAdapter(store) };
}

function anchor(store, value) {
  store.commitEnvelope(value.proposalId, {
    canonicalProposalId: value.proposalId,
    sourceFeatureId: 'F139',
    ownerUserId: value.ownerUserId,
    requesterCatId: value.requesterCatId,
    originRef: {
      kind: 'event',
      anchor: `schedule:invocation:inv-1:create:${value.mutation.task.id}`,
      summary: 'Verified cat requested schedule create',
      threadId: 'thread-owner',
    },
    approvalCardRef: { threadId: 'thread-owner', messageId: `card-${value.proposalId}` },
    createdAt: value.createdAt,
  });
}

describe('F139ApprovalAdapter', () => {
  it('projects only anchored pending proposals with inline decision navigation', () => {
    const { db, store, adapter } = setup();
    try {
      const staged = proposal({ proposalId: 'schedule-staged' });
      const tombstoned = proposal({ proposalId: 'schedule-tombstoned' });
      const anchored = proposal({ proposalId: 'schedule-anchored' });
      store.create(staged);
      store.create(tombstoned);
      store.abortStaged(tombstoned.proposalId, 'card append failed');
      store.create(anchored);
      anchor(store, anchored);

      const items = adapter.listPending('owner-user');

      assert.equal(items.length, 1);
      assert.equal(items[0].proposalId, anchored.proposalId);
      assert.equal(items[0].sourceFeatureId, 'F139');
      assert.equal(items[0].inlineApprovable, true);
      assert.equal(items[0].decisionMode, 'approve-reject');
      assert.equal(items[0].navigation.state, 'anchored');
      assert.equal(items[0].detail.mutationKind, 'create');
    } finally {
      db.close();
    }
  });

  it('projects an applying recovery item as resume-only', () => {
    const { db, store, adapter } = setup();
    try {
      const recovering = proposal({ proposalId: 'schedule-applying-recovery' });
      store.create(recovering);
      anchor(store, recovering);
      store.claimForApproval(recovering.proposalId, CREATED_AT + 1);

      const [item] = adapter.listPending('owner-user');

      assert.equal(item.proposalId, recovering.proposalId);
      assert.equal(item.decisionMode, 'resume-only');
    } finally {
      db.close();
    }
  });

  it('isolates pending and settled projections by owner', () => {
    const { db, store, adapter } = setup();
    try {
      const ownerProposal = proposal();
      const otherProposal = proposal({
        proposalId: 'schedule-proposal-other-owner',
        ownerUserId: 'other-user',
        mutation: { kind: 'create', task: task('dyn-other-owner') },
      });
      store.create(ownerProposal);
      store.create(otherProposal);
      anchor(store, ownerProposal);
      anchor(store, otherProposal);

      assert.deepEqual(
        adapter.listPending('owner-user').map((item) => item.proposalId),
        [ownerProposal.proposalId],
      );
      assert.deepEqual(
        adapter.listPending('other-user').map((item) => item.proposalId),
        [otherProposal.proposalId],
      );

      store.claimForApproval(ownerProposal.proposalId, CREATED_AT + 1);
      store.applyCreateEffect(ownerProposal.proposalId, CREATED_AT + 2);
      store.finalizeApproved(ownerProposal.proposalId, 'owner-user', CREATED_AT + 3);

      const [settled] = adapter.listSettled('owner-user');
      assert.equal(settled.proposalId, ownerProposal.proposalId);
      assert.equal(settled.status, 'approved');
      assert.equal(settled.decidedBy, 'owner-user');
      assert.equal(settled.navigation.state, 'anchored');
      assert.deepEqual(adapter.listSettled('other-user'), []);
    } finally {
      db.close();
    }
  });

  it('projects anchored rejected proposals into history without an effect', () => {
    const { db, store, adapter } = setup();
    try {
      const rejected = proposal({ proposalId: 'schedule-proposal-rejected' });
      store.create(rejected);
      anchor(store, rejected);
      store.reject(rejected.proposalId, 'owner-user', 'not now', CREATED_AT + 1);

      const [settled] = adapter.listSettled('owner-user');
      assert.equal(settled.status, 'rejected');
      assert.equal(settled.decidedAt, CREATED_AT + 1);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM dynamic_task_defs').get().count,
        0,
        'rejection must not create the scheduled task',
      );
    } finally {
      db.close();
    }
  });
});
