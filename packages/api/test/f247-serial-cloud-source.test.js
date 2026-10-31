import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const humanContent = '你身为布偶猫怎么看缅因猫？';
const catContent = '@gpt-pro\n我是本地布偶猫，请收到后回一声喵。';

async function dispatch({
  initialProvenance = false,
  missingCatSource = false,
  catSourceOverrides,
  directCloud = false,
} = {}) {
  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
  const initialTarget = directCloud ? 'gpt-pro' : 'opus';
  const admitted = await queue.send(
    messageStore,
    {
      userId: 'alice',
      from: { kind: 'user', userId: 'alice' },
      threadId: 'serial-cloud',
      content: humanContent,
      mentions: [initialTarget],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      userId: 'alice',
      threadId: 'serial-cloud',
      from: { kind: 'user', userId: 'alice' },
      content: humanContent,
      targetCats: [initialTarget],
      kind: 'conversation_input',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    },
  );
  const source = admitted.message;
  const lookup = messageStore.getById.bind(messageStore);
  let checkingCloudSource = false;
  let catSourceReads = 0;
  messageStore.getById = (id) => {
    const value = lookup(id);
    if (!checkingCloudSource || value?.catId !== 'opus') return value;
    catSourceReads++;
    return missingCatSource ? null : { ...value, ...catSourceOverrides };
  };
  const calls = [];
  const grants = [];
  const routes = [];
  const errors = [];
  const service = {
    async *invoke() {
      yield { type: 'text', catId: 'opus', content: catContent, timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { opus: service, 'gpt-pro': { usesChainKeyResume: () => false } },
    messageStore,
    invocationDeps: {
      messageStore,
      registry: new InvocationRegistry(),
      turnExecutionStore: turns,
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:0',
      cloudReturnGrantStore: {
        issue: async (grant) => {
          grants.push(grant);
          return { ok: true };
        },
      },
      cloudInvokeBridge: {
        dispatch: async (params) => {
          calls.push(params);
          return {
            kind: 'sent',
            transport: 'host',
            hostMessageId: 'host-source',
            capturedUrl: 'https://chatgpt.com/c/test',
          };
        },
      },
    },
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    invocationRecordStore: records,
    turnExecutionStore: turns,
    messageStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    log: { info() {}, warn() {}, error: (...args) => errors.push(args) },
    router: {
      resolveExplicitTargets: async (targets) => [...targets],
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      ackCollectedCursors: async () => {},
      async *routeExecution(userId, content, threadId, messageId, targets, _intent, options) {
        routes.push({ messageId, targets });
        yield* routeSerial(deps, targets, content, userId, threadId, {
          ...options,
          currentUserMessageId: messageId,
          ...(initialProvenance && messageId === source.id
            ? {
                cloudDispatchProvenance: {
                  sourceMessageId: source.id,
                  sourceSender: { kind: 'user', id: 'alice' },
                  calledByCatId: 'alice',
                  intent: humanContent,
                },
              }
            : {}),
        });
      },
    },
  });
  // Hold only the scheduler signal so each real Queue admission can be
  // observed before processing the next carrier. No inline member handoff.
  const drains = [];
  processor.requestDrain = async (threadId) => drains.push(threadId);
  assert.equal((await processor.processNext('serial-cloud', 'alice')).started, true);
  const deadline = Date.now() + 5000;
  while (tracker.has('serial-cloud')) {
    if (Date.now() > deadline) assert.fail(`source execution did not finish: ${JSON.stringify(errors)}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const catSource = messageStore.getByThread('serial-cloud').find((message) => message.catId === 'opus');
  if (!directCloud) {
    assert.equal(catSource?.lifecycle.status, 'completed', JSON.stringify(errors));
    const next = queue.list('serial-cloud', 'alice');
    assert.equal(next.length, 1, 'a completed response must atomically admit its one cloud wake');
    assert.equal(next[0].payload.sourceRecordId, catSource.id);
    assert.ok(drains.includes('serial-cloud'));
    checkingCloudSource = true;
    await processor.processNext('serial-cloud', 'alice');
    while (tracker.has('serial-cloud')) {
      if (Date.now() > deadline) assert.fail(`cloud execution did not finish: ${JSON.stringify(errors)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(catSourceReads > 0, 'negative source tests must reach the persisted cat source');
    if (!missingCatSource && !catSourceOverrides) {
      assert.equal(routes.length, 2);
      assert.equal(routes[1].messageId, catSource.id);
    }
  }
  return {
    calls,
    grants,
    humanSource: source,
    catSource,
  };
}

for (const initialProvenance of [false, true]) {
  test(`serial cat-to-cloud handoff uses the cat's exact body/sender/source (initial provenance=${initialProvenance})`, async () => {
    const { calls, grants, catSource } = await dispatch({ initialProvenance });
    assert.ok(catSource);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sourceMessageId, catSource.id);
    assert.equal(calls[0].calledBy, 'opus');
    assert.equal(calls[0].intent, catContent);
    assert.equal(grants[0].sourceMessageId, catSource.id);
  });
}

test('a missing persisted cat source never falls back to the prior human body', async () => {
  const { calls, grants } = await dispatch({ missingCatSource: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(grants, []);
});

for (const catSourceOverrides of [
  { deletedAt: 1 },
  { _tombstone: true },
  { threadId: 'foreign' },
  { userId: 'other-owner' },
  { from: { kind: 'agent', catId: 'codex' }, catId: 'codex' },
]) {
  test(`an invalid cat handoff cannot mint a cloud return grant: ${JSON.stringify(catSourceOverrides)}`, async () => {
    const { calls, grants } = await dispatch({ catSourceOverrides });
    assert.deepEqual(calls, []);
    assert.deepEqual(grants, []);
  });
}

for (const initialProvenance of [false, true]) {
  test(`direct human-to-cloud dispatch retains its own source (initial provenance=${initialProvenance})`, async () => {
    const { calls, grants, humanSource } = await dispatch({ directCloud: true, initialProvenance });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].calledBy, 'alice');
    assert.equal(calls[0].intent, humanContent);
    assert.equal(calls[0].sourceMessageId, humanSource.id);
    assert.equal(grants[0].sourceMessageId, humanSource.id);
  });
}
