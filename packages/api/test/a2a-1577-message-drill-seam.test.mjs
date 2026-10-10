import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { handleGetMessage } from '../../mcp-server/dist/tools/callback-tools.js';
import { withInvocationCredentials } from '../../mcp-server/dist/tools/invocation-auth.js';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.ts';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerCallbackMessageReadRoutes } from '../src/routes/callback-message-read-routes.ts';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

// Production HTTP/auth/QueueProcessor/History, using owned in-memory stores.
// No real provider, account, Redis, browser or complete callback composition claim.
async function fixture(t, extra = {}) {
  const userId = 'isolated-drill-owner';
  const threadId = 'isolated-drill-thread';
  const catId = 'opus';
  const registry = new InvocationRegistry();
  const auth = await registry.create(userId, catId, threadId);
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const executions = new InMemoryTurnExecutionStore();
  await executions.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: auth.invocationId,
    userId,
    threadId,
    catId,
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const admission = await queue.send(
    messages,
    {
      userId,
      from: { kind: 'user', userId },
      content: 'oversized owned queued body '.repeat(3000),
      threadId,
      mentions: ['opus', 'codex'],
      deliveryStatus: 'queued',
      timestamp: Date.now(),
    },
    {
      content: 'oversized owned queued body '.repeat(3000),
      userId,
      threadId,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      from: { kind: 'user', userId },
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      authorIntentByCatId: { opus: { requested: 'continue_current', boundParentInvocationId: auth.invocationId } },
      ...extra,
    },
  );
  const tracker = new InvocationTracker();
  tracker.start(threadId, catId, userId, [catId], auth.invocationId);
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
      auth.invocationId,
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
  registerCallbackAuthHook(app, registry);
  registerCallbackMessageReadRoutes(app, {
    messageStore: messages,
    invocationQueue: queue,
    turnExecutionStore: executions,
    queueProcessor: processor,
  });
  t.after(() => app.close());
  const read = (
    mode = 'full',
    headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
  ) =>
    app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${admission.message.id}&mode=${mode}`,
      headers,
    });
  return { app, auth, queue, messages, executions, tracker, processor, admission, response, read, threadId, userId };
}

async function mcpDrill(t, f, mode = 'full') {
  const fetch = globalThis.fetch;
  const api = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
  globalThis.fetch = async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, 'http://127.0.0.1:1');
    assert.equal(requestUrl.pathname, '/api/callbacks/get-message');
    const injected = await f.app.inject({
      method: 'GET',
      url: requestUrl.pathname + requestUrl.search,
      headers: options.headers,
    });
    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = fetch;
    if (api === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = api;
  });
  return withInvocationCredentials(f.auth, () => handleGetMessage({ messageId: f.admission.message.id, mode }));
}

test('full oversized HTTP drill adopts only this exact child target and preserves its sibling', async (t) => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().message.content, f.admission.message.content);
  assert.equal(result.json().message.truncated, false);
  const source = f.messages.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(source.lifecycle.dispatchRefs[0].targetId, 'opus');
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['codex']);
  const replay = await f.read();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(f.messages.getById(source.id).lifecycle.dispatchRefs.length, 1);
});

test('HTTP preview and missing authentication cannot expose or adopt private queued bytes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read('preview')).statusCode, 404);
  assert.equal((await f.read('full', {})).statusCode, 401);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});

test('HTTP full drill fails closed when the child ledger is absent', async (t) => {
  const f = await fixture(t);
  f.executions.get = async () => null;
  const result = await f.read();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().code, 'TURN_EXECUTION_SCOPE_MISMATCH');
  assert.equal(f.messages.getById(f.admission.message.id).deliveryStatus, 'queued');
});

test('HTTP full drill cannot substitute a live parent for a missing LifecycleActiveRun', async (t) => {
  const f = await fixture(t);
  f.tracker.getActiveSlots = () => [];
  const result = await f.read();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(f.messages.getById(f.admission.message.id).deliveryStatus, 'queued');
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});

test('HTTP History write failure restores the exact claim without acknowledging a body', async (t) => {
  const f = await fixture(t);
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History unavailable');
  };
  const result = await f.read();
  assert.equal(result.statusCode, 503, result.body);
  const pending = await f.queue.getDurableEntry(f.threadId, f.admission.entry.id);
  assert.equal(pending.status, 'queued');
  assert.deepEqual(pending.targets, ['opus', 'codex']);
  assert.equal(f.messages.getById(f.admission.message.id).lifecycle?.dispatchRefs?.length ?? 0, 0);
});

test('ordinary full drill cannot take a scheduled owner body', async (t) => {
  const f = await fixture(t, { sourceCategory: 'scheduled' });
  assert.equal((await f.read()).statusCode, 404);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});

test('HTTP explicit History conflict stays a conflict and restores only this claim', async (t) => {
  const f = await fixture(t);
  f.messages.commitLifecycleAppendAdmission = async () => ({ kind: 'conflict', reason: 'response_lifecycle_conflict' });
  const result = await f.read();
  assert.equal(result.statusCode, 409, result.body);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
  assert.equal(f.messages.getById(f.admission.message.id).lifecycle?.dispatchRefs?.length ?? 0, 0);
});

for (const [name, change] of Object.entries({
  'different invocation': { invocationId: 'other-child' },
  'different parent': { parentInvocationId: 'other-parent' },
  'different tenant': { userId: 'other-owner' },
  'different thread': { threadId: 'other-thread' },
  'different target': { catId: 'codex' },
  'terminal child': { status: 'succeeded' },
})) {
  test(`full HTTP drill refuses ${name} before exposing queued bytes`, async (t) => {
    const f = await fixture(t);
    const original = await f.executions.get(f.auth.invocationId);
    f.executions.get = async () => ({ ...original, ...change });
    const result = await f.read();
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.body.includes('oversized owned queued body'), false);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
  });
}

test('throwing child storage is unavailable, not evidence of a missing child', async (t) => {
  const f = await fixture(t);
  f.executions.get = async () => {
    throw new Error('owned execution store unavailable');
  };
  const result = await f.read();
  assert.equal(result.statusCode, 503, result.body);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});

test('fresh compiled MCP full drill reaches actual authenticated HTTP adoption and preserves sibling responsibility', async (t) => {
  const f = await fixture(t);
  const result = await mcpDrill(t, f);
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(JSON.parse(result.content[0].text).message.content, f.admission.message.content);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(f.admission.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
});

test('fresh compiled MCP preview cannot acknowledge the HTTP queued target', async (t) => {
  const f = await fixture(t);
  const result = await mcpDrill(t, f, 'preview');
  assert.equal(result.isError, true);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});

test('fresh compiled MCP preserves the HTTP child-ledger rejection as an error', async (t) => {
  const f = await fixture(t);
  f.executions.get = async () => null;
  const result = await mcpDrill(t, f);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /409/);
  assert.equal(result.content[0].text.includes('oversized owned queued body'), false);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, f.admission.entry.id)).targets, ['opus', 'codex']);
});
