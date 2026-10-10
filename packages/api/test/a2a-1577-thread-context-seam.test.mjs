import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { handleGetThreadContext } from '../../mcp-server/dist/tools/callback-tools.js';
import { withInvocationCredentials } from '../../mcp-server/dist/tools/invocation-auth.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import {
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../src/domains/cats/services/agents/invocation/response-draft-settlement.ts';
import { TurnExecutionStartupReconciler } from '../src/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.ts';
import { LiveCarrierOperationGate } from '../src/domains/concierge/live/LiveCarrierOperationGate.ts';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.ts';
import { deliverConnectorMessage } from '../src/infrastructure/email/deliver-connector-message.ts';
import { callbacksRoutes } from '../src/routes/callbacks.ts';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

// Actual complete callback composition, auth and QueueProcessor/History. Owned
// in-memory storage only: not fresh API dist, Redis, browser or provider evidence.
async function fixture(t, options = {}) {
  const userId = 'isolated-context-owner';
  const threadId = 'isolated-context-thread';
  const catId = 'opus';
  const registry = new InvocationRegistry();
  const parent = await registry.create(userId, catId, threadId);
  const auth = options.live ? await registry.create(userId, catId, threadId, parent.invocationId) : parent;
  const gate = options.live ? new LiveCarrierOperationGate() : undefined;
  const tasks = new TaskStore();
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const executions = new InMemoryTurnExecutionStore();
  const tracker = new InvocationTracker();
  const cursors = new DeliveryCursorStore();
  await executions.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: parent.invocationId,
    userId,
    threadId,
    catId,
    executionKind: 'ordinary',
    ...(options.live ? { queueCompletionPolicy: 'explicit_source' } : {}),
    startedAt: Date.now(),
  });
  tracker.start(threadId, catId, userId, [catId], parent.invocationId);
  const response = appendTestLifecycleResponseSource(messages, {
    userId,
    threadId,
    catId,
    invocationId: auth.invocationId,
    timestamp: Date.now(),
  });
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId,
        targetId: catId,
        invocationId: auth.invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt: Date.now(),
      },
      parent.invocationId,
    ),
    true,
  );
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: messages,
    invocationRecordStore: {},
    router: {},
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    invocationQueue: queue,
    invocationTracker: tracker,
    turnExecutionStore: executions,
    queueProcessor: processor,
    deliveryCursorStore: cursors,
    taskStore: tasks,
    ...(gate ? { withLiveCarrierOperation: (query, consume) => gate.runForCarrier(query, consume) } : {}),
    ...options.callbackOptions,
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
  });
  t.after(() => app.close());
  const read = (args = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?${new URLSearchParams({ responseMode: 'full', ...args })}`,
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
  const publish = (content, extra = {}) =>
    messages.append({
      userId,
      threadId,
      from: { kind: 'user', userId },
      content,
      mentions: [],
      timestamp: Date.now(),
      ...extra,
    });
  const enqueue = (content = 'owned queued context body', extra = {}) =>
    queue.send(
      messages,
      {
        userId,
        threadId,
        from: { kind: 'user', userId },
        content,
        mentions: ['opus', 'codex'],
        deliveryStatus: 'queued',
        timestamp: Date.now(),
      },
      {
        userId,
        threadId,
        from: { kind: 'user', userId },
        content,
        targetCats: ['opus', 'codex'],
        kind: 'conversation_input',
        intent: 'execute',
        ownerAuthProvenance: 'strict',
        authorIntentByCatId: { opus: { requested: 'continue_current', boundParentInvocationId: parent.invocationId } },
        ...extra,
      },
    );
  return {
    app,
    read,
    publish,
    enqueue,
    registry,
    auth,
    parent,
    gate,
    tasks,
    queue,
    messages,
    executions,
    tracker,
    cursors,
    processor,
    response,
    userId,
    threadId,
  };
}

async function pending(f, admitted) {
  const entry = await f.queue.getDurableEntry(f.threadId, admitted.entry.id);
  assert.deepEqual(entry.targets, ['opus', 'codex']);
  assert.equal(entry.status, 'queued');
  assert.equal(f.messages.getById(admitted.message.id).lifecycle?.dispatchRefs?.length ?? 0, 0);
}

// C7: Live isolates admission/close, never grants per-source business completion.
for (const [name, change] of Object.entries({
  'returned child': { invocationId: 'unrelated-child' },
  parent: { parentInvocationId: 'unrelated-parent' },
  tenant: { userId: 'unrelated-owner' },
  thread: { threadId: 'unrelated-thread' },
  target: { catId: 'codex' },
  terminal: { status: 'succeeded' },
})) {
  test(`Live HTTP rejects ${name} before exposing even published content`, async (t) => {
    const f = await fixture(t, { live: true });
    const visible = f.publish('private Live history body');
    const a = await f.enqueue();
    const original = await f.executions.get(f.auth.invocationId);
    f.executions.get = async () => ({ ...original, ...change });
    const result = await f.read();
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.body.includes(visible.content), false);
    assert.equal(result.body.includes(a.message.content), false);
    await pending(f, a);
  });
}

test('known Live child cannot read without its Host operation/close gate', async (t) => {
  const f = await fixture(t, { live: true, callbackOptions: { withLiveCarrierOperation: undefined } });
  const visible = f.publish('Live gate required');
  const a = await f.enqueue();
  const result = await f.read();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.body.includes(visible.content), false);
  await pending(f, a);
});

test('Live full drill does not advertise or invoke a retired disposition service', async (t) => {
  let staleCalls = 0;
  const f = await fixture(t, {
    live: true,
    callbackOptions: {
      holdBallDeps: {
        a2aDispatchDispositionService: {
          describe: async () => {
            staleCalls++;
            return { tool: 'cat_cafe_complete_a2a_dispatch' };
          },
        },
      },
    },
  });
  const source = f.publish('visible exact source');
  const headers = { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken };
  const result = await f.app.inject({
    method: 'GET',
    url: `/api/callbacks/get-message?mode=full&messageId=${source.id}`,
    headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().a2aDispatchDisposition, undefined);
  assert.equal(staleCalls, 0);
  const before = structuredClone(f.messages.getById(source.id));
  const rejected = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/complete-a2a-dispatch',
    headers,
    payload: { messageId: source.id, outcome: 'completed' },
  });
  assert.equal(rejected.statusCode, 404, rejected.body);
  assert.deepEqual(f.messages.getById(source.id), before);
  assert.equal(staleCalls, 0);
});

test('Live close drains admitted exact-child History write, rejects late read, and never finishes business Task', async (t) => {
  const f = await fixture(t, { live: true });
  const task = f.tasks.create({
    userId: f.userId,
    threadId: f.threadId,
    title: 'separate requested work',
    ownerCatId: 'opus',
    createdBy: 'user',
    why: 'delivery is not completion',
  });
  const a = await f.enqueue();
  let entered;
  let release;
  const committing = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const original = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  f.messages.commitLifecycleAppendAdmission = async (...args) => {
    entered();
    await barrier;
    return original(...args);
  };
  const accepted = f.read();
  await committing;
  f.gate.close();
  let drained = false;
  const drain = f.gate.drain().then(() => {
    drained = true;
  });
  const rejected = await f.read();
  assert.equal(rejected.statusCode, 409, rejected.body);
  const drainedBeforeCommit = drained;
  release();
  const result = await accepted;
  await drain;
  assert.equal(drainedBeforeCommit, false, 'accepted read must finish before terminal');
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().messages.some((m) => m.id === a.message.id && m.content === a.message.content));
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(f.tasks.get(task.id).status, 'todo');
  f.executions.transitionTerminal(f.auth.invocationId, { status: 'succeeded', endedAt: Date.now() });
  assert.equal(f.tasks.get(task.id).status, 'todo', 'outer/child terminal is not business completion');
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
});

test('Live History failure restores claim; replay commits only exact target once', async (t) => {
  const f = await fixture(t, { live: true });
  const a = await f.enqueue();
  const original = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History precommit failure');
  };
  assert.equal((await f.read()).statusCode, 503);
  await pending(f, a);
  f.messages.commitLifecycleAppendAdmission = original;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.read({ readIntent: 'history' });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  }
});

test('fresh compiled MCP follows the same Live exact-child delivery, not completion', async (t) => {
  const f = await fixture(t, { live: true });
  const a = await f.enqueue();
  const result = await mcpRead(t, f)({ responseMode: 'full', readIntent: 'history' });
  assert.ok(result.messages.some((m) => m.id === a.message.id));
  assert.equal(result.a2aDispatchDisposition, undefined);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
});

test('actual Host Sessions/Call HTTP and compiled MCP share child gate; native turn and close revoke credentials', async (t) => {
  const sessions = new LiveCompanionSessions();
  const f = await fixture(t, {
    live: true,
    callbackOptions: {
      withLiveCarrierOperation: (query, operation) => sessions.withCarrierOperation(query, operation),
    },
  });
  const a = await f.enqueue();
  const call = await sessions.prepare({
    binding: { userId: f.userId, threadId: f.threadId, catId: 'opus', callId: 'owned-c7-call' },
    messageStore: f.messages,
    mcpDistDir: fileURLToPath(new URL('../../mcp-server/dist/', import.meta.url)),
    allowedDirectories: [fileURLToPath(new URL('./', import.meta.url))],
    verifyNativeBinding: async (id) => id === 'owned-native',
    publish() {},
  });
  t.after(() => sessions.close());
  await sessions.claim(call.id, f.userId, f.threadId, ['opus']);
  const config = await call.configure({
    CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    CAT_CAFE_USER_ID: f.userId,
    CAT_CAFE_THREAD_ID: f.threadId,
    CAT_CAFE_CAT_ID: 'opus',
    CAT_CAFE_INVOCATION_ID: f.auth.invocationId,
    CAT_CAFE_CALLBACK_TOKEN: f.auth.callbackToken,
  });
  const credentials = config.mcp_servers['cat-cafe-collab'].env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
  await call.ready('owned-native', { request: async () => ({}), submitText: async () => 'unused' });
  await call.observe({ method: 'turn/started', params: { threadId: 'owned-native', turn: { id: 'owned-turn' } } });
  assert.equal(JSON.parse(await readFile(credentials, 'utf8')).turns[0].invocationId, f.auth.invocationId);
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().messages.some((m) => m.id === a.message.id));
  assert.ok(
    (await mcpRead(t, f)({ responseMode: 'full', readIntent: 'history' })).messages.some((m) => m.id === a.message.id),
  );
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
  await call.observe({ method: 'turn/completed', params: { threadId: 'owned-native', turn: { id: 'owned-turn' } } });
  assert.deepEqual(JSON.parse(await readFile(credentials, 'utf8')).turns, []);
  await call.stop();
  await assert.rejects(readFile(credentials));
  assert.equal((await f.read()).statusCode, 409);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
});

test('Live committed History survives reply failure and startup; no target resurrection or sibling loss', async (t) => {
  const f = await fixture(t, { live: true });
  const a = await f.enqueue();
  const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  let lostReply = false;
  f.messages.commitLifecycleAppendAdmission = async (...args) => {
    const result = await commit(...args);
    if (!lostReply) {
      lostReply = true;
      throw new Error('owned reply lost after History commit');
    }
    return result;
  };
  const first = await f.read();
  assert.equal(first.statusCode, 503, first.body);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
  assert.deepEqual(
    (await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets,
    ['codex'],
    'committed exact target must not return to pending Queue',
  );
  await f.queue.hydrateFromLedger(f.messages);
  const replay = await f.read({ readIntent: 'history' });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
});

for (const committed of [false, true]) {
  test(`Live uncertain History ${committed ? 'after' : 'before'} commit preserves exact claim until evidence recovers`, async (t) => {
    const f = await fixture(t, { live: true });
    const a = await f.enqueue();
    const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
    const get = f.messages.getById.bind(f.messages);
    let unavailable = false;
    f.messages.commitLifecycleAppendAdmission = async (...args) => {
      if (committed) await commit(...args);
      unavailable = true;
      throw new Error('owned acknowledgement lost with History unavailable');
    };
    f.messages.getById = (id) => {
      if (unavailable) throw new Error('owned History evidence unavailable');
      return get(id);
    };
    assert.equal((await f.read()).statusCode, 503);
    const uncertain = await f.queue.getDurableEntry(f.threadId, a.entry.id);
    assert.equal(uncertain.status, 'claimed', 'unknown commit must not restore executable work');
    assert.deepEqual(uncertain.claimedTargetIds, ['opus']);
    assert.deepEqual(uncertain.targets, ['opus', 'codex']);
    unavailable = false;
    f.messages.commitLifecycleAppendAdmission = commit;
    await f.queue.hydrateFromLedger(f.messages);
    assert.deepEqual(
      (await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets,
      committed ? ['codex'] : ['opus', 'codex'],
    );
    const replay = await f.read({ readIntent: 'history' });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(get(a.message.id).lifecycle.dispatchRefs.length, 1);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  });
}

for (const unknown of [false, true]) {
  test(`Append lost admission reply ${unknown ? 'with unavailable' : 'with readable'} History never requeues committed target or calls provider`, async (t) => {
    const f = await fixture(t);
    const a = await f.enqueue();
    let calls = 0;
    assert.ok(
      f.tracker.bindAgentClientActiveRunDispatcher(f.threadId, 'opus', {
        invocationId: f.auth.invocationId,
        capabilities: { append: true, steer: true },
        handle: { provider: 'anthropic', carrier: 'claude_print_sdk' },
        dispatch: async () => {
          calls += 1;
          return { accepted: true, handle: {} };
        },
      }),
    );
    const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
    const get = f.messages.getById.bind(f.messages);
    let lost = false;
    f.messages.commitLifecycleAppendAdmission = async (...args) => {
      await commit(...args);
      lost = true;
      throw new Error('owned Append admission reply lost');
    };
    f.messages.getById = (id) => {
      if (unknown && lost) throw new Error('owned Append History unavailable');
      return get(id);
    };
    const result = await f.processor.appendExactEntry({
      threadId: f.threadId,
      userId: f.userId,
      entryId: a.entry.id,
      expectedQueueRevision: f.queue.snapshotRevision(f.threadId, f.userId),
      expectedRuns: [{ targetId: 'opus', invocationId: f.auth.invocationId, responseMessageId: f.response.id }],
    });
    assert.equal(lost, true, 'actual admission must be reached');
    assert.equal(result.outcome, 'rejected');
    assert.equal(calls, 0);
    const row = await f.queue.getDurableEntry(f.threadId, a.entry.id);
    if (unknown) {
      assert.equal(row.status, 'claimed');
      assert.deepEqual(row.claimedTargetIds, ['opus']);
      assert.deepEqual(row.targets, ['opus', 'codex']);
    } else {
      assert.deepEqual(row.targets, ['codex']);
      assert.equal(get(a.message.id).lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').phase, 'settled');
    }
    f.messages.getById = get;
    await f.queue.hydrateFromLedger(f.messages);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
    assert.equal(calls, 0);
  });
}

for (const [terminal, unavailable] of [
  ['running', false],
  ['running', true],
  ['succeeded', false],
]) {
  test(`Live canonical restart settles ${terminal} exact response without completing business or replaying delivered target${unavailable ? '; settlement failure retained' : ''}`, async (t) => {
    const f = await fixture(t, { live: true });
    const task = f.tasks.create({
      userId: f.userId,
      threadId: f.threadId,
      title: 'separate business work',
      ownerCatId: 'opus',
      createdBy: 'user',
      why: 'restart delivery is not business completion',
    });
    const a = await f.enqueue();
    assert.equal((await f.read()).statusCode, 200);
    f.gate.close();
    await f.gate.drain();
    const startedAt = f.executions.get(f.auth.invocationId).startedAt;
    if (terminal === 'succeeded')
      f.executions.transitionTerminal(f.auth.invocationId, { status: 'succeeded', endedAt: startedAt + 1 });
    let failSettlement = unavailable;
    const reconciler = new TurnExecutionStartupReconciler({
      store: f.executions,
      now: () => startedAt + 100,
      settleEndedTurnResponse: (turn) => {
        if (failSettlement) throw new Error('owned response settlement unavailable');
        return settleResponseFromDraft(
          { messageStore: f.messages, turnStore: f.executions },
          {
            userId: turn.userId,
            threadId: turn.threadId,
            invocationId: turn.invocationId,
            ...responseOutcomeForEndedTurn(turn),
          },
        );
      },
    });
    const first = await reconciler.reconcile({ processStartedAt: startedAt + 10 });
    assert.equal(first.interruptedCount, terminal === 'running' ? 1 : 0);
    if (unavailable) {
      assert.equal(first.responseSettlementFailures.length, 1);
      assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'processing');
      assert.equal(f.executions.listResponsePending().length, 1);
      assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
      failSettlement = false;
      assert.equal((await reconciler.reconcile({ processStartedAt: startedAt + 10 })).settledResponseCount, 1);
    } else assert.equal(first.settledResponseCount, 1);
    assert.equal(f.messages.getById(f.response.id).lifecycle.status, 'interrupted');
    assert.equal(f.executions.listResponsePending().length, 0);
    const restarted = new InvocationQueue(f.queue.ledgerStore);
    await restarted.hydrateFromLedger(f.messages);
    assert.deepEqual((await restarted.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
    assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
    assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(f.tasks.get(task.id).status, 'todo');
    assert.equal((await f.read()).statusCode, 409);
    assert.equal((await reconciler.reconcile({ processStartedAt: startedAt + 10 })).settledResponseCount, 0);
  });
}

for (const [name, extra] of [
  ['scheduled', { sourceCategory: 'scheduled' }],
  ['wait', { waitContinuationCarrier: { v: 1, waitId: 'live-owned-wait' } }],
  [
    'action',
    { actionSuccessorFence: { leaseId: 'live-owned-action', generation: 1, dispatchId: 'live-action-dispatch' } },
  ],
]) {
  test(`Live read cannot take over ${name} business owner`, async (t) => {
    const f = await fixture(t, { live: true });
    const a = await f.enqueue('separate typed owner body', extra);
    for (const args of [{ readIntent: 'history' }, { readIntent: 'unread' }]) {
      const result = await f.read(args);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.body.includes(a.message.content), false);
      await pending(f, a);
    }
  });
}

test('Live anchor/sparse/cross-thread/unknown child cannot grant exposure or completion', async (t) => {
  const f = await fixture(t, { live: true });
  const a = await f.enqueue();
  for (const args of [{ responseMode: 'anchor' }, { keyword: 'owned' }, { threadId: 'other-thread' }]) {
    const result = await f.read(args);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.body.includes(a.message.content), false);
    await pending(f, a);
  }
  f.executions.get = async () => null;
  const unknown = await f.read();
  assert.equal(unknown.body.includes(a.message.content), false);
  await pending(f, a);
});

function mcpRead(t, f) {
  const originalFetch = globalThis.fetch;
  const originalApi = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'http://127.0.0.1:1');
    assert.equal(target.pathname, '/api/callbacks/thread-context');
    const response = await f.app.inject({
      method: 'GET',
      url: target.pathname + target.search,
      headers: options.headers,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApi === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = originalApi;
  });
  return async (args) => {
    const result = await withInvocationCredentials(f.auth, () => handleGetThreadContext(args));
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
}

test('actual unread HTTP continuation retains its selection while seen moves, without gaps or duplicates', async (t) => {
  const f = await fixture(t);
  const expected = Array.from({ length: 5 }, (_, i) => f.publish(`published ${i}`).id);
  const ids = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const response = await f.read({ readIntent: 'unread', limit: '2', ...(cursor ? { cursor } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    assert.equal(result.contextScope, 'unread_delta');
    ids.push(...result.messages.map((m) => m.id));
    if (!result.hasMore) break;
    assert.ok(result.nextCursor);
    cursor = result.nextCursor;
  }
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, expected.length);
  const empty = (await f.read({ readIntent: 'unread', limit: '2' })).json();
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.hasMore, false);
  const history = (await f.read({ readIntent: 'history', limit: '20' })).json();
  assert.equal(history.contextScope, 'recent_history');
  assert.ok(
    history.messages.some((m) => m.id === expected[0]),
    'unread exhaustion is not history exhaustion',
  );
});

test('actual full HTTP context adopts exact target into History once, not its sibling', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().messages.some((m) => m.content === a.message.content));
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  await f.read();
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs.length, 1);
});

for (const [name, change] of Object.entries({
  'wrong child': { invocationId: 'other-child' },
  'wrong parent': { parentInvocationId: 'other-parent' },
  'wrong tenant': { userId: 'other-owner' },
  'wrong thread': { threadId: 'other-thread' },
  'wrong target': { catId: 'codex' },
  'terminal child': { status: 'succeeded' },
})) {
  test(`HTTP history selection cannot expose queued body with ${name}`, async (t) => {
    const f = await fixture(t);
    const visible = f.publish('published history stays readable');
    const a = await f.enqueue();
    const original = await f.executions.get(f.auth.invocationId);
    f.executions.get = async () => ({ ...original, ...change });
    const result = await f.read();
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.json().messages.some((m) => m.id === visible.id));
    assert.equal(result.body.includes(a.message.content), false);
    await pending(f, a);
  });
}

test('HTTP context needs exact LifecycleActiveRun, not just a live authenticated parent', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  f.tracker.getActiveSlots = () => [];
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.body.includes(a.message.content), false);
  await pending(f, a);
});

test('HTTP context History commit failure is 503 and restores the exact pending claim', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History unavailable');
  };
  const result = await f.read();
  assert.equal(result.statusCode, 503, result.body);
  assert.equal(result.body.includes(a.message.content), false);
  await pending(f, a);
});

test('throwing exact child store is unavailable, not a no-proof success', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  f.executions.get = async () => {
    throw new Error('owned child unavailable');
  };
  assert.equal((await f.read()).statusCode, 503);
  await pending(f, a);
});

test('anchor, sparse and cross-thread reads cannot adopt queued work', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  for (const args of [
    { responseMode: 'anchor' },
    { keyword: 'owned' },
    { catId: 'user' },
    { threadId: 'other-thread' },
  ]) {
    const result = await f.read(args);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.body.includes(a.message.content), false);
    await pending(f, a);
  }
});

test('oversized full-mode anchor is not exposure or seen evidence', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue('oversized owned source '.repeat(5000));
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  const item = result.json().messages.find((m) => m.id === a.message.id);
  assert.ok(item?.oversized);
  assert.equal(item.content, undefined);
  await pending(f, a);
});

for (const [owner, extra] of [
  ['scheduled', { sourceCategory: 'scheduled' }],
  [
    'action',
    {
      actionSuccessorFence: {
        leaseId: 'isolated-context-lease',
        generation: 1,
        dispatchId: 'isolated-context-dispatch',
      },
    },
  ],
  ['wait', { waitContinuationCarrier: { v: 1, waitId: 'isolated-context-wait' } }],
]) {
  test(`${owner} owner body stays fenced from ordinary HTTP context`, async (t) => {
    const f = await fixture(t);
    const a = await f.enqueue(`${owner} owned context body`, extra);
    const result = await f.read();
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.body.includes(a.message.content), false);
    await pending(f, a);
  });
}

test('a declared category without a typed carrier does not invent business authority or a read fence', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue('ordinary declared return', { sourceCategory: 'a2a' });
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().messages.some((m) => m.content === a.message.content));
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
});

test('actual connector delivery preserves an explicit wait carrier before ordinary HTTP read', async (t) => {
  const f = await fixture(t);
  const carrier = {
    v: 1,
    waitId: 'isolated-context-task',
    outcomeId: 'isolated-context-outcome',
    ownerFence: { kind: 'containing_task', generation: 1 },
  };
  const delivery = new PersistedQueueDelivery({
    messages: f.messages,
    queue: f.queue,
    progress: async () => 'owned_deferred_busy',
  });
  const result = await deliverConnectorMessage(
    { delivery },
    {
      threadId: f.threadId,
      userId: f.userId,
      catId: 'opus',
      content: 'typed wait result must stay owned',
      idempotencyKey: 'isolated-context-typed-wait',
      sourceCategory: 'issue',
      waitContinuationCarrier: carrier,
      source: { connector: 'github-wait', label: 'Isolated Wait', meta: { waitContinuationCarrier: carrier } },
    },
  );
  assert.equal(result.admitted, true);
  const queued = f.queue.list(f.threadId, f.userId).find((e) => e.payload.messageId === result.messageId);
  assert.ok(queued);
  const read = await f.read();
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.body.includes('typed wait result must stay owned'), false);
  assert.deepEqual(queued.execution.waitContinuationCarrier, carrier);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, queued.id)).targets, ['opus']);
});

test('HTTP unread rejects sparse arguments and cursor mode/limit changes', async (t) => {
  const f = await fixture(t);
  for (const args of [{ keyword: 'x' }, { catId: 'user' }, { messageId: 'x' }, { before: '1' }]) {
    const result = await f.read({ readIntent: 'unread', ...args });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().code, 'INVALID_UNREAD_CONTEXT_FILTERS');
  }
  for (let i = 0; i < 3; i++) f.publish(`cursor scoped ${i}`);
  const first = (await f.read({ readIntent: 'unread', limit: '1' })).json();
  assert.ok(first.nextCursor);
  for (const args of [
    { readIntent: 'history', limit: '1' },
    { readIntent: 'unread', limit: '2' },
  ]) {
    const result = await f.read({ ...args, cursor: first.nextCursor });
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().code, 'INVALID_THREAD_CONTEXT_CURSOR');
  }
});

test('bounded unread tail pages do not expose or adopt the queued body until the published tail is returned', async (t) => {
  const f = await fixture(t);
  const expected = Array.from({ length: 5 }, (_, i) => f.publish(`tail before queue ${i}`).id);
  const a = await f.enqueue();
  const ids = [];
  let cursor;
  for (let page = 0; page < 5; page++) {
    const result = (await f.read({ readIntent: 'unread', limit: '2', ...(cursor ? { cursor } : {}) })).json();
    ids.push(...result.messages.map((m) => m.id));
    if (page < 2) {
      assert.equal(
        result.messages.some((m) => m.id === a.message.id),
        false,
      );
      await pending(f, a);
    }
    if (!result.hasMore) break;
    cursor = result.nextCursor;
  }
  assert.deepEqual(ids, [...expected, a.message.id]);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
});

test('fresh compiled MCP uses explicit unread pages through the actual authenticated callback composition', async (t) => {
  const f = await fixture(t);
  const expected = Array.from({ length: 5 }, (_, i) => f.publish(`MCP unread ${i}`).id);
  const read = mcpRead(t, f);
  const ids = [];
  let cursor;
  do {
    const result = await read({ readIntent: 'unread', responseMode: 'full', limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(result.contextScope, 'unread_delta');
    ids.push(...result.messages.map((m) => m.id));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, expected);
  assert.deepEqual((await read({ readIntent: 'unread', responseMode: 'full', limit: 2 })).messages, []);
  const history = await read({ responseMode: 'full', limit: 2 });
  assert.equal(history.contextScope, 'recent_history', 'full projection does not implicitly select unread');
  assert.deepEqual(
    history.messages.map((m) => m.id),
    expected.slice(-2),
  );
});

test('fresh compiled MCP full context commits actual exact-child History adoption', async (t) => {
  const f = await fixture(t);
  const a = await f.enqueue();
  const result = await mcpRead(t, f)({ responseMode: 'full' });
  assert.ok(result.messages.some((m) => m.id === a.message.id && m.content === a.message.content));
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, a.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(a.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
});
