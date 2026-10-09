import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createThreadDeepLinkUrl } from '../dist/config/frontend-origin.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginThreadHost } from '../dist/domains/plugin/host-surface/plugin-thread-host.js';
import { MemoryConnectorThreadBindingStore } from '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js';

function fixture(grants = ['thread.listMetadata', 'thread.readContent', 'thread.write']) {
  const threadStore = new ThreadStore();
  const messageStore = new MessageStore();
  const bindingStore = new MemoryConnectorThreadBindingStore();
  const cats = {
    getAllCatIds: () => ['a', 'b', 'offline'],
    getCatDisplayName: (id) => `Cat ${id}`,
    getCatAliases: (id) => [`@${id}`],
    isCatAvailable: (id) => id !== 'offline',
    getRegisteredServices: () =>
      new Map([
        ['a', {}],
        ['b', {}],
      ]),
  };
  const backlogReads = [];
  const host = createPluginThreadHost({
    pluginId: 'dev.fixture',
    pluginInstanceId: 'i-1',
    ownerUserId: 'owner',
    projectPath: '/isolated',
    systemThreadTitle: 'Fixture',
    threadDeepLinkUrl: (id) => `https://cafe.example.test/thread/${encodeURIComponent(id)}`,
    effectiveGrants: grants,
    threadStore,
    messageStore,
    bindingStore,
    cats,
    backlogStore: {
      get: async (id, owner) => {
        backlogReads.push([id, owner]);
        return { tags: ['private-tag', 'feature:f202', 'feature:F202', 'feature:F142'], privateBody: 'secret' };
      },
    },
  });
  return { host, threadStore, messageStore, bindingStore, backlogReads };
}

test('every thread summary carries the Host navigation link, never request-supplied URLs', async () => {
  const f = fixture();
  const created = await f.host.create({ title: 'Linked', deepLinkUrl: 'https://evil.test' });
  await f.host.bind('chat', created.id);
  const summaries = [
    created,
    await f.host.get(created.id),
    ...(await f.host.list()),
    await f.host.update(created.id, { title: 'Renamed' }),
    await f.host.findByKey('chat'),
    await f.host.ensureByKey('chat', { title: 'Existing' }),
    await f.host.ensureByKey('new-chat', { title: 'New' }),
    await f.host.ensureSystemThread(),
  ];
  for (const summary of summaries) {
    assert.equal(summary.deepLinkUrl, `https://cafe.example.test/thread/${encodeURIComponent(summary.id)}`);
  }
  const foreign = await f.threadStore.create('foreign', 'Secret');
  assert.equal(await f.host.get(foreign.id), null);
  const stored = await f.threadStore.get(created.id);
  stored.deletedAt = 1;
  assert.equal(await f.host.get(created.id), null);
  assert.equal(await f.host.findByKey('chat'), null);
  assert.ok((await f.host.list()).every((t) => t.id !== created.id));
  await assert.rejects(() => f.host.update(created.id, { title: 'Deleted' }), /does not exist/);
});

test('navigation URLs use only the canonical HTTP(S) origin and encode the thread path segment', () => {
  const build = createThreadDeepLinkUrl('https://user:secret@CAFE.example.test:443/base?q=private#fragment');
  assert.equal(build('群 /?#%'), 'https://cafe.example.test/thread/%E7%BE%A4%20%2F%3F%23%25');
  assert.equal(createThreadDeepLinkUrl('http://localhost:5142/')('thread-1'), 'http://localhost:5142/thread/thread-1');
  for (const invalid of ['javascript:alert(1)', 'file:///tmp/secret', '/relative', 'not a URL']) {
    assert.throws(() => createThreadDeepLinkUrl(invalid));
  }
});

