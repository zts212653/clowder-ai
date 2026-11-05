import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ActionSubjectTruthResolver } from '../../dist/domains/ball-custody/ActionSubjectTruthResolver.js';
import { ActionSuccessorAdmissionService } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { RedisActionSuccessorLeaseStore } from '../../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ContextSourceAdmission } from '../../dist/domains/memory/cue/ContextSourceAdmission.js';
import {
  CONTEXT_SOURCE_OPPORTUNITY_SCHEMA,
  ContextSourceOpportunityStore,
} from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

// Actual callback -> ActionSuccessor admission -> QueueProcessor -> source admission.
// Provider behavior is covered separately; this test cannot be satisfied by hand-making a fence.
test(
  'structured Task carrier reaches a fresh external context; plain FYI and terminal Task do not',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F321 queued source admission');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f321-a2a-${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    await redis.ping();
    const leases = new RedisActionSuccessorLeaseStore(redis),
      tasks = new TaskStore();
    const messages = new RedisMessageStore(redis),
      threads = new ThreadStore(),
      queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
    const registry = new InvocationRegistry();
    const thread = threads.create('owner', 'external Task context', '/tmp/f321-isolated-external-project');
    const task = tasks.create({
      userId: 'owner',
      threadId: thread.id,
      title: 'Continue shared reading',
      createdBy: 'owner',
      ownerCatId: 'codex-sol',
      why: 'Continue the approved bounded work.',
    });
    tasks.update(task.id, { status: 'doing' });
    const auth = await registry.create(
      'owner',
      'codex61-sol',
      thread.id,
      undefined,
      undefined,
      undefined,
      undefined,
      'strict',
    );
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(CONTEXT_SOURCE_OPPORTUNITY_SCHEMA);
    const opportunities = new ContextSourceOpportunityStore(db);
    const admission = new ContextSourceAdmission({ messages, threads, tasks, leases, store: opportunities });
    const records = new Map();
    let sequence = 0;
    const invocationRecordStore = {
      async create(input) {
        const id = `queue-${++sequence}`;
        records.set(id, { id, ...input, status: 'queued', createdAt: Date.now() });
        return { outcome: 'created', invocationId: id };
      },
      async get(id) {
        return records.get(id) ?? null;
      },
      async update(id, patch) {
        const current = records.get(id);
        if (!current || (patch.expectedStatus && patch.expectedStatus !== current.status)) return null;
        const { expectedStatus, ...changes } = patch;
        const next = { ...current, ...changes };
        records.set(id, next);
        return next;
      },
    };
    const routed = [];
    async function waitForRoute(count) {
      const deadline = Date.now() + 3000;
      while (routed.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(routed.length, count);
    }
    const router = {
      resolveExplicitTargets: async (cats) => [...cats],
      resolveConversationTargetsAtAdmission: async (cats) => [...cats],
      getExecutions: () => [],
      ackCollectedCursors: async () => {},
      async *routeExecution(owner, content, threadId, sourceMessageId, targets, _intent, options) {
        await options.onLifecycleInvocationStarted({
          threadId,
          userId: owner,
          catId: targets[0],
          invocationId: `child-${sequence}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        const seed = await admission.prepare({
          scope: { ownerUserId: owner, threadId, invocationId: `child-${sequence}` },
          consumerCatId: targets[0],
          exactSourceMessageId: sourceMessageId,
          ownerAuthProvenance: options.ownerAuthProvenance,
          ingress: options.contextSourceIngress,
          now: Date.now(),
          decision: {
            scopeKey: `${owner}::${targets[0]}::${threadId}`,
            contextEpoch: routed.length + 1,
            contextMode: 'cold',
            boundRuntimeSessionId: `native-${sequence}`,
            consumedCompactionEventIds: [],
            lastTransitionRef: `native-${sequence}`,
            transition: 'scope_first_seen',
            normalizedDisposition: {
              state: 'fresh',
              reason: 'no_prior_session',
              evidenceRef: `native-${sequence}`,
              runtimeSessionId: `native-${sequence}`,
            },
          },
        });
        routed.push({ sourceMessageId, ingress: options.contextSourceIngress, seed });
        yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
      },
    };
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    const processor = new QueueProcessor({
      queue,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore,
      messageStore: messages,
      router,
      socketManager,
      actionSuccessorLeaseStore: leases,
      log: { info() {}, warn() {}, error() {} },
    });
    const app = Fastify();
    t.after(() => app.close());
    await app.register(callbacksRoutes, {
      registry,
      messageStore: messages,
      threadStore: threads,
      taskStore: tasks,
      invocationQueue: queue,
      invocationRecordStore,
      router,
      socketManager,
      queueProcessor: { async requestDrain() {}, async onInvocationComplete() {}, async tryAutoExecute() {} },
      actionSuccessorAdmissionService: new ActionSuccessorAdmissionService(
        leases,
        new ActionSubjectTruthResolver(leases, tasks),
      ),
      actionSuccessorLeaseStore: leases,
    });
    async function send(action) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          content: '@codex-sol\n主人带书来了，接着陪这位老搭档共读。',
          targetCats: ['codex-sol'],
          clientMessageId: randomUUID(),
          ...(action ? { action } : {}),
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    }
    const action = {
      subjectRef: `subject:task:${task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'structured_transfer',
      terminalPredicate: { kind: 'task_done' },
    };
    const structured = await send(action);
    assert.equal(structured.actionLease.outcome, 'claimed');
    await processor.processNext(thread.id, 'owner');
    await waitForRoute(1);
    assert.equal(routed[0].sourceMessageId, structured.messageId);
    assert.equal(routed[0].ingress.kind, 'queue_agent');
    assert.equal(routed[0].seed?.kind, 'authorized_task_sources');
    const lease = await leases.get(routed[0].ingress.actionSuccessorFence.leaseId);
    assert.equal(lease.holderThreadId, thread.id);
    const opportunity = opportunities.find(`owner::codex-sol::${thread.id}`, 1, structured.messageId, 'codex-sol');
    assert.ok(
      await admission.validate(
        opportunity.opportunityId,
        { ownerUserId: 'owner', threadId: thread.id, invocationId: 'later' },
        'codex-sol',
        Date.now(),
      ),
    );
    tasks.update(task.id, { status: 'done' });
    assert.equal(
      await admission.validate(
        opportunity.opportunityId,
        { ownerUserId: 'owner', threadId: thread.id, invocationId: 'later' },
        'codex-sol',
        Date.now(),
      ),
      false,
    );
    const plain = await send();
    assert.equal(plain.status, 'ok');
    await processor.processNext(thread.id, 'owner');
    await waitForRoute(2);
    assert.equal(routed[1].sourceMessageId, plain.messageId);
    assert.equal(routed[1].ingress.actionSuccessorFence, undefined);
    assert.equal(routed[1].seed, null);
  },
);
