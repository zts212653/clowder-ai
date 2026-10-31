import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('the public overview is project-bound, source-linked, and never converts publication into display', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit();
  const source = f.publish('第一版.md');
  const opened = [];
  const overview = new CompanionWorkOverview({
    ...f.options,
    projectLabel: '小清单',
    open: async (destination) => {
      opened.push(destination);
      return 'unconfirmed';
    },
  });
  const view = await overview.read();
  assert.equal(view.kind, 'work');
  assert.equal(view.v, 1);
  assert.deepEqual(view.scope, { kind: 'current-project', label: '小清单' });
  assert.equal(view.active[0].sourceRef, `task:work:${taskId}`);
  assert.equal(view.active[0].activity, 'waiting');
  assert.equal(view.recentDeliveries[0].sourceRef, `message:${f.thread.id}:${source.id}`);
  assert.equal(view.recentDeliveries[0].artifact, null, 'a publication alone has no unique Artifact-owner lineage');
  assert.equal(view.totalCount, undefined);
  assert.equal(await overview.open('forged'), 'blocked');
  assert.equal(await overview.open(view.recentDeliveries[0].entryRef), 'unconfirmed');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].messageId, source.id);
  assert.equal(opened[0].threadId, f.thread.id);
  assert.equal(opened[0].url, undefined, 'renderer cannot supply a URL/navigation authority');
  overview.reset();
  assert.equal(await overview.open(view.active[0].entryRef), 'blocked');
  const renewed = await overview.read();
  assert.notEqual(
    renewed.active[0].entryRef,
    view.active[0].entryRef,
    'a later read must not revive a revoked navigation capability',
  );
  assert.equal(await overview.open(view.active[0].entryRef), 'blocked');
});

test('issued navigation is re-read and revoked project/source cannot open after a stale click', async (t) => {
  const f = await workFixture(t);
  await f.admit();
  const source = f.publish('成品.md');
  let denied = false;
  const overview = new CompanionWorkOverview({
    ...f.options,
    messages: {
      getByThread: f.messages.getByThread.bind(f.messages),
      getById(id) {
        return denied ? null : f.messages.getById(id);
      },
    },
    open: async () => assert.fail('stale publication cannot reach the navigation owner'),
  });
  const view = await overview.read();
  denied = true;
  assert.equal(await overview.open(view.recentDeliveries[0].entryRef), 'blocked');
  assert.equal(f.messages.getById(source.id).content, '交付 成品.md');
});

test('canonical multiline or long names remain usable in the bounded public card contract', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit('回家\n清单');
  const fileName = `${'长'.repeat(300)}.md`;
  const publication = f.messages.append({
    userId: 'owner',
    threadId: f.thread.id,
    from: { kind: 'agent', catId: 'codex-sol' },
    content: '交付长标题',
    mentions: [],
    timestamp: Date.now(),
    extra: { rich: { v: 1, blocks: [{ kind: 'file', v: 1, id: 'long-name', fileName, url: '/uploads/file.md' }] } },
  });
  const opened = [];
  const overview = new CompanionWorkOverview({
    ...f.options,
    projectLabel: `项目\n${'名'.repeat(200)}`,
    open: async (destination) => {
      opened.push(destination);
      return 'unconfirmed';
    },
  });
  const view = await overview.read();
  assert.equal(view.active[0].title, '回家 清单');
  assert.ok([...view.recentDeliveries[0].title].length <= 280);
  assert.ok([...view.scope.label].length <= 160);
  assert.doesNotMatch(view.scope.label, /[\r\n]/);
  assert.equal(await overview.open(view.recentDeliveries[0].entryRef), 'unconfirmed');
  assert.equal(opened[0].messageId, publication.id);
  assert.equal(f.tasks.get(taskId).title, '回家\n清单');
  assert.equal(f.messages.getById(publication.id).extra.rich.blocks[0].fileName, fileName);
});