test('lists owner-accessible threads, bounded by recent activity, without private backlog data', async () => {
  const f = fixture();
  const first = await f.threadStore.create('owner', 'older');
  const second = await f.threadStore.create('owner', 'newer');
  first.lastActiveAt = 1;
  second.lastActiveAt = 2;
  second.backlogItemId = 'private-backlog-id';
  await f.threadStore.create('stranger', 'hidden');
  const list = await f.host.list({ limit: 1 });
  assert.deepEqual(
    list.map((t) => t.id),
    [second.id],
  );
  assert.deepEqual(list[0].featureRefs, ['F202', 'F142']);
  assert.deepEqual(list[0].preferredCats, []);
  assert.equal(JSON.stringify(list).includes('private'), false);
  assert.deepEqual(f.backlogReads, [['private-backlog-id', 'owner']]);
  for (const limit of [0, 51, 1.5, NaN]) await assert.rejects(() => f.host.list({ limit }), /limit/);
  await assert.rejects(() => fixture([]).host.list(), /thread.listMetadata/);
});

test('list cursor reaches owner threads beyond 50 and terminates without repeating the boundary', async () => {
  const f = fixture();
  const expected = [];
  for (let i = 0; i < 51; i++) {
    const thread = await f.threadStore.create('owner', i === 50 ? 'Archived-Needle' : `Recent ${i}`);
    thread.lastActiveAt = 100 - i;
    if (i === 50) thread.backlogItemId = 'feature';
    expected.push(thread.id);
  }
  const foreign = await f.threadStore.create('stranger', 'hidden');
  foreign.lastActiveAt = 75;
  const first = await f.host.list();
  assert.equal(first.length, 50);
  const cursor = ({ lastActiveAt, id }) => ({ lastActiveAt, id });
  const second = await f.host.list({ before: cursor(first.at(-1)) });
  assert.deepEqual(
    [...first, ...second].map((t) => t.id),
    expected,
  );
  assert.equal(second[0].title, 'Archived-Needle');
  assert.ok(second[0].featureRefs.includes('F202'));
  assert.deepEqual(await f.host.list({ before: cursor(second[0]) }), []);
});

test('list cursor uses exclusive time-descending/id-ascending order even when the boundary was removed', async () => {
  const f = fixture();
  const rows = ['z', 'A', 'a', '10', '2'].map((id) => ({
    id,
    title: id,
    createdBy: 'owner',
    createdAt: 0,
    lastActiveAt: 100,
  }));
  rows.push({ id: 'older', title: 'older', createdBy: 'owner', createdAt: 0, lastActiveAt: 99 });
  rows.push({ id: 'foreign', createdBy: 'other', lastActiveAt: 100 });
  rows.push({ id: 'deleted', createdBy: 'owner', lastActiveAt: 100, deletedAt: 1 });
  f.threadStore.list = () => rows;
  const ids = [];
  let before;
  for (let page = 0; page < 4; page++) {
    const result = await f.host.list({ limit: 2, ...(before ? { before } : {}) });
    ids.push(...result.map((t) => t.id));
    if (!result.length) break;
    const last = result.at(-1);
    before = { lastActiveAt: last.lastActiveAt, id: last.id };
    rows.splice(
      rows.findIndex((t) => t.id === last.id),
      1,
    );
  }
  assert.deepEqual(ids, ['10', '2', 'A', 'a', 'z', 'older']);
});

test('list rejects malformed cursors and unknown options before consulting the store', async () => {
  const f = fixture();
  f.threadStore.list = () => assert.fail('invalid request must not read threads');
  for (const before of [
    null,
    1,
    [],
    {},
    { lastActiveAt: 1 },
    { lastActiveAt: -1, id: 'a' },
    { lastActiveAt: NaN, id: 'a' },
    { lastActiveAt: 1.5, id: 'a' },
    { lastActiveAt: 1, id: '' },
    { lastActiveAt: 1, id: ' a' },
    { lastActiveAt: 1, id: 'a'.repeat(501) },
    { lastActiveAt: 1, id: 'a', ownerUserId: 'other' },
  ]) {
    await assert.rejects(() => f.host.list({ before }), /before/);
  }
  await assert.rejects(() => f.host.list({ ownerUserId: 'other' }), /options/);
});

