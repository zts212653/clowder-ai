import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { createWatcherReceipts } from '../dist/domains/concierge/watcher/watcher-receipts.js';
import { watcherToolSurface } from '../dist/domains/concierge/watcher/watcher-surface.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';

const { watcherCallbackRoutes } = await import(
  process.env.F335_WATCHER_CALLBACK_RED_MODULE ?? '../dist/routes/watcher-callbacks.js'
);

import { watcherWorld } from './helpers/watcher-world.js';

async function setup(content = 'Original source.') {
  const w = await watcherWorld();
  const [source] = await w.work(content);
  const suggestions = createSuggestionIntegration({ messageStore: w.messages });
  const receipts = createWatcherReceipts({ ...w, ...suggestions, changed() {} });
  const policy = watcherToolSurface({}).policy;
  const auth = await w.registry.create('watcher-owner', 'codex', w.thread.id, 'watcher-parent', undefined, policy);
  await w.executions.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'watcher-parent',
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    executionKind: 'watcher',
    outputFence: 'open',
    startedAt: Date.now(),
  });
  const session = await w.sessions.create({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('watcher-owner', 'codex', w.thread.id),
  });
  await w.sessions.compareAndSetWatcherState(session.id, 0, {
    ...parseWatcherSessionState(undefined),
    revision: 1,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      phase: 'running',
      startedAt: Date.now(),
    },
  });
  let quiet = false;
  const queued = [];
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger, { resolveTargets: async (targets) => targets });
  const app = Fastify();
  await app.register(watcherCallbackRoutes, {
    ...w,
    maySpeak: async () => !quiet,
    afterNudge: (input) => receipts.nudge({ ...input, targetName: '小太阳' }),
    publish() {},
    queue: {
      async enqueueExistingMessageDurable(_store, messageId, input) {
        queued.push({ messageId, input });
        return queue.enqueueExistingMessageDurable(_store, messageId, input);
      },
    },
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  async function nudge(callId, sourceMessageId = source.responseSettlement.messageId) {
    await w.registry.consumeWatcherToolCall(auth.invocationId, callId, 'cat_cafe_watcher_nudge');
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers: { ...headers, 'x-watcher-tool-call-id': callId },
      payload: { sentence: 'A helpful precedent.', sourceMessageId },
    });
  }
  return {
    ...w,
    app,
    auth,
    source,
    suggestions,
    headers,
    queued,
    queue,
    ledger,
    nudge,
    quiet: () => {
      quiet = true;
    },
  };
}

test('a watcher nudge uses one ordinary message and exact target; quiet retries cannot requeue it', async () => {
  const f = await setup();
  try {
    const first = await f.nudge('1');
    assert.equal(first.statusCode, 200, first.body);
    const next = await f.nudge('2');
    assert.equal(next.json().messageId, first.json().messageId);
    const message = await f.messages.getById(first.json().messageId);
    assert.ok(message.content.startsWith('@codex\n'));
    assert.deepEqual(f.queued[0].input.targetCats, ['codex']);
    assert.equal(f.queued[0].input.exactTargets, true);
    assert.equal(
      f.queue.list(f.thread.id, 'watcher-owner').length,
      1,
      'the actual durable Queue must deduplicate the one watcher message',
    );
    f.quiet();
    const quiet = await f.nudge('3');
    assert.equal(quiet.json().delivered, false);
    assert.equal(f.queued.length, 2);
    const foreign = await f.messages.append({
      userId: 'another-user',
      threadId: 'other-thread',
      from: { kind: 'user', userId: 'another-user' },
      content: 'private',
      timestamp: Date.now(),
      mentions: [],
    });
    assert.equal((await f.nudge('4', foreign.id)).statusCode, 403);
  } finally {
    await f.app.close();
  }
});

test('the original @person reply stays delivered and a supplement uses its existing shared receipt row', async () => {
  const f = await setup('@co-creator\n请确定猫的样子。');
  try {
    const original = await f.messages.getById(f.source.responseSettlement.messageId);
    assert.equal(original.mentionsUser, true);
    const result = await f.nudge('after-person');
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(await f.messages.getById(original.id), original);
    const rows = await f.suggestions.service.listThread('watcher-owner', f.thread.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, original.id);
    assert.equal(rows[0].receipt.text, '已向小太阳补了一句');
    assert.equal(rows[0].byline, 'watcher');
  } finally {
    await f.app.close();
  }
});

