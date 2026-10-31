import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('an issued Task reference survives progress and list displacement while its current owner remains authoritative', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit();
  const opened = [];
  const overview = new CompanionWorkOverview({
    ...f.options,
    open: async (destination) => {
      opened.push(destination);
      return 'unconfirmed';
    },
  });
  const view = await overview.read();
  await f.lifecycle.update({
    taskId,
    expectedRevision: 1,
    progress: { summary: '完成第一步', sourceRef: 'message:progress' },
  });
  assert.equal(await overview.open(view.active[0].entryRef), 'unconfirmed');
  assert.equal((await overview.read()).active[0].entryRef, view.active[0].entryRef);
  let updatedAt = f.tasks.get(taskId).updatedAt;
  t.mock.method(Date, 'now', () => ++updatedAt);
  for (let i = 0; i < 10; i++) await f.admit(`new-work-${i}`);
  assert.ok(!(await overview.read()).active.some((row) => row.taskId === taskId));
  assert.equal(await overview.open(view.active[0].entryRef), 'unconfirmed');
  assert.deepEqual(opened[1], { threadId: f.thread.id, taskId, sourceRef: `task:work:${taskId}` });
  f.tasks.get(taskId).userId = 'other-owner';
  assert.equal(await overview.open(view.active[0].entryRef), 'blocked');
});

test('an issued publication remains openable beyond the recent window, but recall still revokes it', async (t) => {
  const f = await workFixture(t);
  const source = f.publish('原作品.md', 1000);
  const opened = [];
  const overview = new CompanionWorkOverview({
    ...f.options,
    open: async (destination) => {
      opened.push(destination);
      return 'queued';
    },
  });
  const ref = (await overview.read()).recentDeliveries[0].entryRef;
  for (let i = 0; i < 40; i++) f.publish(`later-${i}.md`, 2000 + i);
  assert.ok(!(await overview.read()).recentDeliveries.some((row) => row.sourceRef.endsWith(source.id)));
  assert.equal(await overview.open(ref), 'queued');
  assert.equal(opened[0].messageId, source.id);
  assert.deepEqual(opened[0].item, { kind: 'rich-file', blockId: '原作品.md' });
  source.recall = { recalledAt: Date.now(), recalledBy: 'owner' };
  assert.equal(await overview.open(ref), 'blocked');
});

for (const operation of ['read', 'open'])
  test(`reset fences an in-flight ${operation} without issuing or using navigation`, async (t) => {
    const f = await workFixture(t);
    await f.admit();
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let pause = false,
      navigations = 0;
    const overview = new CompanionWorkOverview({
      ...f.options,
      assertCurrent: async () => {
        if (pause) {
          entered.resolve();
          await release.promise;
        }
      },
      open: async () => {
        navigations++;
        return 'applied';
      },
    });
    const old = (await overview.read()).active[0].entryRef;
    pause = true;
    const pending = operation === 'read' ? overview.read() : overview.open(old);
    await entered.promise;
    overview.reset();
    release.resolve();
    if (operation === 'read') await assert.rejects(pending, /unavailable/);
    else assert.equal(await pending.catch((error) => error.code), 'blocked');
    assert.equal(navigations, 0);
    assert.equal(await overview.open(old), 'blocked');
  });
