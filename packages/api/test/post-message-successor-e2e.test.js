/**
 * Same-thread structured successor dogfood: MCP handler -> HTTP callback ->
 * ActionSuccessorAdmissionService seam -> persisted message + fenced queue.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

let app;
let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function actionMetadata(overrides = {}) {
  return {
    subjectRef: 'pr:owner/repo#2915',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: { kind: 'review_delivered', headSha: 'ffffffffffffffffffffffffffffffffffffffff' },
    ...overrides,
  };
}

function activeLease(input) {
  return {
    leaseId: 'lease-e2e-1',
    key: 'user-1|pr:owner/repo#2915|review|reviewer',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#2915',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['codex'],
    generation: 1,
    dispatchId: input.dispatchId,
    evidenceRefs: ['callback:source-invocation:e2e-review-2915'],
    status: 'active',
    holderOutcomes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function createHarness({
  deliveryCursorStore,
  doneTrackingHead,
  livePrSnapshot,
  incomingTerminal = false,
  incomingActiveSubject,
  reviewCarrier = false,
  localReviewVerdictService,
} = {}) {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
  const { ActionSuccessorAdmissionService } = await import(
    '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
  );
  const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
  const { handlePostMessage } = await import('../../mcp-server/dist/tools/callback-tools.js');

  const registry = new InvocationRegistry();
  const invocationQueue = new InvocationQueue();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('user-1', 'MCP successor E2E');
  const ancestorThread = reviewCarrier ? await threadStore.create('user-1', 'Old task ancestor') : undefined;
  const coordinationTrigger = incomingTerminal
    ? await messageStore.append({
        userId: 'user-1',
        catId: 'codex',
        content: 'REQUEST_CHANGES on the prior review generation',
        mentions: ['opus'],
        timestamp: Date.now(),
        threadId: thread.id,
        extra: {
          crossPost: { sourceThreadId: thread.id },
          coordination: { id: 'coord-review-terminal', phase: 'terminal', hop: 2 },
        },
      })
    : incomingActiveSubject
      ? await messageStore.append({
          userId: 'user-1',
          catId: 'codex',
          content: 'An older cross-thread task coordination reached this owner thread',
          mentions: ['opus'],
          timestamp: Date.now(),
          threadId: thread.id,
          extra: {
            crossPost: { sourceThreadId: 'thread-ancestor' },
            coordination: {
              id: 'coord-task-ancestor',
              phase: 'active',
              hop: 4,
              subjectRef: incomingActiveSubject,
            },
          },
        })
      : undefined;
  const auth = await registry.create('user-1', 'opus', thread.id, undefined, coordinationTrigger?.id);
  const admissionCalls = [];
  const terminalPreflightCalls = [];
  const unavailableCalls = [];
  const state = { admit: null };
  const actionSuccessorAdmissionService =
    doneTrackingHead || livePrSnapshot
      ? (() => {
          const leaseStore = {
            async getSubjectTerminal() {
              return null;
            },
            async markSubjectTerminal() {
              throw new Error('terminal marker write is not expected');
            },
            async clearSubjectTerminal() {
              throw new Error('terminal marker clear is not expected');
            },
            async claim(input) {
              admissionCalls.push(input);
              return { outcome: 'claimed', lease: activeLease(input) };
            },
            async get() {
              return null;
            },
            async replace() {
              throw new Error('replace is not expected');
            },
            async commitOutcome() {
              throw new Error('commitOutcome is not expected');
            },
            async returnToPredecessor() {
              throw new Error('returnToPredecessor is not expected');
            },
            async markReturnDelivered() {
              throw new Error('markReturnDelivered is not expected');
            },
            async continueFreshRevision() {
              throw new Error('continueFreshRevision is not expected');
            },
          };
          const resolver = new ActionSubjectTruthResolver(
            leaseStore,
            {
              async get() {
                return null;
              },
            },
            doneTrackingHead
              ? {
                  async getBySubject() {
                    return {
                      kind: 'pr_tracking',
                      status: 'done',
                      headSha: doneTrackingHead,
                      ciPrState: null,
                      reviewPrState: null,
                      closedAt: null,
                    };
                  },
                }
              : undefined,
            undefined,
            undefined,
            livePrSnapshot
              ? {
                  async observe(input) {
                    return { subjectRef: input.subjectRef, ...livePrSnapshot };
                  },
                }
              : undefined,
          );
          return new ActionSuccessorAdmissionService(leaseStore, resolver);
        })()
      : {
          async admit(input) {
            admissionCalls.push(input);
            if (state.admit) return state.admit(input);
            const lease = activeLease(input);
            return {
              admit: true,
              outcome: 'claimed',
              lease,
              fence: { leaseId: lease.leaseId, generation: lease.generation, dispatchId: input.dispatchId },
            };
          },
          async markUnavailable(input) {
            unavailableCalls.push(input);
          },
          async preflightLocalReviewTerminalRoute(input) {
            terminalPreflightCalls.push(input);
            if (input.targetThreadId !== thread.id) {
              return {
                applicable: true,
                allow: false,
                reason: 'target_thread_mismatch',
                expectedThreadId: thread.id,
              };
            }
            return { applicable: true, allow: true, expectedThreadId: thread.id };
          },
        };

  app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    invocationQueue,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    router: {
      async *routeExecution() {},
      getExecutions() {
        return [];
      },
    },
    invocationRecordStore: {
      create() {
        return { outcome: 'created', invocationId: 'child-invocation' };
      },
      update() {},
      get(invocationId) {
        if (!reviewCarrier || invocationId !== auth.invocationId) return null;
        return {
          invocationId,
          threadId: thread.id,
          userId: 'user-1',
          targetCats: ['opus'],
          actionLeaseCarrier: {
            kind: 'action_successor',
            leaseId: 'lease-review-carrier',
            generation: 2,
          },
        };
      },
    },
    queueProcessor: { async tryAutoExecute() {} },
    actionSuccessorAdmissionService,
    ...(localReviewVerdictService ? { localReviewVerdictService } : {}),
    ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
  });

  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.CAT_CAFE_API_URL = apiUrl;
  process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';

  return {
    admissionCalls,
    ancestorThread,
    auth,
    handlePostMessage,
    invocationQueue,
    messageStore,
    state,
    terminalPreflightCalls,
    thread,
    unavailableCalls,
  };
}

function toolJson(result) {
  assert.equal(result.isError, undefined, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text);
}

test('cat_cafe_post_message action traverses the real carrier and queues one fenced successor', async () => {
  const harness = await createHarness();
  const result = await harness.handlePostMessage({
    content: 'Review PR 2915',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-2915',
    action: actionMetadata(),
  });

  toolJson(result);
  assert.equal(harness.admissionCalls.length, 1);
  assert.equal(harness.admissionCalls[0].dispatchId, 'post:e2e-review-2915');
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
  const [queued] = harness.invocationQueue.list(harness.thread.id, 'user-1');
  assert.deepEqual(queued.actionSuccessorFence, {
    leaseId: 'lease-e2e-1',
    generation: 1,
    dispatchId: 'post:e2e-review-2915',
  });
});

test('done-tracking HEAD truth traverses the direct review carrier and queues one fenced successor', async () => {
  const headSha = 'ffffffffffffffffffffffffffffffffffffffff';
  const harness = await createHarness({ doneTrackingHead: headSha });
  const result = await harness.handlePostMessage({
    content: 'Review the server-observed completed-wait HEAD',
    targetCats: ['codex'],
    clientMessageId: 'e2e-done-tracking-review-2915',
    action: actionMetadata({ terminalPredicate: { kind: 'review_delivered', headSha } }),
  });

  assert.equal(toolJson(result).status, 'ok');
  assert.equal(harness.admissionCalls.length, 1);
  const [queued] = harness.invocationQueue.list(harness.thread.id, 'user-1');
  assert.deepEqual(queued.actionSuccessorFence, {
    leaseId: 'lease-e2e-1',
    generation: 1,
    dispatchId: 'post:e2e-done-tracking-review-2915',
  });
});

test('server-observed live HEAD bootstraps the first direct review carrier and queues one fenced successor', async () => {
  const headSha = 'ffffffffffffffffffffffffffffffffffffffff';
  const harness = await createHarness({ livePrSnapshot: { headSha, prState: 'open' } });
  const result = await harness.handlePostMessage({
    content: 'Review the server-observed live HEAD before any projection exists',
    targetCats: ['codex'],
    clientMessageId: 'e2e-live-bootstrap-review-2915',
    action: actionMetadata({ terminalPredicate: { kind: 'review_delivered', headSha } }),
  });

  assert.equal(toolJson(result).status, 'ok');
  assert.equal(harness.admissionCalls.length, 1);
  const [queued] = harness.invocationQueue.list(harness.thread.id, 'user-1');
  assert.deepEqual(queued.actionSuccessorFence, {
    leaseId: 'lease-e2e-1',
    generation: 1,
    dispatchId: 'post:e2e-live-bootstrap-review-2915',
  });
});

test('structured review re-entry opens active coordination after a terminal verdict without caller retry', async () => {
  const harness = await createHarness({ incomingTerminal: true });
  const result = await harness.handlePostMessage({
    content: 'R1 fixes are ready; review the new exact HEAD',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-reentry-2915',
    action: actionMetadata({
      reviewReentry: {
        reason: 'behavioral_delta',
        evidenceRef: 'message:r1-fix-evidence',
      },
    }),
  });

  const body = toolJson(result);
  assert.equal(body.status, 'ok');
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 1);
  const delivered = harness.messageStore
    .getByThreadIncludingQueued(harness.thread.id, 20, 'user-1')
    .find((message) => message.content === 'R1 fixes are ready; review the new exact HEAD');
  assert.ok(delivered);
  assert.equal(delivered.extra.coordination.phase, 'active');
  assert.notEqual(delivered.extra.coordination.id, 'coord-review-terminal');
  assert.equal(delivered.extra.coordination.hop, 0);
});

test('structured review action starts a subject-bound generation instead of inheriting an older task chain', async () => {
  const harness = await createHarness({ incomingActiveSubject: 'subject:task:old-work' });
  const result = await harness.handlePostMessage({
    content: 'Review PR 2915 in this owner thread',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-new-subject-2915',
    action: actionMetadata(),
  });

  const body = toolJson(result);
  assert.equal(body.status, 'ok');
  const delivered = harness.messageStore
    .getByThreadIncludingQueued(harness.thread.id, 20, 'user-1')
    .find((message) => message.content === 'Review PR 2915 in this owner thread');
  assert.ok(delivered);
  assert.equal(delivered.extra.coordination.phase, 'active');
  assert.equal(delivered.extra.coordination.subjectRef, 'pr:owner/repo#2915');
  assert.notEqual(delivered.extra.coordination.id, 'coord-task-ancestor');
  assert.equal(delivered.extra.coordination.hop, 0);
});

test('unfenced owner-thread fallback does not inherit an older cross-thread task coordination', async () => {
  const harness = await createHarness({ incomingActiveSubject: 'subject:task:old-work' });
  const result = await harness.handlePostMessage({
    content: 'Unfenced review fallback stays in this direct carrier',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-unfenced-owner-fallback-2915',
  });

  const body = toolJson(result);
  assert.equal(body.status, 'ok');
  const delivered = harness.messageStore
    .getByThreadIncludingQueued(harness.thread.id, 20, 'user-1')
    .find((message) => message.content === 'Unfenced review fallback stays in this direct carrier');
  assert.ok(delivered);
  assert.equal(delivered.extra.coordination, undefined);
});

test('local review terminal verdict fails before persistence when routed to a task-ancestor thread', async () => {
  const harness = await createHarness({ reviewCarrier: true });
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      threadId: harness.ancestorThread.id,
      content: 'APPROVE PR 2915, but this is the wrong task-ancestor thread',
      targetCats: ['codex'],
      clientMessageId: 'wrong-review-terminal-route',
      coordination: { phase: 'terminal' },
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().kind, 'local_review_terminal_route_mismatch');
  assert.equal(harness.terminalPreflightCalls.length, 1);
  assert.equal(
    harness.messageStore
      .getByThreadIncludingQueued(harness.ancestorThread.id, 20, 'user-1')
      .filter((message) => message.content.includes('APPROVE PR 2915')).length,
    0,
  );
});

test('typed local review terminal post settles once without parsing its human prose', async () => {
  const settlementCalls = [];
  const harness = await createHarness({
    reviewCarrier: true,
    localReviewVerdictService: {
      async record(input) {
        settlementCalls.push(input);
        return {
          outcome: 'committed',
          leaseId: input.leaseId,
          generation: input.generation,
          evidenceRef: `local-review:${input.messageId}:g${input.generation}:changes_requested`,
        };
      },
    },
  });

  const input = {
    content: '我看完了：这里还有一处会丢失授权边界，修好再叫我。',
    targetCats: ['codex'],
    clientMessageId: 'typed-local-review-terminal',
    coordination: { phase: 'terminal' },
    localReviewVerdict: 'changes_requested',
  };
  const result = await harness.handlePostMessage(input);

  const body = toolJson(result);
  assert.equal(body.status, 'ok');
  assert.equal(body.localReviewSettlement.outcome, 'committed');
  assert.equal(settlementCalls.length, 1);
  assert.deepEqual(settlementCalls[0], {
    leaseId: 'lease-review-carrier',
    generation: 2,
    messageId: body.messageId,
    now: settlementCalls[0].now,
    principal: { catId: 'opus', threadId: harness.thread.id, tenantScope: 'user-1' },
  });
  const visible = harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1');
  assert.equal(visible.length, 1, 'the verdict post is the sole reviewer-visible message');
  assert.equal(visible[0].content, '我看完了：这里还有一处会丢失授权边界，修好再叫我。');
  assert.deepEqual(visible[0].extra.localReviewVerdict, {
    verdict: 'changes_requested',
    clientMessageId: 'typed-local-review-terminal',
  });

  const replay = toolJson(await harness.handlePostMessage(input));
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.messageId, body.messageId);
  assert.equal(replay.localReviewSettlement.outcome, 'committed');
  assert.equal(settlementCalls.length, 2, 'replay rechecks the same typed fact through the idempotent lease CAS');
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
});

test('structured successor rejects contradictory terminal coordination before claiming custody', async () => {
  const harness = await createHarness({ incomingTerminal: true });
  const result = await harness.handlePostMessage({
    content: 'This cannot be both successor work and a terminal courtesy reply',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-terminal-conflict-2915',
    coordination: { phase: 'terminal' },
    action: actionMetadata({
      reviewReentry: {
        reason: 'behavioral_delta',
        evidenceRef: 'message:r1-fix-evidence',
      },
    }),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /action_with_terminal_coordination/);
  assert.equal(harness.admissionCalls.length, 0);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);
});

test('structured successor rejects a coordination subject that contradicts its action identity', async () => {
  const harness = await createHarness();
  const result = await harness.handlePostMessage({
    content: 'Do not let a caller bind one review action to another coordination subject',
    targetCats: ['codex'],
    clientMessageId: 'e2e-review-subject-conflict-2915',
    coordination: { phase: 'active', subjectRef: 'pr:owner/repo#9999' },
    action: actionMetadata(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /action_coordination_subject_mismatch/);
  assert.equal(harness.admissionCalls.length, 0);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);
});

test('same-thread safe_wait persists and enqueues nothing', async () => {
  const harness = await createHarness();
  harness.state.admit = (input) => ({ admit: false, outcome: 'safe_wait', lease: activeLease(input) });

  const result = await harness.handlePostMessage({
    content: 'Review PR 2915',
    targetCats: ['codex'],
    clientMessageId: 'e2e-safe-wait-2915',
    action: actionMetadata(),
  });

  assert.equal(toolJson(result).status, 'safe_wait');
  assert.equal(harness.admissionCalls.length, 1);
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 0);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);
});

test('same-thread API independently rejects two holders for mode=single', async () => {
  const harness = await createHarness();
  const response = await app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': harness.auth.invocationId,
      'x-callback-token': harness.auth.callbackToken,
    },
    payload: {
      content: 'Ambiguous single successor',
      targetCats: ['codex', 'gpt52'],
      clientMessageId: 'e2e-two-single-2915',
      action: actionMetadata(),
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().kind, 'action_single_cardinality');
  assert.equal(harness.admissionCalls.length, 0);
});

test('freshness hold runs before admission and produces no successor side effects', async () => {
  let seenCursor;
  const harness = await createHarness({
    deliveryCursorStore: {
      async getSeenCursor() {
        return seenCursor;
      },
    },
  });
  const seen = await harness.messageStore.append({
    userId: 'user-1',
    catId: null,
    content: 'Seen context',
    mentions: [],
    timestamp: 100,
    threadId: harness.thread.id,
  });
  await harness.messageStore.append({
    userId: 'user-1',
    catId: null,
    content: 'New instruction',
    mentions: ['opus'],
    timestamp: 200,
    threadId: harness.thread.id,
  });
  seenCursor = seen.id;

  const result = await harness.handlePostMessage({
    content: 'Stale review handoff',
    targetCats: ['codex'],
    clientMessageId: 'e2e-held-2915',
    action: actionMetadata(),
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /Message NOT sent \(HELD\)/);
  assert.equal(harness.admissionCalls.length, 0);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 0);
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 2);
});

test('same clientMessageId replay does not duplicate the message or fenced queue entry', async () => {
  const harness = await createHarness();
  const input = {
    content: 'Review PR 2915',
    targetCats: ['codex'],
    clientMessageId: 'e2e-replay-2915',
    action: actionMetadata(),
  };

  toolJson(await harness.handlePostMessage(input));
  harness.state.admit = (admissionInput) => ({
    admit: false,
    outcome: 'replayed',
    lease: activeLease(admissionInput),
  });
  const replay = toolJson(await harness.handlePostMessage(input));

  assert.equal(replay.status, 'duplicate');
  assert.equal(harness.admissionCalls.length, 2);
  assert.equal(harness.messageStore.getByThreadIncludingQueued(harness.thread.id, 20, 'user-1').length, 1);
  assert.equal(harness.invocationQueue.list(harness.thread.id, 'user-1').length, 1);
  assert.equal(harness.unavailableCalls.length, 0);
});