test('callbacks require an admitted tool ticket and cannot reopen the six-call budget', async () => {
  const f = await setup();
  try {
    const noTicket = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers: f.headers,
      payload: { sentence: 'x', sourceMessageId: f.source.responseSettlement.messageId },
    });
    assert.equal(noTicket.statusCode, 403);
    for (let i = 0; i < 6; i++)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/callbacks/watcher-tool-admission',
            headers: f.headers,
            payload: { toolName: 'cat_cafe_watcher_nudge', callId: `tool-${i}` },
          })
        ).statusCode,
        200,
      );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/callbacks/watcher-tool-admission',
          headers: f.headers,
          payload: { toolName: 'cat_cafe_watcher_nudge', callId: 'tool-7' },
        })
      ).statusCode,
      429,
    );
    assert.equal(f.queued.length, 0);
  } finally {
    await f.app.close();
  }
});

test('a read ticket cannot call a write route and HTTP replay runs no second side effect', async () => {
  const f = await setup();
  try {
    await f.registry.consumeWatcherToolCall(f.auth.invocationId, 'read', 'cat_cafe_get_message');
    const request = {
      method: 'POST',
      url: '/api/callbacks/watcher-nudge',
      headers: { ...f.headers, 'x-watcher-tool-call-id': 'read' },
      payload: { sentence: 'one', sourceMessageId: f.source.responseSettlement.messageId },
    };
    assert.equal((await f.app.inject(request)).statusCode, 403);
    await f.registry.consumeWatcherToolCall(f.auth.invocationId, 'write', 'cat_cafe_watcher_nudge');
    request.headers['x-watcher-tool-call-id'] = 'write';
    const first = await f.app.inject(request);
    assert.equal(first.statusCode, 200, first.body);
    const replay = await f.app.inject(request);
    assert.deepEqual(replay.json(), first.json());
    assert.equal(f.queued.length, 1);
    request.payload.sentence = 'changed request';
    assert.equal((await f.app.inject(request)).statusCode, 403);
  } finally {
    await f.app.close();
  }
});

test('an existing suggestion keeps its action while the same shared row carries the @person supplement', async () => {
  const f = await setup('@co-creator\n请确定猫的样子。');
  try {
    const original = await f.messages.getById(f.source.responseSettlement.messageId);
    f.suggestions.registry.register({
      kind: 'existing_offer',
      kindLabel: '原提议',
      prepare: async () => ({ ok: true, value: {} }),
      apply: async () => ({ ok: true, value: { appliedRef: {}, receipt: { text: 'done' } } }),
      undo: async () => ({ ok: true, value: undefined }),
    });
    const offered = await f.suggestions.service.offer(
      { userId: 'watcher-owner', threadId: f.thread.id, catId: 'codex' },
      { messageId: original.id, label: '原来的动作', action: { kind: 'existing_offer', params: {} } },
    );
    assert.equal(offered.ok, true);
    const result = await f.nudge('after-existing');
    assert.equal(result.json().delivered, true, result.body);
    assert.equal(result.json().receiptAttached, true, result.body);
    const [row] = await f.suggestions.service.listThread('watcher-owner', f.thread.id);
    assert.equal(row.id, offered.value.id);
    assert.equal(row.state, 'open');
    assert.equal(row.watcherSupplement.text, '已向小太阳补了一句');
    assert.deepEqual(await f.messages.getById(original.id), original);
  } finally {
    await f.app.close();
  }
});

test('a busy to idle retry preserves the stopped-target line-start mention after queue admission failed', async () => {
  const f = await setup();
  try {
    await f.executions.createRunning({
      invocationId: 'target-busy',
      parentInvocationId: 'work-parent',
      userId: 'watcher-owner',
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    const enqueue = f.queue.enqueueExistingMessageDurable.bind(f.queue);
    f.queue.enqueueExistingMessageDurable = async () => {
      throw new Error('queue write failed before admission');
    };
    assert.equal((await f.nudge('busy-first')).statusCode, 500);
    await f.executions.transitionTerminal('target-busy', { status: 'succeeded', endedAt: Date.now() });
    f.queue.enqueueExistingMessageDurable = enqueue;
    const retry = await f.nudge('idle-retry');
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await f.messages.getById(retry.json().messageId)).content.startsWith('@codex\n'), true);
    assert.equal(f.queue.list(f.thread.id, 'watcher-owner').length, 1);
  } finally {
    await f.app.close();
  }
});
