import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionBridgeError } from '../src/domains/concierge/live/companion-owner-client.ts';
import { readCompanionWork } from '../src/domains/concierge/live/work/companion-work-read.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('the companion reads current entrusted work and published deliveries from canonical owner stores', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit();
  await f.admit('foreign work', 'other-owner');
  const publication = f.publish('回家清单-v1.md');
  await f.lifecycle.update({
    taskId,
    expectedRevision: 1,
    status: 'doing',
    artifactRefs: ['/uploads/回家清单-v1.md'],
    progress: { summary: '第一版已交付，等修改', sourceRef: `message:${publication.id}` },
  });
  const before = structuredClone(f.tasks.get(taskId));
  const view = await readCompanionWork(f.options);
  assert.equal(view.status, 'available');
  assert.equal(view.work.coverage, 'current_project_active_entrusted_work');
  assert.equal(view.work.items.length, 1);
  assert.equal(view.work.items[0].taskId, taskId);
  assert.equal(view.work.items[0].revision, 2);
  assert.equal(view.work.items[0].status, 'doing');
  assert.equal(view.work.items[0].progress.summary, '第一版已交付，等修改');
  assert.deepEqual(view.work.items[0].source, { threadId: f.thread.id, taskId });
  assert.equal(view.deliveries.items[0].source.messageId, publication.id);
  assert.equal(view.deliveries.items[0].source.threadId, f.thread.id);
  assert.equal(view.deliveries.items[0].display, 'unknown');
  assert.equal(view.deliveries.items[0].version, undefined, 'a publication date or file name is not an owner version');
  assert.deepEqual(f.tasks.get(taskId), before, 'reading never updates or completes the work');
});

test('the Host project, current Task revision and live source record fence the desktop projection', async (t) => {
  const f = await workFixture(t);
  const id = await f.admit();
  const publication = f.publish('原版本.md');
  const other = f.threads.create('owner', '另一项目', '/synthetic/other');
  f.messages.append({
    userId: 'owner',
    threadId: other.id,
    from: { kind: 'agent', catId: 'codex-sol' },
    content: '别的项目',
    mentions: [],
    timestamp: Date.now(),
    extra: {
      rich: {
        v: 1,
        blocks: [{ kind: 'file', v: 1, id: 'foreign', fileName: '另一项目.md', url: '/uploads/other.md' }],
      },
    },
  });
  const view = await readCompanionWork(f.options);
  assert.deepEqual(
    view.deliveries.items.map((row) => row.source.messageId),
    [publication.id],
  );
  assert.equal(view.work.items[0].updatedAt, f.tasks.get(id).updatedAt);
  const drifted = await readCompanionWork({
    ...f.options,
    tasks: {
      listByThread: f.tasks.listByThread.bind(f.tasks),
      async get(taskId) {
        const task = structuredClone(f.tasks.get(taskId));
        task.entrustedWork.revision += 1;
        return task;
      },
    },
  });
  assert.equal(drifted.work.status, 'unavailable');
  assert.equal(drifted.work.totalCount, undefined);
});

test('owner failures retain independent source coverage without inventing zero totals', async (t) => {
  const f = await workFixture(t);
  f.publish('已保存.md');
  const view = await readCompanionWork({
    ...f.options,
    tasks: {
      get: f.tasks.get.bind(f.tasks),
      async listByThread() {
        throw new Error('Task owner read unavailable');
      },
    },
  });
  assert.equal(view.status, 'partial');
  assert.equal(view.work.status, 'unavailable');
  assert.equal(view.work.totalCount, undefined);
  assert.equal(view.work.hasMore, undefined);
  assert.equal(view.deliveries.items.length, 1);
});

test('reentry rereads progress and bounds lists without treating a page as all owner history', async (t) => {
  const f = await workFixture(t);
  const id = await f.admit();
  for (let i = 0; i < 23; i++) f.publish(`成品-${i}.md`, 1000 + i);
  const first = await readCompanionWork({ ...f.options, limit: 5 });
  assert.equal(first.deliveries.items.length, 5);
  assert.equal(first.deliveries.totalCount, 23);
  assert.equal(first.deliveries.hasMore, true);
  await f.lifecycle.update({
    taskId: id,
    expectedRevision: 1,
    status: 'doing',
    progress: { summary: '已按新要求加入雨伞', sourceRef: 'message:changed-requirement' },
  });
  const reopened = await readCompanionWork(f.options);
  assert.equal(reopened.work.items[0].taskId, id);
  assert.equal(reopened.work.items[0].progress.summary, '已按新要求加入雨伞');
  assert.equal(first.work.items[0].status, 'todo');
});

test('a revoked Host and a foreign owner response fail closed after asynchronous reads', async (t) => {
  const f = await workFixture(t);
  await f.admit();
  let checks = 0;
  await assert.rejects(
    readCompanionWork({
      ...f.options,
      assertCurrent: async () => {
        if (++checks > 1) throw new CompanionBridgeError('permission_required');
      },
    }),
    /permission_required/,
  );
  const view = await readCompanionWork({
    ...f.options,
    tasks: {
      listByThread: f.tasks.listByThread.bind(f.tasks),
      get(id) {
        return { ...f.tasks.get(id), userId: 'other-owner' };
      },
    },
  });
  assert.equal(view.work.status, 'unavailable');
  assert.deepEqual(view.work.items, []);
});

test('a recalled publication or a project move during the read cannot escape through cached catalogue data', async (t) => {
  const f = await workFixture(t);
  const publication = f.publish('随后撤回.md');
  const recalled = await readCompanionWork({
    ...f.options,
    messages: {
      getByThread: f.messages.getByThread.bind(f.messages),
      async getById(id) {
        return { ...f.messages.getById(id), recall: { recalledAt: Date.now(), recalledBy: 'owner' } };
      },
    },
  });
  assert.deepEqual(recalled.deliveries.items, []);
  let reads = 0;
  const moved = await readCompanionWork({
    ...f.options,
    threads: {
      async listByProject(...args) {
        return ++reads === 1 ? f.threads.listByProject(...args) : [];
      },
    },
  });
  assert.deepEqual(moved.deliveries.items, []);
  assert.ok(f.messages.getById(publication.id));
});
