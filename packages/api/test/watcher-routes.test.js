import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { watcherRoutes } from '../dist/routes/watcher.js';

const USER = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
const headers = { host: 'localhost', origin: 'http://localhost:3171', 'x-fixture-session': USER };
async function fixture() {
  const threads = new ThreadStore(),
    configs = new MemoryConciergeConfigStore(),
    turns = new InMemoryTurnExecutionStore();
  const thread = await threads.create(USER),
    foreign = await threads.create('foreign');
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = request.headers['x-fixture-session'];
  });
  await app.register(watcherRoutes, {
    threadStore: threads,
    configStore: configs,
    turnExecutionStore: turns,
    labelStore: { list: async () => [{ id: 'private', name: '私人', color: '#888' }] },
    capability: (catId) =>
      catId === 'codex' || catId === 'codex61-sol'
        ? { supported: true, mechanism: 'native_revert', maxWorkingContextTokens: 30000, toolPolicy: 'watcher' }
        : { supported: false, reason: 'fixture carrier has no bounded resume' },
    rolloutEnabled: true,
    runtimeReady: () => true,
  });
  return { app, configs, turns, threads, thread, foreign };
}

test('watcher member options distinguish the models that share one nickname', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({ url: '/api/watcher/config', headers });
    assert.equal(response.statusCode, 200);
    const members = response.json().members;
    const siblings = ['opus', 'sonnet', 'opus-45', 'fable-5'].map((catId) => {
      const member = members.find((row) => row.catId === catId);
      assert.ok(member, catId);
      const config = catRegistry.tryGet(catId).config;
      assert.ok(member.displayName.includes(config.variantLabel ?? config.defaultModel), member.displayName);
      assert.ok(member.displayName.includes(config.nickname), member.displayName);
      return member;
    });
    assert.equal(new Set(siblings.map((member) => member.displayName)).size, siblings.length);
    assert.equal(members.find((member) => member.catId === 'sonnet').capability.supported, false);
  } finally {
    await f.app.close();
  }
});

test('watcher settings require the owner session, a local write origin, and real member capability', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/api/watcher/config')).statusCode, 401);
    assert.equal(
      (await f.app.inject({ url: '/api/watcher/config', headers: { 'x-cat-cafe-user': USER } })).statusCode,
      401,
    );
    const start = await f.app.inject({ url: '/api/watcher/config', headers });
    assert.equal(start.json().config.enabled, true);
    assert.deepEqual(start.json().quietLabels, ['private']);
    const write = (payload) => f.app.inject({ method: 'PUT', url: '/api/watcher/config', headers, payload });
    assert.equal((await write({ expectedRevision: 0, memberCatId: 'opus' })).statusCode, 422);
    assert.equal((await write({ expectedRevision: 0, doNotDisturbLabelIds: ['foreign-label'] })).statusCode, 400);
    assert.equal((await write({ expectedRevision: 0, startedAfterSequence: 999 })).statusCode, 400);
    const selected = await write({ expectedRevision: 0, memberCatId: 'codex' });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().config.memberCatId, 'codex');
    assert.equal((await write({ expectedRevision: 0, enabled: false })).statusCode, 409);
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/watcher/config',
          headers: { ...headers, 'x-callback-token': 'even-invalid' },
          payload: { expectedRevision: 1, enabled: false },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/watcher/config',
          headers: { ...headers, origin: 'https://foreign.invalid' },
          payload: { expectedRevision: 1, enabled: false },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.app.close();
  }
});