test('history uses owner visibility, chronological order and a strict bounded safe projection', async () => {
  const f = fixture();
  const thread = await f.host.create({ title: 'history' });
  const append = (content, extra = {}) =>
    f.messageStore.append({ threadId: thread.id, userId: 'owner', catId: null, content, timestamp: 10, ...extra });
  append('owner');
  append('cat', { catId: 'a', timestamp: 20, metadata: { secret: 'never-project' } });
  append('foreign', { userId: 'other', timestamp: 25 });
  append('system', { userId: 'system', timestamp: 30 });
  const hidden = append('deleted', { timestamp: 40 });
  await f.messageStore.softDelete(hidden.id, 'owner');
  append('queued', { deliveryStatus: 'queued', timestamp: 50 });
  const rows = await f.host.readMessages(thread.id, { limit: 500 });
  assert.deepEqual(
    rows.map((r) => [r.content, r.sender]),
    [
      ['owner', { kind: 'owner' }],
      ['cat', { kind: 'cat', catId: 'a' }],
      ['system', { kind: 'system' }],
    ],
  );
  assert.deepEqual(Object.keys(rows[0]).sort(), ['content', 'id', 'sender', 'timestamp']);
  assert.deepEqual(
    (await f.host.readMessages(thread.id, { before: { timestamp: rows[2].timestamp, id: rows[2].id }, limit: 1 })).map(
      (r) => r.content,
    ),
    ['cat'],
  );
  for (const limit of [0, 501, 1.1]) await assert.rejects(() => f.host.readMessages(thread.id, { limit }), /limit/);
  await assert.rejects(() => f.host.readMessages(thread.id, { before: NaN, limit: 1 }), /before/);
  const foreign = await f.threadStore.create('foreign', 'no access');
  await assert.rejects(() => f.host.readMessages(foreign.id, { limit: 1 }), /cannot access/);
  await assert.rejects(() => fixture([]).host.readMessages(thread.id, { limit: 1 }), /thread.readContent/);
});

test('cat roster reuses categorization and exposes only public identity and activity', async () => {
  const f = fixture();
  const thread = await f.host.create({ title: 'cats' });
  await f.threadStore.addParticipants(thread.id, ['a']);
  const cats = await f.host.getCats(thread.id);
  assert.deepEqual(cats.routableNow, [{ catId: 'a', displayName: 'Cat a', aliases: ['@a'] }]);
  assert.deepEqual(cats.routableNotJoined, [{ catId: 'b', displayName: 'Cat b', aliases: ['@b'] }]);
  assert.deepEqual(cats.notRoutable, [{ catId: 'offline', displayName: 'Cat offline', aliases: ['@offline'] }]);
  assert.equal(cats.participants[0].catId, 'a');
  const foreign = await f.threadStore.create('foreign', 'no');
  await assert.rejects(() => f.host.getCats(foreign.id), /cannot access/);
  await assert.rejects(() => fixture([]).host.getCats(thread.id), /thread.listMetadata/);
});

test('preferredCats patches reach the owned Host thread, validate before writes, and clear explicitly', async () => {
  const f = fixture();
  const thread = await f.host.create({ title: 'keep' });
  assert.deepEqual((await f.host.update(thread.id, { preferredCats: ['b'] })).preferredCats, ['b']);
  assert.deepEqual((await f.threadStore.get(thread.id)).preferredCats, ['b']);
  assert.equal((await f.host.get(thread.id)).title, 'keep');
  await f.host.update(thread.id, { title: 'renamed' });
  assert.deepEqual((await f.host.get(thread.id)).preferredCats, ['b']);
  for (const patch of [
    {},
    { preferredCats: ['unknown'] },
    { preferredCats: ['offline'] },
    { preferredCats: ['a', 'a'] },
    { preferredCats: null },
    { ownerUserId: 'other' },
  ]) {
    await assert.rejects(() => f.host.update(thread.id, patch));
  }
  await assert.rejects(() => f.host.update(thread.id, { title: 'partial write', preferredCats: ['unknown'] }));
  assert.equal((await f.host.get(thread.id)).title, 'renamed');
  await f.host.update(thread.id, { preferredCats: [] });
  assert.deepEqual((await f.host.get(thread.id)).preferredCats, []);
  const ownerThread = await f.threadStore.create('owner', 'unbound');
  await assert.rejects(() => f.host.update(ownerThread.id, { preferredCats: ['a'] }), /does not own/);
  await f.host.bind('selected', ownerThread.id);
  assert.deepEqual((await f.host.update(ownerThread.id, { preferredCats: ['a'] })).preferredCats, ['a']);
});
