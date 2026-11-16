import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { watcherRoutes } from '../dist/routes/watcher.js';

const USER = 'test-owner';

test('legacy totals crossing midnight stay traceable but never enter either day lower bound', async () => {
  const { watcherDailyRows } = await import('../dist/domains/concierge/watcher/watcher-daily.js');
  const record = {
    invocationId: 'legacy-midnight',
    parentInvocationId: 'old-source',
    userId: USER,
    threadId: 'legacy-line',
    catId: 'codex',
    executionKind: 'watcher',
    status: 'succeeded',
    startedAt: Date.parse('2026-11-12T23:59:00Z'),
    endedAt: Date.parse('2026-11-13T00:02:00Z'),
    watcherUsage: { reportedAt: Date.parse('2026-11-13T00:02:00Z'), inputTokens: 100 },
  };
  const on = (day) => (at) => new Date(at).toISOString().slice(0, 10) === day;
  for (const day of ['2026-11-12', '2026-11-13']) {
    const [row] = watcherDailyRows([record], on(day));
    assert.ok(row, `a cross-day legacy record must not disappear on ${day}`);
    assert.equal(row.knownTotals.inputTokens, null);
    assert.equal(row.inputTokens, null);
    assert.equal(row.unattributedLegacy[0].invocationId, record.invocationId);
    assert.equal(row.unattributedLegacy[0].usages[0].inputTokens, 100);
  }
  const [sameDay] = watcherDailyRows(
    [
      {
        ...record,
        endedAt: record.startedAt + 1000,
        watcherUsage: { ...record.watcherUsage, reportedAt: record.startedAt + 1000 },
      },
    ],
    on('2026-11-12'),
  );
  assert.equal(sameDay.knownTotals.inputTokens, 100);
  assert.equal(sameDay.unattributedLegacy.length, 0);
  const fresh = {
    ...record,
    invocationId: 'known-request',
    watcherModelAttempts: {
      one: { startedAt: record.startedAt, usage: { reportedAt: record.startedAt, inputTokens: 50 } },
    },
  };
  const [mixed] = watcherDailyRows([record, fresh], on('2026-11-12'));
  assert.equal(mixed.knownTotals.inputTokens, 50);
  assert.equal(mixed.modelAttempts, 1);
  assert.equal(mixed.inputTokens, null);
});

test('daily page merge deduplicates executions and pairs cache input with the same reported samples', async () => {
  const { mergeWatcherDailyRows } = await import('@cat-cafe/shared');
  const { watcherDailyRows } = await import('../dist/domains/concierge/watcher/watcher-daily.js');
  const record = {
    invocationId: 'paired',
    parentInvocationId: 'parent',
    userId: USER,
    threadId: 'paired-line',
    catId: 'codex',
    executionKind: 'watcher',
    status: 'succeeded',
    startedAt: 100,
    watcherModelAttempts: {
      inputOnly: { startedAt: 100, usage: { reportedAt: 100, inputTokens: 100 } },
      cacheOnly: { startedAt: 100, usage: { reportedAt: 100, cacheReadTokens: 20 } },
      paired: { startedAt: 100, usage: { reportedAt: 100, inputTokens: 100, cacheReadTokens: 50 } },
    },
  };
  const unknown = { ...record, invocationId: 'unknown', watcherModelAttempts: { missing: { startedAt: 100 } } };
  const first = watcherDailyRows([record, record]);
  const overlap = watcherDailyRows([record, unknown]);
  const [row] = mergeWatcherDailyRows(mergeWatcherDailyRows(first, overlap), overlap);
  assert.equal(row.modelAttempts, 4);
  assert.equal(row.inputTokens, null);
  assert.equal(row.cacheReadTokens, null);
  assert.equal(row.knownTotals.inputTokens, 200);
  assert.equal(row.knownTotals.cacheReadTokens, 70);
  assert.equal(row.coverage.inputTokens, 2);
  assert.equal(row.outputTokens, null);
  assert.equal(row.reportedUsageSamples, 3);
  assert.deepEqual(row.cacheRatio, { inputTokens: 100, cacheReadTokens: 50, samples: 1 });
});

test('a timezone-filtered empty page retains the real settled cursor so the selected day remains reachable', async () => {
  const turns = new InMemoryTurnExecutionStore(),
    threads = new ThreadStore();
  const owner = process.env.DEFAULT_OWNER_USER_ID ?? 'default-user';
  const thread = await threads.create(owner);
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
  });
  await app.register(watcherRoutes, {
    turnExecutionStore: turns,
    threadStore: threads,
    configStore: new MemoryConciergeConfigStore(),
    labelStore: { list: async () => [] },
    capability: () => ({ supported: false, reason: 'no model in test' }),
  });
  try {
    for (let index = 0; index < 201; index++) {
      const at = Date.parse(index < 200 ? '2026-11-13T07:30:00Z' : '2026-11-13T09:00:00Z');
      const id = `page-${index}`;
      turns.createRunning({
        invocationId: id,
        parentInvocationId: id,
        userId: owner,
        threadId: thread.id,
        catId: 'codex',
        executionKind: 'watcher',
        startedAt: at,
      });
      turns.recordWatcherModelAttempt(id, 'request', at, { reportedAt: at, inputTokens: 100 });
      turns.transitionTerminal(id, { status: 'succeeded', endedAt: at + 1 });
      turns.markResponseSettled(id, { kind: 'no_response', reason: 'tool_only', settledAt: at + 2 });
    }
    const headers = { host: 'localhost', origin: 'http://localhost:3171' };
    const url = '/api/watcher/daily?day=2026-11-13&timezone=America%2FLos_Angeles';
    const first = (await app.inject({ url, headers })).json();
    assert.deepEqual(first.rows, []);
    assert.equal(first.hasMore, true);
    const second = (await app.inject({ url: `${url}&cursor=${first.nextCursor}`, headers })).json();
    assert.equal(second.hasMore, false);
    assert.equal(second.rows[0].inputTokens, 100);
    assert.equal(second.rows[0].knownTotals.inputTokens, 100);
  } finally {
    await app.close();
  }
});