test('thread controls enforce scope and revision, and a global reopen does not replay an offline interval', async () => {
  const f = await fixture();
  try {
    const url = `/api/threads/${f.thread.id}/watcher`;
    assert.equal((await f.app.inject({ url: `/api/threads/${f.foreign.id}/watcher`, headers })).statusCode, 404);
    const off = await f.app.inject({ method: 'PUT', url, headers, payload: { expectedRevision: 0, enabled: false } });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().enabled, false);
    assert.equal(
      (await f.app.inject({ method: 'PUT', url, headers, payload: { expectedRevision: 0, enabled: true } })).statusCode,
      409,
    );
    await f.app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: { expectedRevision: 0, enabled: false },
    });
    f.turns.createRunning({
      invocationId: 'offline',
      parentInvocationId: 'offline',
      userId: USER,
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'ordinary',
      outputFence: 'open',
      startedAt: 1,
    });
    f.turns.transitionTerminal('offline', { status: 'succeeded', endedAt: 2 });
    f.turns.markResponseSettled('offline', { kind: 'no_response', reason: 'empty_turn', settledAt: 3 });
    const on = await f.app.inject({
      method: 'PUT',
      url: '/api/watcher/config',
      headers,
      payload: { expectedRevision: 1, enabled: true },
    });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().config.startedAfterSequence, f.turns.settledHead(USER));
  } finally {
    await f.app.close();
  }
});

test('daily usage is owner scoped and UTC indexed, and absent cache creation is unknown', async () => {
  const f = await fixture();
  try {
    const at = Date.UTC(2026, 10, 2, 12);
    f.turns.createRunning({
      invocationId: 'watch-day',
      parentInvocationId: 'watch-day',
      userId: USER,
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'watcher',
      outputFence: 'open',
      startedAt: at,
    });
    const usage = { reportedAt: at, inputTokens: 100, outputTokens: 7, cacheReadTokens: 25 };
    f.turns.recordWatcherModelAttempt('watch-day', 'model-1', at, usage);
    f.turns.recordWatcherUsage('watch-day', usage);
    f.turns.transitionTerminal('watch-day', { status: 'succeeded', endedAt: at + 1 });
    f.turns.markResponseSettled('watch-day', { kind: 'no_response', reason: 'tool_only', settledAt: at + 2 });
    const day = await f.app.inject({ url: '/api/watcher/daily?day=2026-11-02', headers });
    assert.equal(day.statusCode, 200, day.body);
    assert.equal(day.json().rows[0].count, 1);
    assert.equal(day.json().rows[0].rewrittenTokens, null);
    assert.equal(day.json().rows[0].outputTokens, 7);
    assert.equal(day.json().rows[0].cacheCreationTokens, null);
    assert.equal((await f.app.inject({ url: '/api/watcher/daily?day=2026-11-03', headers })).json().rows.length, 0);
    assert.equal((await f.app.inject({ url: '/api/watcher/daily?day=2026-02-31', headers })).statusCode, 400);
  } finally {
    await f.app.close();
  }
});

test('daily usage follows the selected local date across UTC midnight and DST', async () => {
  const f = await fixture();
  try {
    const at = Date.parse('2026-11-03T07:30:00Z'); // Nov 2 23:30 after DST ends in Los Angeles.
    f.turns.createRunning({
      invocationId: 'local-day',
      parentInvocationId: 'local-day',
      userId: USER,
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'watcher',
      startedAt: at,
    });
    f.turns.transitionTerminal('local-day', { status: 'succeeded', endedAt: at + 1 });
    f.turns.markResponseSettled('local-day', { kind: 'no_response', reason: 'tool_only', settledAt: at + 2 });
    const local = await f.app.inject({
      url: '/api/watcher/daily?day=2026-11-02&timezone=America%2FLos_Angeles',
      headers,
    });
    assert.equal(local.statusCode, 200, local.body);
    assert.equal(local.json().timezone, 'America/Los_Angeles');
    assert.equal(local.json().rows[0].count, 1);
    const next = await f.app.inject({
      url: '/api/watcher/daily?day=2026-11-03&timezone=America%2FLos_Angeles',
      headers,
    });
    assert.deepEqual(next.json().rows, []);
  } finally {
    await f.app.close();
  }
});

