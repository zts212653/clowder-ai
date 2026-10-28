import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { ActionSubjectTruthResolver } from '../../dist/domains/ball-custody/ActionSubjectTruthResolver.js';
import { ActionSuccessorAdmissionService } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { OrdinaryTaskHandoffService } from '../../dist/domains/ball-custody/OrdinaryTaskHandoffService.js';
import { createTaskApprovedDelegateProvider } from '../../dist/domains/ball-custody/ProposalStoreDelegateProvider.js';
import { RedisActionSuccessorLeaseStore } from '../../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisInvocationRecordStore } from '../../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisProposalStore } from '../../dist/domains/cats/services/stores/redis/RedisProposalStore.js';
import { RedisTaskStore } from '../../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { proposalRoutes } from '../../dist/routes/proposal-routes.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from './redis-test-helpers.js';

export const USER = 'approval-contract-user';
export const OWNER = 'codex';
export const TARGET = 'codex-sol';

export async function approvedTaskFixture(t, { legacy = true, governed = false } = {}) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'approved Task contract journey');
  const redis = new Redis(process.env.REDIS_URL, { keyPrefix: `approved-task-${randomUUID()}:` });
  const proposals = new RedisProposalStore(redis);
  const tasks = new RedisTaskStore(redis);
  const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
  const messages = new RedisMessageStore(redis);
  const turns = new RedisTurnExecutionStore(redis);
  const registry = new InvocationRegistry();
  const queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
  const leases = new RedisActionSuccessorLeaseStore(redis);
  const delegates = createTaskApprovedDelegateProvider(proposals, threads);
  const resolver = new ActionSubjectTruthResolver(
    leases,
    {
      async get(id) {
        const task = await tasks.get(id);
        return task ? { ...task, developmentScope: task.entrustedWork?.developmentScope } : null;
      },
    },
    delegates,
  );
  const admission = new ActionSuccessorAdmissionService(leases, resolver);
  const handoffs = new OrdinaryTaskHandoffService({ tasks, messages, threads, turns, delegates });
  const sockets = { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  await app.register(callbacksRoutes, {
    registry,
    ordinaryTaskHandoffs: handoffs,
    turnExecutionStore: turns,
    messageStore: messages,
    taskStore: tasks,
    threadStore: threads,
    proposalStore: proposals,
    socketManager: sockets,
    invocationQueue: queue,
    invocationRecordStore: new RedisInvocationRecordStore(redis),
    // The actual queue and fence are exercised; no model or external agent is started in this isolated fixture.
    router: {
      async *routeExecution() {},
      getExecutions() {
        return [];
      },
    },
    queueProcessor: { async tryAutoExecute() {} },
    actionSuccessorAdmissionService: admission,
    actionSuccessorLeaseStore: leases,
  });
  await app.register(proposalRoutes, {
    proposalStore: proposals,
    threadStore: threads,
    messageStore: messages,
    socketManager: sockets,
  });
  const source = await threads.create(USER, 'Original Task owner', process.cwd());
  const task = await tasks.create({
    threadId: source.id,
    title: 'Repair approved A/B/C',
    ownerCatId: OWNER,
    createdBy: 'user',
    userId: USER,
    why: 'Original accepted work',
    ...(governed ? { subjectKey: 'eval-case:kept-approved-task-contract' } : {}),
  });
  const origin = await messages.append({
    userId: USER,
    from: { kind: 'user', userId: USER },
    content: 'Carry out the already agreed A/B/C repair in the approved child.',
    threadId: source.id,
    mentions: [],
    timestamp: Date.now(),
  });
  const auth = await registry.create(USER, OWNER, source.id, undefined, origin.id);
  await turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: auth.invocationId,
    userId: USER,
    catId: OWNER,
    threadId: source.id,
    executionKind: 'ordinary',
    startedAt: Date.now(),
    causal: { triggerMessageId: origin.id },
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const proposed = await app.inject({
    method: 'POST',
    url: '/api/callbacks/propose-thread',
    headers,
    payload: {
      title: 'Approved implementation',
      reason: 'Complete the original A/B/C task',
      subjectTaskId: task.id,
      preferredCats: [TARGET],
      initialMessage: 'Implement A/B/C and return tested code. Preserve the original Task.',
      reportingMode: 'final-only',
      declaredWorkMode: 'parallel',
    },
  });
  assert.equal(proposed.statusCode, 200, proposed.body);
  const proposalId = proposed.json().proposalId;
  const approved = await app.inject({
    method: 'POST',
    url: `/api/proposals/${proposalId}/approve`,
    headers: { 'x-cat-cafe-user': USER },
    payload: {},
  });
  assert.equal(approved.statusCode, 200, approved.body);
  const childId = approved.json().threadId;
  if (legacy) await redis.hdel(`proposal:${proposalId}`, 'approvedTaskContract');
  await messages.append({
    userId: USER,
    from: { kind: 'agent', catId: TARGET },
    threadId: childId,
    content: 'READY. Read-only investigation completed; no implementation lease yet.',
    mentions: [],
    timestamp: Date.now(),
  });
  const input = { proposalId, taskId: task.id, clientRequestId: 'original-approved-contract' };
  const continueTask = (overrides = {}, authHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/continue-approved-task',
      headers: authHeaders,
      payload: { ...input, ...overrides },
    });
  const implement = (overrides = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        threadId: childId,
        content: 'Implement the exact approved A/B/C contract.',
        targetCats: [TARGET],
        clientMessageId: 'one-implement-carrier',
        action: {
          subjectRef: `subject:task:${task.id}`,
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          claimOrigin: 'structured_transfer',
          groundingEvidenceRef: `message:${origin.id}`,
          terminalPredicate: { kind: 'task_done' },
        },
        ...overrides,
      },
    });
  return {
    app,
    redis,
    proposals,
    tasks,
    threads,
    messages,
    registry,
    queue,
    leases,
    delegates,
    handoffs,
    turns,
    resolver,
    admission,
    source,
    task,
    proposalId,
    childId,
    input,
    headers,
    continueTask,
    implement,
  };
}
