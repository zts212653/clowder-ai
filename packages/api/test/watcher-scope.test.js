import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import {
  applyDirectWatcherControl,
  effectiveWatcherState,
} from '../dist/domains/concierge/watcher/watcher-controls.js';
import { createWatcherReceipts } from '../dist/domains/concierge/watcher/watcher-receipts.js';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';
import { watcherRoutes } from '../dist/routes/watcher.js';
import { watcherWorld } from './helpers/watcher-world.js';

test('new and pre-scope preferences default to selected; explicit all keeps the old inclusion rule', () => {
  for (const raw of [undefined, { enabled: true, memberCatId: 'codex', revision: 7 }]) {
    const config = parseWatcherConfig(raw);
    assert.equal(config.scope, 'selected');
    assert.equal(effectiveWatcherState(config, {}, []).enabled, false);
    assert.equal(effectiveWatcherState(config, { watcher: { revision: 1, enabled: true } }, []).enabled, true);
    assert.equal(
      effectiveWatcherState({ ...config, enabled: false }, { watcher: { revision: 1, enabled: true } }, []).enabled,
      false,
    );
  }
  const all = parseWatcherConfig({ enabled: true, scope: 'all', memberCatId: 'codex', revision: 1 });
  assert.equal(effectiveWatcherState(all, {}, []).enabled, true);
  assert.equal(effectiveWatcherState(all, { watcher: { revision: 1, enabled: false } }, []).enabled, false);
});

test('the real supervisor only dispatches selected threads and starts observing a newly selected thread after its old work', async () => {
  const w = await watcherWorld(),
    configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig('watcher-owner', 0, { memberCatId: 'codex' });
  const selected = await w.threads.create('watcher-owner');
  await w.threads.updateWatcherControl(selected.id, 0, { enabled: true });
  const seen = [];
  const supervisor = new WatcherSupervisor({
    ...w,
    userId: 'watcher-owner',
    configs,
    labels: { list: async () => [] },
    service: () => ({}),
    capability: () => ({ supported: true }),
    report() {},
    run: async (_owners, input) => {
      seen.push(input.source.invocationId);
      throw new Error('fixture has no model');
    },
  });
  const settle = async (id, threadId) => {
    await w.executions.createRunning({
      invocationId: id,
      parentInvocationId: `p-${id}`,
      userId: 'watcher-owner',
      threadId,
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: 1,
    });
    await w.executions.transitionTerminal(id, { status: 'succeeded', endedAt: 2 });
    await w.executions.markResponseSettled(id, { kind: 'no_response', reason: 'empty_turn', settledAt: 3 });
  };
  const poll = async () => {
    await supervisor.poll();
    for (let i = 0; i < 40; i++) await setImmediate();
  };
  await supervisor.start();
  try {
    await settle('unselected-old', w.thread.id);
    await settle('selected-work', selected.id);
    await poll();
    assert.deepEqual(seen, ['selected-work']);
    await applyDirectWatcherControl(
      w.threads,
      { role: 'user', content: '守望这条', threadId: w.thread.id },
      Date.now(),
      async () => w.executions.settledHead('watcher-owner', w.thread.id),
    );
    await settle('newly-selected-work', w.thread.id);
    await poll();
    assert.deepEqual(seen, ['selected-work', 'newly-selected-work']);
  } finally {
    await supervisor.stop();
  }
});