test('one wake spanning midnight counts each actual model attempt on its own day', async () => {
  const f = await fixture();
  try {
    const start = Date.parse('2026-11-02T23:59:00Z'),
      later = start + 120000;
    f.turns.createRunning({
      invocationId: 'cross-day',
      parentInvocationId: 'cross-day',
      userId: USER,
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'watcher',
      startedAt: start,
    });
    f.turns.recordWatcherModelAttempt('cross-day', 'model-1', start, {
      reportedAt: start,
      inputTokens: 10,
      outputTokens: 5,
    });
    f.turns.recordWatcherModelAttempt('cross-day', 'model-2', later, {
      reportedAt: later,
      inputTokens: 20,
      outputTokens: 7,
    });
    f.turns.transitionTerminal('cross-day', { status: 'succeeded', endedAt: later + 1 });
    f.turns.markResponseSettled('cross-day', { kind: 'no_response', reason: 'tool_only', settledAt: later + 2 });
    const first = (await f.app.inject({ url: '/api/watcher/daily?day=2026-11-02', headers })).json().rows[0];
    const next = (await f.app.inject({ url: '/api/watcher/daily?day=2026-11-03', headers })).json().rows[0];
    assert.equal(first.count, 1);
    assert.equal(first.modelAttempts, 1);
    assert.equal(first.outputTokens, 5);
    assert.equal(next.count, 0);
    assert.equal(next.modelAttempts, 1);
    assert.equal(next.outputTokens, 7);
  } finally {
    await f.app.close();
  }
});

test('a wake before midnight with its first model request tomorrow never bills both dates', async () => {
  const f = await fixture();
  try {
    const start = Date.parse('2026-11-02T23:59:59Z'),
      later = start + 2000;
    const usage = { reportedAt: later, inputTokens: 100, outputTokens: 7, cacheReadTokens: 25 };
    f.turns.createRunning({
      invocationId: 'first-request-tomorrow',
      parentInvocationId: 'p-first-request-tomorrow',
      userId: USER,
      threadId: f.thread.id,
      catId: 'codex',
      executionKind: 'watcher',
      startedAt: start,
    });
    f.turns.recordWatcherModelAttempt('first-request-tomorrow', 'model-1', later, usage);
    f.turns.recordWatcherUsage('first-request-tomorrow', usage);
    f.turns.transitionTerminal('first-request-tomorrow', { status: 'succeeded', endedAt: later + 1 });
    f.turns.markResponseSettled('first-request-tomorrow', {
      kind: 'no_response',
      reason: 'tool_only',
      settledAt: later + 2,
    });
    const first = (await f.app.inject({ url: '/api/watcher/daily?day=2026-11-02', headers })).json().rows[0];
    const next = (await f.app.inject({ url: '/api/watcher/daily?day=2026-11-03', headers })).json().rows[0];
    assert.equal(first.count, 1);
    assert.equal(first.modelAttempts, 0);
    assert.equal(first.inputTokens, 0);
    assert.equal(first.outputTokens, 0);
    assert.equal(first.cacheReadTokens, 0);
    assert.equal(next.count, 0);
    assert.equal(next.modelAttempts, 1);
    assert.equal(next.inputTokens, 100);
    assert.equal(next.outputTokens, 7);
    assert.equal(next.cacheReadTokens, 25);
  } finally {
    await f.app.close();
  }
});

test('legacy usage remains readable while an explicit empty request ledger stays known zero', async () => {
  const { watcherDailyRows } = await import('../dist/domains/concierge/watcher/watcher-daily.js');
  const record = {
    invocationId: 'legacy-wake',
    parentInvocationId: 'legacy-parent',
    userId: USER,
    threadId: 'legacy-line',
    catId: 'codex',
    executionKind: 'watcher',
    status: 'succeeded',
    startedAt: 100,
    watcherUsage: { reportedAt: 101, inputTokens: 100, outputTokens: 7, cacheReadTokens: 25 },
  };
  const [legacy] = watcherDailyRows([record]);
  assert.equal(legacy.inputTokens, 100);
  assert.equal(legacy.outputTokens, 7);
  assert.equal(legacy.rewrittenTokens, null);
  const [noRequest] = watcherDailyRows([{ ...record, watcherModelAttempts: {} }]);
  assert.equal(noRequest.modelAttempts, 0);
  assert.equal(noRequest.inputTokens, 0);
  assert.equal(noRequest.outputTokens, 0);
});
