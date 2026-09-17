import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('F277 search organizing and guarded undo', () => {
  const owner = 'f277-search-owner';
  const headers = { 'x-cat-cafe-user': owner };
  const metadata = new Map();
  const threads = ['a', 'b', 'c', 'd', 'e'].map((letter, index) => ({
    id: `thread_${letter}`,
    createdBy: owner,
    title: `F311 ${letter}`,
    createdAt: index + 1,
    deletedAt: null,
    pinned: index === 0,
    projectPath: '/project',
    labels: ['keep'],
  }));
  let app;
  let projectRoot;
  let failOnce;
  const absent = new Set();
  const store = {
    async list(userId) {
      return userId === owner ? threads.filter((thread) => !thread.deletedAt && !absent.has(thread.id)) : [];
    },
    async getThreadMetadata(id) {
      return metadata.get(id) ?? null;
    },
    async atomicMergeThreadMetadata(id, patch) {
      if (failOnce === id) {
        failOnce = undefined;
        throw new Error('injected write failure');
      }
      const next = { ...(metadata.get(id) ?? { v: 1, unrelated: 'preserve' }) };
      if (patch.attentionGroup === null) delete next.attentionGroup;
      else if (patch.attentionGroup) next.attentionGroup = patch.attentionGroup;
      metadata.set(id, next);
      return next;
    },
  };
  const post = (payload, identity = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers: identity,
      payload,
    });
  const snapshot = async () =>
    (await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers })).json();
  const membershipGroups = (groups) => groups.map(({ id, threadIds }) => ({ id, threadIds }));
  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = owner;
    projectRoot = await mkdtemp(join(tmpdir(), 'f277-search-organize-'));
    const { configThreadAttentionRoutes } = await import('../../dist/routes/config-thread-attention.js');
    app = Fastify();
    await app.register(configThreadAttentionRoutes, { projectRoot, threadStore: store });
    await app.ready();
  });
  after(async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });
  beforeEach(async () => {
    metadata.clear();
    absent.clear();
    for (const thread of threads) {
      thread.deletedAt = null;
      delete thread.systemKind;
      delete thread.connectorHubState;
    }
    failOnce = undefined;
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true, force: true });
  });

  it('saves the complete explicit selection including unpinned threads and can undo it', async () => {
    const baseline = structuredClone(threads);
    const result = await post({
      action: 'organize',
      threadIds: ['thread_a', 'thread_b', 'thread_c'],
      name: 'F311',
      expectedGroups: [],
    });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(result.json().groups[0].threadIds, ['thread_a', 'thread_b', 'thread_c']);
    assert.equal((await snapshot()).groups[0].name, 'F311');
    assert.deepEqual(threads, baseline, 'organizing must not edit pin, title, project or labels');
    assert.equal(metadata.get('thread_a').unrelated, 'preserve');
    const undone = await post({ action: 'undo', ...result.json().undo });
    assert.equal(undone.statusCode, 200, undone.payload);
    assert.deepEqual((await snapshot()).groups, []);
  });

  it('adds a batch to an existing stable Group and restores both source and target', async () => {
    await post({ action: 'create', threadIds: ['thread_a', 'thread_b'], name: 'source' });
    await post({ action: 'create', threadIds: ['thread_c', 'thread_d'], name: 'target' });
    const before = await snapshot();
    const target = before.groups.find((group) => group.name === 'target');
    const result = await post({
      action: 'organize',
      threadIds: ['thread_b', 'thread_e'],
      groupId: target.id,
      expectedGroups: membershipGroups(before.groups),
    });
    assert.equal(result.statusCode, 200, result.payload);
    assert.deepEqual(result.json().groups, [
      { ...target, threadIds: ['thread_c', 'thread_d', 'thread_b', 'thread_e'] },
    ]);
    const undone = await post({ action: 'undo', ...result.json().undo });
    assert.equal(undone.statusCode, 200, undone.payload);
    assert.deepEqual((await snapshot()).groups, before.groups);
  });

  it('rejects a stale selection before moving a newly grouped thread', async () => {
    await post({ action: 'create', threadIds: ['thread_a', 'thread_b'] });
    const before = await snapshot();
    const response = await post({
      action: 'organize',
      threadIds: ['thread_a', 'thread_c'],
      name: 'stale',
      expectedGroups: [],
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual((await snapshot()).groups, before.groups);
  });

  it('rejects undo after another thread joined, even when old member order did not change', async () => {
    const organized = await post({
      action: 'organize',
      threadIds: ['thread_a', 'thread_b'],
      name: 'first',
      expectedGroups: [],
    });
    assert.equal(organized.statusCode, 200, organized.payload);
    const group = organized.json().groups[0];
    await post({ action: 'move', threadId: 'thread_c', groupId: group.id });
    const before = await snapshot();
    const response = await post({ action: 'undo', ...organized.json().undo });
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual((await snapshot()).groups, before.groups);
  });

  it('rolls back the entire batch on a metadata failure', async () => {
    await post({ action: 'create', threadIds: ['thread_a', 'thread_b'] });
    const before = await snapshot();
    failOnce = 'thread_d';
    const response = await post({
      action: 'organize',
      threadIds: ['thread_b', 'thread_c', 'thread_d'],
      name: 'batch',
      expectedGroups: membershipGroups(before.groups),
    });
    assert.equal(response.statusCode, 500, response.payload);
    assert.deepEqual((await snapshot()).groups, before.groups);
  });

  it('rejects unknown members, non-owner requests and malformed undo without mutation', async () => {
    const payload = { action: 'organize', threadIds: ['thread_a', 'thread_missing'], name: 'bad', expectedGroups: [] };
    assert.equal((await post(payload)).statusCode, 404);
    assert.equal((await post(payload, { 'x-cat-cafe-user': 'another-user' })).statusCode, 403);
    assert.equal((await post({ action: 'undo', entries: [] })).statusCode, 400);
    assert.deepEqual((await snapshot()).groups, []);
  });
  it('does not accept an undo receipt that fabricates a singleton Group', async () => {
    const response = await post({
      action: 'undo',
      entries: [{ threadId: 'thread_a', before: { v: 1, groupId: 'attention_forged', order: 0 }, after: null }],
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.equal(metadata.get('thread_a')?.attentionGroup, undefined);
  });

  it('rejects a complete forged closure that splits a real Group into hidden singletons', async () => {
    const organized = await post({
      action: 'organize',
      threadIds: ['thread_a', 'thread_b'],
      name: 'original',
      expectedGroups: [],
    });
    assert.equal(organized.statusCode, 200, organized.payload);
    const group = organized.json().groups[0];
    const beforeMetadata = structuredClone(metadata);
    const beforeSnapshot = await snapshot();
    const response = await post({
      action: 'undo',
      entries: [
        {
          threadId: 'thread_a',
          before: { v: 1, groupId: 'attention_forged', order: 0 },
          after: { v: 1, groupId: group.id, order: 0 },
        },
        {
          threadId: 'thread_b',
          before: { v: 1, groupId: group.id, order: 1 },
          after: { v: 1, groupId: group.id, order: 1 },
        },
      ],
    });
    assert.equal(response.statusCode, 409, response.payload);
    assert.deepEqual(metadata, beforeMetadata);
    assert.deepEqual(await snapshot(), beforeSnapshot, 'membership and aliases must remain unchanged');
  });

  const visibilityChanges = [
    [
      'soft-deleted',
      (thread) => {
        thread.deletedAt = 99;
      },
    ],
    [
      'system',
      (thread) => {
        thread.systemKind = 'eval_domain';
      },
    ],
    [
      'Hub',
      (thread) => {
        thread.connectorHubState = { v: 1 };
      },
    ],
    [
      'absent',
      (thread) => {
        absent.add(thread.id);
      },
    ],
  ];
  for (const [label, hide] of visibilityChanges) {
    it(`organizes and undoes a visually ungrouped survivor of a ${label} partner`, async () => {
      const created = await post({ action: 'create', threadIds: ['thread_a', 'thread_c'], name: 'legacy' });
      const original = created.json().groups;
      const aBefore = structuredClone(metadata.get('thread_a').attentionGroup);
      const cBefore = structuredClone(metadata.get('thread_c').attentionGroup);
      hide(threads[2]);
      assert.deepEqual((await snapshot()).groups, []);

      const organized = await post({
        action: 'organize',
        threadIds: ['thread_a', 'thread_b'],
        name: 'new',
        expectedGroups: [],
      });
      assert.equal(organized.statusCode, 200, organized.payload);
      assert.deepEqual(organized.json().groups[0].threadIds, ['thread_a', 'thread_b']);
      assert.deepEqual(metadata.get('thread_c').attentionGroup, cBefore, 'hidden partner must not be written');
      const undone = await post({ action: 'undo', ...organized.json().undo });
      assert.equal(undone.statusCode, 200, undone.payload);
      assert.deepEqual(metadata.get('thread_a').attentionGroup, aBefore, 'undo restores even hidden membership');
      assert.deepEqual(metadata.get('thread_c').attentionGroup, cBefore);
      assert.equal(metadata.get('thread_b').attentionGroup, undefined);
      assert.deepEqual((await snapshot()).groups, []);

      threads[2].deletedAt = null;
      delete threads[2].systemKind;
      delete threads[2].connectorHubState;
      absent.clear();
      assert.deepEqual((await snapshot()).groups, original, 'recovering the partner rebuilds the original Group');
    });

    it(`classifies undo after a receipt member becomes ${label} as a no-write conflict`, async () => {
      const organized = await post({
        action: 'organize',
        threadIds: ['thread_a', 'thread_b'],
        name: 'saved',
        expectedGroups: [],
      });
      assert.equal(organized.statusCode, 200, organized.payload);
      hide(threads[1]);
      const before = structuredClone(metadata);
      const response = await post({ action: 'undo', ...organized.json().undo });
      assert.equal(response.statusCode, 409, response.payload);
      assert.deepEqual(metadata, before, 'undo must not restore an obsolete closure');
    });
  }

  it('rejects the old visible snapshot and permits retry after refreshing a now-hidden source Group', async () => {
    await post({ action: 'create', threadIds: ['thread_a', 'thread_c'], name: 'source' });
    const observed = membershipGroups((await snapshot()).groups);
    threads[2].deletedAt = 99;
    const before = structuredClone(metadata);
    const command = { action: 'organize', threadIds: ['thread_a', 'thread_b'], name: 'retry' };
    const stale = await post({ ...command, expectedGroups: observed });
    assert.equal(stale.statusCode, 409, stale.payload);
    assert.deepEqual(metadata, before);
    const refreshed = membershipGroups((await snapshot()).groups);
    assert.deepEqual(refreshed, []);
    const retried = await post({ ...command, expectedGroups: refreshed });
    assert.equal(retried.statusCode, 200, retried.payload);
  });

  it('rejects undo if the previously hidden partner recovers after organizing', async () => {
    await post({ action: 'create', threadIds: ['thread_a', 'thread_c'] });
    threads[2].deletedAt = 99;
    const organized = await post({
      action: 'organize',
      threadIds: ['thread_a', 'thread_b'],
      name: 'new',
      expectedGroups: [],
    });
    assert.equal(organized.statusCode, 200, organized.payload);
    threads[2].deletedAt = null;
    const before = structuredClone(metadata);
    assert.equal((await post({ action: 'undo', ...organized.json().undo })).statusCode, 409);
    assert.deepEqual(metadata, before);
  });
});
