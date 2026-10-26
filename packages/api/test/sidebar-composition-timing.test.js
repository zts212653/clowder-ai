import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

const { threadsRoutes } = await import('../dist/routes/threads.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

test('sidebar separates real read/presence intervals and preserves conditional fresh composition', async (t) => {
  let clock = 0;
  const entries = [];
  t.mock.method(performance, 'now', () => clock);
  const threadStore = new ThreadStore();
  const thread = threadStore.create('alice', 'private-title-canary', '/private-path-canary');
  const list = threadStore.list.bind(threadStore);
  t.mock.method(threadStore, 'list', (...args) => {
    clock += 11;
    return list(...args);
  });
  const app = Fastify({
    logger: {
      stream: {
        write(line) {
          entries.push(JSON.parse(line));
        },
      },
    },
  });
  t.after(() => app.close());
  let unreadCalls = 0;
  await app.register(threadsRoutes, {
    threadStore,
    messageStore: {},
    readStateStore: {
      async getUnreadSummaries() {
        unreadCalls++;
        clock += 13;
        return [{ threadId: thread.id, unreadCount: 2, hasUserMention: true }];
      },
    },
    presenceSource: {
      async getPresence() {
        clock += 17;
        return new Map([[thread.id, { status: 'working', cats: ['codex-sol'] }]]);
      },
    },
  });
  const first = await app.inject({
    method: 'GET',
    url: '/api/threads?view=sidebar',
    headers: { 'x-cat-cafe-user': 'alice' },
  });
  assert.equal(first.statusCode, 200);
  const row = JSON.parse(first.body).threads[0];
  assert.equal(row.unreadCount, 2);
  assert.equal(row.presence.status, 'working');
  const second = await app.inject({
    method: 'GET',
    url: '/api/threads?view=sidebar',
    headers: { 'x-cat-cafe-user': 'alice', 'if-none-match': first.headers.etag },
  });
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, '');
  assert.equal(unreadCalls, 2);
  const stages = entries.filter((x) => x.measurement === 'sidebar_snapshot' && x.stage === 'composition');
  assert.equal(stages.length, 2);
  for (const entry of stages) {
    assert.equal(entry.phases?.listMs, 11);
    assert.equal(entry.phases?.unreadReadMs, 13);
    assert.equal(entry.phases?.presenceMs, 17);
    for (const key of ['conciergeMs', 'pathMigrationMs', 'unreadProjectMs', 'dtoProjectMs']) {
      assert.ok(Number.isFinite(entry.phases?.[key]), key);
    }
    assert.doesNotMatch(JSON.stringify(entry), /private-title-canary|private-path-canary/);
  }
});
