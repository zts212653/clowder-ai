import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { applyDirectWatcherControl } from '../dist/domains/concierge/watcher/watcher-controls.js';
import { createWatcherReceipts } from '../dist/domains/concierge/watcher/watcher-receipts.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function actualOnAdmitted(context) {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  let callback;
  const walk = (node) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'InvocationQueue') {
      const property = node.arguments[1].properties.find((p) => p.name?.getText(source) === 'onAdmitted');
      callback = property.initializer.getText(source);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(callback, 'use the production callback, not a fixture copy');
  return vm.runInNewContext(
    ts.transpileModule(`const handler=${callback}; handler;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}

test('real Queue admission drains work while the actual pause writer is unresolved, and receipts wait for its commit', async () => {
  const threads = new ThreadStore();
  const thread = await threads.create('owner');
  let commit;
  const gate = new Promise((resolve) => {
    commit = resolve;
  });
  let writes = 0,
    drains = 0,
    receipts = 0,
    registrations = 0;
  const update = threads.updateWatcherControl.bind(threads);
  threads.updateWatcherControl = async (...args) => {
    writes++;
    await gate;
    return update(...args);
  };
  const onAdmitted = await actualOnAdmitted({
    applyDirectWatcherControl,
    threadStore: threads,
    queueProcessor: {
      registerCallerDispatchInitialTargets() {
        registrations++;
      },
      async requestDrain() {
        drains++;
      },
    },
    watcherSupervisor: { controlChanged() {} },
    conciergeConfigStoreShared: { readWatcherConfig: async () => ({ memberCatId: 'codex' }) },
    watcherReceipts: {
      async control() {
        receipts++;
      },
    },
    app: { log: { warn() {}, error() {} } },
  });
  const queue = new InvocationQueue(undefined, { onAdmitted });
  try {
    const message = {
      userId: 'owner',
      threadId: thread.id,
      from: { kind: 'user', userId: 'owner' },
      content: '这两小时别烦我',
      timestamp: Date.now(),
      mentions: [],
      deliveryStatus: 'queued',
    };
    const result = await queue.send(new MessageStore(), message, {
      userId: 'owner',
      threadId: thread.id,
      sourceId: 'pause-admission',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: message.content,
      from: message.from,
      targetCats: ['codex'],
      intent: 'execute',
    });
    await setImmediate();
    assert.equal(result.outcome, 'enqueued');
    assert.equal(writes, 1);
    assert.equal(receipts, 0, 'no success receipt before the control commit');
    assert.equal(registrations, 1);
    assert.equal(drains, 1, 'work cannot wait for watcher I/O');
  } finally {
    commit();
    for (let i = 0; i < 8; i++) await setImmediate();
  }
  assert.equal(receipts, 1);
  assert.ok((await threads.get(thread.id)).watcher.pausedUntil > Date.now());
});

test('the actual admission callback selects the thread after its settled head and anchors the original receipt', async () => {
  const w = await watcherWorld();
  const suggestions = createSuggestionIntegration({ messageStore: w.messages });
  const receipts = createWatcherReceipts({ ...w, ...suggestions, changed() {} });
  let drains = 0,
    headReads = 0,
    saved;
  const onAdmitted = await actualOnAdmitted({
    applyDirectWatcherControl,
    threadStore: w.threads,
    turnExecutionStore: {
      settledHead: async (userId, threadId) => {
        assert.equal(userId, 'watcher-owner');
        assert.equal(threadId, w.thread.id);
        headReads++;
        return 17;
      },
    },
    queueProcessor: {
      registerCallerDispatchInitialTargets() {},
      async requestDrain() {
        drains++;
      },
    },
    watcherSupervisor: { controlChanged() {} },
    conciergeConfigStoreShared: { readWatcherConfig: async () => ({ memberCatId: 'codex' }) },
    watcherReceipts: {
      control: async (input) => {
        saved = await receipts.control(input);
      },
    },
    app: { log: { warn() {}, error() {} } },
  });
  const queue = new InvocationQueue(undefined, { onAdmitted });
  const message = {
    userId: 'watcher-owner',
    threadId: w.thread.id,
    from: { kind: 'user', userId: 'watcher-owner' },
    content: '守望这条',
    timestamp: Date.now(),
    mentions: [],
    deliveryStatus: 'queued',
  };
  const result = await queue.send(w.messages, message, {
    userId: message.userId,
    threadId: w.thread.id,
    sourceId: 'open-admission',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: message.content,
    from: message.from,
    targetCats: ['codex'],
    intent: 'execute',
  });
  for (let i = 0; i < 30 && !saved; i++) await setImmediate();
  assert.equal(result.outcome, 'enqueued');
  assert.equal(drains, 1);
  assert.equal(headReads, 1);
  const control = (await w.threads.get(w.thread.id)).watcher;
  assert.equal(control.enabled, true);
  assert.equal(control.startedAfterSequence, 17);
  assert.equal(saved?.ok, true, JSON.stringify(saved));
  assert.equal(saved.value.messageId, control.sourceMessageId);
  assert.equal((await w.messages.getById(saved.value.messageId)).content, '守望这条');
  assert.equal(saved.value.receipt.text, '已开启');
});
