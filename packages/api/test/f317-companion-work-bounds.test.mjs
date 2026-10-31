import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.ts';
import { readCompanionWork } from '../src/domains/concierge/live/work/companion-work-read.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('eight desktop cards never request the full owner artifact library or mislabel a bounded window as complete', async (t) => {
  const f = await workFixture(t);
  await f.admit();
  for (let i = 0; i < 80; i++) f.publish(`成品-${i}.md`, 1000 + i);
  const reads = [];
  const messages = {
    getById: f.messages.getById.bind(f.messages),
    getByThread(threadId, limit, userId, options) {
      reads.push({ threadId, limit });
      return f.messages.getByThread(threadId, limit, userId, options);
    },
  };
  const read = await readCompanionWork({ ...f.options, messages });
  assert.deepEqual(reads, [{ threadId: f.thread.id, limit: 33 }]);
  assert.equal(read.deliveries.items.length, 8);
  assert.equal(read.deliveries.totalCount, undefined);
  assert.equal(read.deliveries.hasMore, true);
  const view = await new CompanionWorkOverview(f.options).read();
  assert.equal(view.coverage.find((item) => item.source === 'messages').status, 'partial');
});

test('an exhausted artifact window with no publications is unknown, not proven empty history', async (t) => {
  const f = await workFixture(t);
  for (let i = 0; i < 50; i++)
    f.messages.append({
      userId: 'owner',
      threadId: f.thread.id,
      from: { kind: 'user', userId: 'owner' },
      content: '没有产物的普通聊天',
      mentions: [],
      timestamp: 1000 + i,
    });
  const read = await readCompanionWork(f.options);
  assert.deepEqual(read.deliveries.items, []);
  assert.equal(read.deliveries.totalCount, undefined);
  const view = await new CompanionWorkOverview(f.options).read();
  assert.equal(view.coverage.find((item) => item.source === 'messages').status, 'partial');
});

test('more than sixteen project threads reads the most recently active sixteen and declares partial', async (t) => {
  const f = await workFixture(t);
  f.threads.get(f.thread.id).lastActiveAt = 0;
  for (let i = 1; i <= 17; i++) {
    const thread = f.threads.create('owner', `thread-${i}`, f.options.projectPath);
    f.threads.get(thread.id).lastActiveAt = i;
  }
  const readThreads = [];
  const view = await new CompanionWorkOverview({
    ...f.options,
    messages: {
      getById: f.messages.getById.bind(f.messages),
      getByThread: (threadId, ...args) => {
        readThreads.push(threadId);
        return f.messages.getByThread(threadId, ...args);
      },
    },
  }).read();
  const expected = f.threads
    .listByProject('owner', f.options.projectPath)
    .slice(0, 16)
    .map((thread) => thread.id);
  assert.deepEqual(readThreads, expected);
  assert.equal(view.coverage.find((row) => row.source === 'messages').status, 'partial');
});