test('the actual settings/thread routes persist the scope and start first selection after existing work', async () => {
  const userId = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  const threads = new ThreadStore(),
    configs = new MemoryConciergeConfigStore(),
    turns = new InMemoryTurnExecutionStore();
  const thread = await threads.create(userId),
    app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = userId;
  });
  await app.register(watcherRoutes, {
    threadStore: threads,
    configStore: configs,
    turnExecutionStore: turns,
    labelStore: { list: async () => [] },
    capability: () => ({ supported: true }),
    rolloutEnabled: true,
  });
  const headers = { host: 'localhost', origin: 'http://localhost:3181' };
  const snapshot = async () => (await app.inject({ url: `/api/threads/${thread.id}/watcher`, headers })).json();
  try {
    assert.equal((await snapshot()).enabled, false);
    turns.createRunning({
      invocationId: 'scope-old',
      parentInvocationId: 'p',
      catId: 'codex',
      userId,
      threadId: thread.id,
      executionKind: 'ordinary',
      startedAt: 1,
    });
    turns.transitionTerminal('scope-old', { status: 'succeeded', endedAt: 2 });
    turns.markResponseSettled('scope-old', { kind: 'no_response', reason: 'empty_turn', settledAt: 3 });
    const all = await app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: { expectedRevision: 0, scope: 'all' },
    });
    assert.equal(all.statusCode, 200, all.body);
    assert.equal((await snapshot()).enabled, true);
    assert.equal(all.json().config.startedAfterSequence, turns.settledHead(userId));
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: { expectedRevision: 1, scope: 'selected' },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal((await snapshot()).enabled, false);
    const enabled = await app.inject({
      method: 'PUT',
      url: `/api/threads/${thread.id}/watcher`,
      headers,
      payload: { expectedRevision: 0, enabled: true },
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().enabled, true);
    assert.equal(enabled.json().control.startedAfterSequence, turns.settledHead(userId, thread.id));
    await app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: { expectedRevision: 2, enabled: false },
    });
    assert.equal((await snapshot()).enabled, false);
  } finally {
    await app.close();
  }
});

test('the user command selects the original thread with a normal receipt and reversible control', async () => {
  const w = await watcherWorld();
  const message = await w.messages.append({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    from: { kind: 'user', userId: 'watcher-owner' },
    content: '守望这条',
    mentions: [],
    timestamp: 100,
  });
  const input = { role: 'user', threadId: w.thread.id, content: message.content, messageId: message.id };
  const changed = await applyDirectWatcherControl(w.threads, input, 100, async () => 17);
  assert.ok(changed);
  assert.equal(changed.current.enabled, true);
  assert.equal(changed.current.startedAfterSequence, 17);
  assert.equal(await applyDirectWatcherControl(w.threads, { ...input, role: 'assistant' }, 100), null);
  assert.equal(await applyDirectWatcherControl(w.threads, { ...input, content: '请举例：“守望这条”' }, 100), null);
  const suggestions = createSuggestionIntegration({ messageStore: w.messages });
  const receipts = createWatcherReceipts({ ...w, ...suggestions, changed() {} });
  const row = await receipts.control({
    userId: 'watcher-owner',
    threadId: w.thread.id,
    catId: 'codex',
    messageId: message.id,
    ...changed,
  });
  assert.equal(row.ok, true);
  assert.equal(row.value.receipt.text, '已开启');
  assert.equal(row.value.messageId, message.id);
  assert.equal((await suggestions.service.undo('watcher-owner', row.value.id, row.value.revision)).ok, true);
  assert.equal((await w.threads.get(w.thread.id)).watcher.enabled, undefined);
});

test('repeating an open command on an already selected thread still records open, while pause remains pause', async () => {
  const w = await watcherWorld();
  await w.threads.updateWatcherControl(w.thread.id, 0, { enabled: true });
  const suggestions = createSuggestionIntegration({ messageStore: w.messages });
  const receipts = createWatcherReceipts({ ...w, ...suggestions, changed() {} });
  for (const [content, expected] of [
    ['守望这条', '已开启'],
    ['这两小时别烦我', '已暂停至'],
  ]) {
    const message = await w.messages.append({
      userId: 'watcher-owner',
      threadId: w.thread.id,
      from: { kind: 'user', userId: 'watcher-owner' },
      content,
      timestamp: Date.now(),
      mentions: [],
    });
    const changed = await applyDirectWatcherControl(
      w.threads,
      { role: 'user', content, threadId: w.thread.id, messageId: message.id },
      message.timestamp,
    );
    const row = await receipts.control({
      userId: 'watcher-owner',
      threadId: w.thread.id,
      catId: 'codex',
      messageId: message.id,
      ...changed,
    });
    assert.equal(row.ok, true);
    assert.ok(row.value.receipt.text.startsWith(expected), row.value.receipt.text);
  }
});
