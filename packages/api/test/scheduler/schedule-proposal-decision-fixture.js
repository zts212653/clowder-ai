import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ApprovalDecisionReceiptOutbox } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptOutbox.js';
import { ApprovalDecisionReceiptService } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptService.js';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
} from '../../dist/domains/approval-hub/ApprovalProducerRegistry.js';
import { F139ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F139ApprovalAdapter.js';
import { installApprovalDecisionReceiptHooks } from '../../dist/domains/approval-hub/approval-decision-receipt-hooks.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import {
  fingerprintDynamicTaskDef,
  ScheduleMutationProposalStore,
} from '../../dist/infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { TaskRunnerV2 } from '../../dist/infrastructure/scheduler/TaskRunnerV2.js';
import { templateRegistry } from '../../dist/infrastructure/scheduler/templates/registry.js';
import { scheduleProposalDecisionRoutes } from '../../dist/routes/schedule-proposal-decision-routes.js';

export const OWNER = 'owner-user';
export const NOW = Date.parse('2026-07-23T12:00:00.000Z');

export async function createDecisionFixture(options = {}) {
  const previousOwnerUserId = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const db = new Database(options.dbPath ?? ':memory:');
  applyMigrations(db);
  const dynamicStore = new DynamicTaskStore(db);
  const store = new ScheduleMutationProposalStore(db);
  const runner = new TaskRunnerV2({
    logger: { info() {}, error() {} },
    ledger: new RunLedger(db),
    dynamicTaskStore: dynamicStore,
  });
  const notifications = [];
  const messageStore = options.messageStore ?? new MessageStore();
  const outbox = new ApprovalDecisionReceiptOutbox(db);
  const socketEvents = [];
  const app = Fastify({ logger: false });
  const receipts = new ApprovalDecisionReceiptService({
    registry: new ApprovalProducerRegistry({ F139: bindLegacyApprovalProducer(new F139ApprovalAdapter(store)) }),
    messageStore,
    outbox,
    logger: options.logger ?? app.log,
    invocationTracker: options.invocationTracker,
  });
  installApprovalDecisionReceiptHooks(app, () => receipts);
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-owner-session'] === 'true') request.sessionUserId = OWNER;
    if (request.headers['x-owner-session'] === 'other') request.sessionUserId = 'other-user';
  });
  await app.register(scheduleProposalDecisionRoutes, {
    ownerUserId: OWNER,
    store,
    taskRunner: runner,
    templateRegistry,
    notifyLifecycle: (notice) => notifications.push(notice),
    socketManager: {
      emitToUser(userId, event, payload) {
        socketEvents.push({ userId, event, payload });
      },
    },
  });
  await app.ready();

  return {
    app,
    dynamicStore,
    store,
    runner,
    notifications,
    messageStore,
    receipts,
    outbox,
    socketEvents,
    decide(proposalId, action, payload) {
      return app.inject({
        method: 'POST',
        url: `/api/schedule-proposals/${proposalId}/${action}`,
        headers: { 'x-owner-session': 'true' },
        ...(payload ? { payload } : {}),
      });
    },
    anchor(proposal) {
      store.commitEnvelope(proposal.proposalId, {
        canonicalProposalId: proposal.proposalId,
        sourceFeatureId: 'F139',
        ownerUserId: OWNER,
        requesterCatId: proposal.requesterCatId,
        originRef: {
          kind: 'event',
          anchor: `schedule:test:${proposal.proposalId}`,
          summary: 'test schedule mutation',
          threadId: 'thread-owner',
        },
        approvalCardRef: { threadId: 'thread-owner', messageId: `card-${proposal.proposalId}` },
        createdAt: proposal.createdAt,
      });
    },
    register(def) {
      const template = templateRegistry.get(def.templateId);
      const spec = template.createSpec(def.id, {
        trigger: def.trigger,
        params: def.params,
        deliveryThreadId: def.deliveryThreadId,
      });
      spec.display = def.display;
      runner.registerDynamic(spec, def.id);
    },
    async close() {
      runner.stop();
      await app.close();
      db.close();
      if (previousOwnerUserId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwnerUserId;
    },
  };
}

export function task(overrides = {}) {
  return {
    id: 'dyn-create-once',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: NOW + 60_000 },
    params: { message: 'stretch', triggerUserId: OWNER },
    display: { label: 'Stretch', category: 'system' },
    deliveryThreadId: 'thread-owner',
    enabled: true,
    createdBy: 'codex-sol',
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

export function createProposal(overrides = {}) {
  return {
    proposalId: 'schedule-create-staged',
    ownerUserId: OWNER,
    requesterCatId: 'codex-sol',
    mutation: { kind: 'create', task: task() },
    status: 'pending',
    publication: { state: 'staged', stagedAt: NOW },
    createdAt: NOW,
    ...overrides,
  };
}

export function deleteProposal(target, overrides = {}) {
  return {
    proposalId: 'schedule-delete',
    ownerUserId: OWNER,
    requesterCatId: 'codex-sol',
    mutation: {
      kind: 'delete',
      taskId: target.id,
      expectedFingerprint: fingerprintDynamicTaskDef(target),
      taskSnapshot: target,
    },
    status: 'pending',
    publication: { state: 'staged', stagedAt: NOW },
    createdAt: NOW,
    ...overrides,
  };
}
