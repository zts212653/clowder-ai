import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('F277 manual Group metadata truth', () => {
  const OWNER_ID = 'test-owner-f277-metadata';
  const headers = { 'x-cat-cafe-user': OWNER_ID };
  const metadata = new Map();
  const threads = [
    ...['thread_alpha', 'thread_beta', 'thread_gamma', 'thread_delta'].map((id, index) => ({
      id,
      createdBy: OWNER_ID,
      createdAt: index + 1,
      deletedAt: null,
      title: id,
    })),
    {
      id: 'thread_eval_friction',
      createdBy: OWNER_ID,
      createdAt: 5,
      deletedAt: null,
      title: 'Eval Hub',
      systemKind: 'eval_domain',
    },
    {
      id: 'thread_connector_hub',
      createdBy: OWNER_ID,
      createdAt: 6,
      deletedAt: null,
      title: 'Connector Hub',
      connectorHubState: { v: 1 },
    },
  ];
  let app;
  let projectRoot;
  let failThreadId = null;

  const threadStore = {
    async list(userId) {
      return userId === OWNER_ID ? threads : [];
    },
    async get(id) {
      return threads.find((thread) => thread.id === id) ?? null;
    },
    async getThreadMetadata(id) {
      return metadata.get(id) ?? null;
    },
    async atomicMergeThreadMetadata(id, patch) {
      if (id === failThreadId) throw new Error(`metadata write failed for ${id}`);
      const current = metadata.get(id) ?? { v: 1 };
      const next = { ...current };
      if (patch.attentionGroup === null) delete next.attentionGroup;
      else if (patch.attentionGroup) next.attentionGroup = patch.attentionGroup;
      metadata.set(id, next);
      return next;
    },
  };

  before(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    projectRoot = await mkdtemp(join(tmpdir(), 'thread-attention-metadata-route-'));
    const { configThreadAttentionRoutes } = await import('../../dist/routes/config-thread-attention.js');
    app = Fastify();
    await app.register(configThreadAttentionRoutes, { projectRoot, threadStore });
    await app.ready();
  });

  after(async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    metadata.clear();
    failThreadId = null;
    await rm(join(projectRoot, '.cat-cafe'), { recursive: true, force: true });
  });

  it('creates a Group only after an explicit command and stores membership in thread metadata', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers });
    assert.deepEqual(JSON.parse(before.payload).groups, []);

    const created = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: { action: 'create', threadIds: ['thread_alpha', 'thread_beta'], name: '发布前检查' },
    });
    assert.equal(created.statusCode, 200, created.payload);
    const group = JSON.parse(created.payload).groups[0];
    assert.match(group.id, /^attention_[A-Za-z0-9_-]+$/);
    assert.deepEqual(group.threadIds, ['thread_alpha', 'thread_beta']);
    assert.deepEqual(metadata.get('thread_alpha').attentionGroup, { v: 1, groupId: group.id, order: 0 });
    assert.deepEqual(metadata.get('thread_beta').attentionGroup, { v: 1, groupId: group.id, order: 1 });

    const preferences = JSON.parse(await readFile(join(projectRoot, '.cat-cafe', 'user-preferences.json'), 'utf-8'));
    assert.equal(preferences.threadAttention?.groups, undefined, 'membership must not fork into preference storage');
    assert.equal(preferences.threadAttention?.aliases?.[`group:${group.id}`], '发布前检查');
  });

  it('moves, renames, removes, and dissolves Groups through the same metadata command path', async () => {
    const create = async (threadIds) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/config/thread-attention/groups',
        headers,
        payload: { action: 'create', threadIds },
      });
      assert.equal(response.statusCode, 200, response.payload);
      return JSON.parse(response.payload).groups.find((group) => threadIds.every((id) => group.threadIds.includes(id)));
    };

    const first = await create(['thread_alpha', 'thread_beta']);
    const second = await create(['thread_gamma', 'thread_delta']);
    const moved = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: {
        action: 'move',
        groupId: second.id,
        threadId: 'thread_beta',
        beforeThreadId: 'thread_delta',
      },
    });
    assert.equal(moved.statusCode, 200, moved.payload);
    assert.deepEqual(JSON.parse(moved.payload).groups, [
      { id: second.id, threadIds: ['thread_gamma', 'thread_beta', 'thread_delta'] },
    ]);
    assert.equal(metadata.get('thread_alpha').attentionGroup, undefined, 'one-member source Group dissolves');

    const renamed = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: { action: 'rename', groupId: second.id, name: '今日发布' },
    });
    assert.equal(renamed.statusCode, 200, renamed.payload);
    assert.equal(JSON.parse(renamed.payload).groups[0].name, '今日发布');
    assert.deepEqual(metadata.get('thread_beta').attentionGroup, { v: 1, groupId: second.id, order: 1 });

    for (const threadId of ['thread_gamma', 'thread_beta']) {
      const removed = await app.inject({
        method: 'POST',
        url: '/api/config/thread-attention/groups',
        headers,
        payload: { action: 'remove', groupId: second.id, threadId },
      });
      assert.equal(removed.statusCode, 200, removed.payload);
    }
    assert.equal(metadata.get('thread_beta').attentionGroup, undefined);
    assert.equal(
      metadata.get('thread_delta').attentionGroup,
      undefined,
      'last member is ungrouped when Group dissolves',
    );
    assert.deepEqual(
      JSON.parse((await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers })).payload).groups,
      [],
    );
    assert.match(first.id, /^attention_/);
  });

  it('rolls back earlier metadata writes and reports a server failure honestly', async () => {
    failThreadId = 'thread_beta';
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: { action: 'create', threadIds: ['thread_alpha', 'thread_beta'] },
    });
    assert.equal(response.statusCode, 500, response.payload);
    assert.equal(metadata.get('thread_alpha')?.attentionGroup, undefined);
    assert.equal(metadata.get('thread_beta')?.attentionGroup, undefined);
  });

  it('rejects system and Hub threads from Group membership and projection', async () => {
    for (const excludedThreadId of ['thread_eval_friction', 'thread_connector_hub']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/config/thread-attention/groups',
        headers,
        payload: { action: 'create', threadIds: ['thread_alpha', excludedThreadId] },
      });
      assert.equal(response.statusCode, 404, `${excludedThreadId}: ${response.payload}`);
      assert.equal(metadata.get('thread_alpha')?.attentionGroup, undefined);
      assert.equal(metadata.get(excludedThreadId)?.attentionGroup, undefined);
    }

    const legacyGroup = { v: 1, groupId: 'attention_legacy_system', order: 0 };
    metadata.set('thread_eval_friction', { v: 1, attentionGroup: legacyGroup });
    metadata.set('thread_connector_hub', { v: 1, attentionGroup: { ...legacyGroup, order: 1 } });
    const snapshot = await app.inject({ method: 'GET', url: '/api/config/thread-attention', headers });
    assert.equal(snapshot.statusCode, 200, snapshot.payload);
    assert.deepEqual(JSON.parse(snapshot.payload).groups, [], 'legacy system metadata must not become a Group');
  });

  it('rolls back Group membership when a named create cannot persist its alias', async () => {
    await writeFile(join(projectRoot, '.cat-cafe'), 'blocks the preference directory', 'utf-8');
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers,
      payload: { action: 'create', threadIds: ['thread_alpha', 'thread_beta'], name: '不能半写' },
    });
    assert.equal(response.statusCode, 500, response.payload);
    assert.equal(metadata.get('thread_alpha')?.attentionGroup, undefined);
    assert.equal(metadata.get('thread_beta')?.attentionGroup, undefined);
  });

  it('rejects non-owner access without reading or mutating metadata', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/config/thread-attention/groups',
      headers: { 'x-cat-cafe-user': 'another-user' },
      payload: { action: 'create', threadIds: ['thread_alpha', 'thread_beta'] },
    });
    assert.equal(response.statusCode, 403, response.payload);
    assert.equal(metadata.size, 0);
  });
});
