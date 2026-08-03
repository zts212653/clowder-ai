import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { applyMigrations } from '../../dist/domains/memory/schema.js';
import {
  fingerprintDynamicTaskDef,
  ScheduleMutationProposalStore,
  ScheduleMutationProposalStoreError,
} from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';

const CREATED_AT = '2026-07-23T12:00:00.000Z';
const CREATED_AT_MS = Date.parse(CREATED_AT);

function task(overrides = {}) {
  return {
    id: 'dyn-approved-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: CREATED_AT_MS + 60_000 },
    params: { message: 'stretch' },
    display: { label: 'Stretch', category: 'system' },
    deliveryThreadId: 'thread-owner',
    enabled: true,
    createdBy: 'codex-sol',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function createProposal(overrides = {}) {
  return {
    proposalId: 'schedule-proposal-create-1',
    ownerUserId: 'owner-user',
    requesterCatId: 'codex-sol',
    mutation: { kind: 'create', task: task() },
    status: 'pending',
    publication: { state: 'staged', stagedAt: CREATED_AT_MS },
    createdAt: CREATED_AT_MS,
    ...overrides,
  };
}

function deleteProposal(target, overrides = {}) {
  return {
    proposalId: 'schedule-proposal-delete-1',
    ownerUserId: 'owner-user',
    requesterCatId: 'codex-sol',
    mutation: {
      kind: 'delete',
      taskId: target.id,
      expectedFingerprint: fingerprintDynamicTaskDef(target),
      taskSnapshot: target,
    },
    status: 'pending',
    publication: { state: 'staged', stagedAt: CREATED_AT_MS },
    createdAt: CREATED_AT_MS,
    ...overrides,
  };
}

function audit(action, taskId, suffix = action) {
  return {
    auditId: `schedule-audit-${suffix}`,
    ownerUserId: 'owner-user',
    actorKind: 'cvo',
    actorId: 'owner-user',
    action,
    taskId,
    detail: {},
    createdAt: CREATED_AT_MS,
  };
}

function setup() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return { db, store: new ScheduleMutationProposalStore(db) };
}

describe('ScheduleMutationProposalStore', () => {
  it('migrates persistent proposal and append-only direct-audit tables', () => {
    const { db } = setup();
    const proposalColumns = db.prepare('PRAGMA table_info(schedule_mutation_proposals)').all();
    const auditColumns = db.prepare('PRAGMA table_info(schedule_mutation_audit)').all();

    assert.deepEqual(
      proposalColumns.map((column) => column.name),
      [
        'proposal_id',
        'owner_user_id',
        'requester_cat_id',
        'mutation_kind',
        'mutation_json',
        'status',
        'publication_json',
        'effect_checkpoint_json',
        'created_at',
        'claimed_at',
        'approved_at',
        'approved_by',
        'rejected_at',
        'rejected_by',
        'rejection_reason',
      ],
    );
    assert.deepEqual(
      auditColumns.map((column) => column.name),
      ['audit_id', 'owner_user_id', 'actor_kind', 'actor_id', 'action', 'task_id', 'detail_json', 'created_at'],
    );
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schedule_mutation_audit'")
      .all();
    assert.deepEqual(triggers.map((trigger) => trigger.name).sort(), [
      'schedule_mutation_audit_no_delete',
      'schedule_mutation_audit_no_update',
    ]);
  });

  it('round-trips a staged immutable create proposal and anchors its envelope idempotently', () => {
    const { store } = setup();
    const proposal = createProposal();
    store.create(proposal);

    assert.deepEqual(store.getById(proposal.proposalId), proposal);
    assert.deepEqual(store.listPending('owner-user'), [proposal]);

    const envelope = {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F139',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.requesterCatId,
      originRef: {
        kind: 'event',
        anchor: 'schedule:invocation:inv-1:create:dyn-approved-1',
        summary: 'Cat requested a scheduled task',
        threadId: 'thread-owner',
      },
      approvalCardRef: { threadId: 'thread-owner', messageId: 'message-card-1' },
      createdAt: proposal.createdAt,
    };

    store.commitEnvelope(proposal.proposalId, envelope);
    store.commitEnvelope(proposal.proposalId, envelope);
    assert.deepEqual(store.getPublication(proposal.proposalId), { state: 'anchored', envelope });
    assert.throws(
      () =>
        store.commitEnvelope(proposal.proposalId, {
          ...envelope,
          approvalCardRef: { threadId: 'thread-owner', messageId: 'other-card' },
        }),
      /conflicting approval envelope/,
    );
  });

  it('claims and settles each proposal with compare-and-swap transitions', () => {
    const { store } = setup();
    const proposal = createProposal();
    store.create(proposal);

    const claimed = store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 1);
    assert.equal(claimed?.status, 'applying');
    assert.equal(store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 2), null);
    assert.equal(store.finalizeApproved(proposal.proposalId, 'owner-user', CREATED_AT_MS + 3), null);
    store.applyCreateEffect(proposal.proposalId, CREATED_AT_MS + 3);
    assert.equal(store.finalizeApproved(proposal.proposalId, 'owner-user', CREATED_AT_MS + 4)?.status, 'approved');
    assert.equal(store.finalizeApproved(proposal.proposalId, 'owner-user', CREATED_AT_MS + 5), null);

    const rejected = createProposal({ proposalId: 'schedule-proposal-reject-1' });
    store.create(rejected);
    assert.equal(store.reject(rejected.proposalId, 'owner-user', 'not now', CREATED_AT_MS + 6)?.status, 'rejected');
    assert.equal(store.reject(rejected.proposalId, 'owner-user', 'again', CREATED_AT_MS + 7), null);
  });

  it('materializes a create effect and its checkpoint atomically and exactly once', () => {
    const { db, store } = setup();
    const proposal = createProposal();
    store.create(proposal);
    store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 1);

    const first = store.applyCreateEffect(proposal.proposalId, CREATED_AT_MS + 2);
    const second = store.applyCreateEffect(proposal.proposalId, CREATED_AT_MS + 3);

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.deepEqual(first.task, task());
    assert.deepEqual(second.task, task());
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dynamic_task_defs').get().count, 1);
    assert.deepEqual(store.getById(proposal.proposalId)?.effectCheckpoint, {
      kind: 'create',
      taskId: task().id,
      appliedAt: CREATED_AT_MS + 2,
    });
  });

  it('rebases a relative once delay exactly once and preserves it across retries', () => {
    const { db, store } = setup();
    const target = task({ id: 'dyn-relative-once' });
    const proposal = createProposal({
      proposalId: 'schedule-proposal-relative-once',
      mutation: { kind: 'create', task: target, relativeOnceDelayMs: 60_000 },
    });
    store.create(proposal);
    store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 1);

    const first = store.applyCreateEffect(proposal.proposalId, CREATED_AT_MS + 90_000);
    const second = store.applyCreateEffect(proposal.proposalId, CREATED_AT_MS + 180_000);
    const expectedFireAt = CREATED_AT_MS + 150_000;

    assert.deepEqual(first.task.trigger, { type: 'once', fireAt: expectedFireAt });
    assert.deepEqual(second.task.trigger, { type: 'once', fireAt: expectedFireAt });
    assert.equal(
      JSON.parse(db.prepare('SELECT trigger_json FROM dynamic_task_defs WHERE id = ?').get(target.id).trigger_json)
        .fireAt,
      expectedFireAt,
    );
  });

  it('rejects a drifted delete, restores pending state and preserves the replacement task', () => {
    const { db, store } = setup();
    const original = task({ id: 'dyn-delete-1' });
    const replacement = task({
      id: original.id,
      trigger: { type: 'interval', ms: 30_000 },
      createdBy: 'owner-user',
    });
    insertDynamicTask(db, replacement);
    const proposal = deleteProposal(original);
    store.create(proposal);
    store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 1);

    assert.throws(
      () => store.applyDeleteEffect(proposal.proposalId, CREATED_AT_MS + 2),
      (error) =>
        error instanceof ScheduleMutationProposalStoreError &&
        error.code === 'SCHEDULE_TASK_DRIFT' &&
        error.statusCode === 409,
    );
    assert.equal(store.getById(proposal.proposalId)?.status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dynamic_task_defs WHERE id = ?').get(original.id).count, 1);
  });

  it('deletes and checkpoints the expected task atomically and exactly once', () => {
    const { db, store } = setup();
    const target = task({ id: 'dyn-delete-2' });
    insertDynamicTask(db, target);
    const proposal = deleteProposal(target, { proposalId: 'schedule-proposal-delete-2' });
    store.create(proposal);
    store.claimForApproval(proposal.proposalId, CREATED_AT_MS + 1);

    const first = store.applyDeleteEffect(proposal.proposalId, CREATED_AT_MS + 2);
    const second = store.applyDeleteEffect(proposal.proposalId, CREATED_AT_MS + 3);

    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.deepEqual(first.task, target);
    assert.deepEqual(second.task, target);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dynamic_task_defs WHERE id = ?').get(target.id).count, 0);
    assert.deepEqual(store.getById(proposal.proposalId)?.effectCheckpoint, {
      kind: 'delete',
      taskId: target.id,
      expectedFingerprint: fingerprintDynamicTaskDef(target),
      deletedAt: CREATED_AT_MS + 2,
    });
  });

  it('persists direct mutation audits without TTL and refuses history rewrites', () => {
    const { db, store } = setup();
    const audit = {
      auditId: 'schedule-audit-1',
      ownerUserId: 'owner-user',
      actorKind: 'cvo',
      actorId: 'owner-user',
      action: 'create',
      taskId: 'dyn-direct-1',
      detail: { source: 'owner-session' },
      createdAt: CREATED_AT_MS,
    };
    store.appendAudit(audit);

    assert.deepEqual(store.listAudit('owner-user'), [audit]);
    assert.throws(
      () => db.prepare("UPDATE schedule_mutation_audit SET action = 'delete' WHERE audit_id = ?").run(audit.auditId),
      /append-only/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM schedule_mutation_audit WHERE audit_id = ?').run(audit.auditId),
      /append-only/,
    );
  });

  it('persists every direct task mutation and its audit row in one transaction', () => {
    const { db, store } = setup();
    const target = task({ id: 'dyn-direct-atomic' });

    store.insertTaskWithAudit(target, audit('create', target.id));
    assert.equal(db.prepare('SELECT enabled FROM dynamic_task_defs WHERE id = ?').get(target.id).enabled, 1);

    assert.equal(store.setTaskEnabledWithAudit(target.id, false, audit('pause', target.id)), true);
    assert.equal(db.prepare('SELECT enabled FROM dynamic_task_defs WHERE id = ?').get(target.id).enabled, 0);

    assert.equal(store.setTaskEnabledWithAudit(target.id, true, audit('resume', target.id)), true);
    assert.equal(db.prepare('SELECT enabled FROM dynamic_task_defs WHERE id = ?').get(target.id).enabled, 1);

    assert.equal(store.deleteTaskWithAudit(target.id, audit('delete', target.id)), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM dynamic_task_defs WHERE id = ?').get(target.id).count, 0);
    assert.deepEqual(
      store.listAudit('owner-user').map((entry) => entry.action),
      ['create', 'pause', 'resume', 'delete'],
    );
  });

  for (const mutation of [
    {
      action: 'create',
      initialTask: null,
      mutate(store, target) {
        store.insertTaskWithAudit(target, audit('create', target.id, 'failed-create'));
      },
      expectedTaskCount: 0,
      expectedEnabled: null,
    },
    {
      action: 'pause',
      initialTask: task({ id: 'dyn-failed-pause' }),
      mutate(store, target) {
        store.setTaskEnabledWithAudit(target.id, false, audit('pause', target.id, 'failed-pause'));
      },
      expectedTaskCount: 1,
      expectedEnabled: 1,
    },
    {
      action: 'resume',
      initialTask: task({ id: 'dyn-failed-resume', enabled: false }),
      mutate(store, target) {
        store.setTaskEnabledWithAudit(target.id, true, audit('resume', target.id, 'failed-resume'));
      },
      expectedTaskCount: 1,
      expectedEnabled: 0,
    },
    {
      action: 'delete',
      initialTask: task({ id: 'dyn-failed-delete' }),
      mutate(store, target) {
        store.deleteTaskWithAudit(target.id, audit('delete', target.id, 'failed-delete'));
      },
      expectedTaskCount: 1,
      expectedEnabled: 1,
    },
  ]) {
    it(`rolls back a direct ${mutation.action} when its audit insert fails`, () => {
      const { db, store } = setup();
      const target = mutation.initialTask ?? task({ id: 'dyn-failed-create' });
      if (mutation.initialTask) insertDynamicTask(db, mutation.initialTask);
      db.exec(`
        CREATE TRIGGER fail_schedule_${mutation.action}_audit
        BEFORE INSERT ON schedule_mutation_audit
        WHEN NEW.action = '${mutation.action}'
        BEGIN
          SELECT RAISE(ABORT, 'forced schedule ${mutation.action} audit failure');
        END;
      `);

      assert.throws(() => mutation.mutate(store, target), /forced schedule .* audit failure/);
      const row = db.prepare('SELECT enabled FROM dynamic_task_defs WHERE id = ?').get(target.id);
      assert.equal(row ? 1 : 0, mutation.expectedTaskCount);
      assert.equal(row?.enabled ?? null, mutation.expectedEnabled);
      assert.equal(store.listAudit('owner-user').length, 0);
    });
  }
});

function insertDynamicTask(db, def) {
  db.prepare(
    `INSERT INTO dynamic_task_defs
      (id, template_id, trigger_json, params_json, display_json, delivery_thread_id, enabled, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    def.id,
    def.templateId,
    JSON.stringify(def.trigger),
    JSON.stringify(def.params),
    JSON.stringify(def.display),
    def.deliveryThreadId,
    def.enabled ? 1 : 0,
    def.createdBy,
    def.createdAt,
  );
}
