// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('ExternalProjectStore', () => {
  /** @type {import('../dist/domains/projects/external-project-store.js').ExternalProjectStore} */
  let store;

  beforeEach(async () => {
    const mod = await import('../dist/domains/projects/external-project-store.js');
    store = new mod.ExternalProjectStore();
  });

  test('create() returns project with generated id and timestamps', async () => {
    const project = await store.create('user1', {
      name: 'studio-flow',
      description: 'Freelance project',
      sourcePath: '/home/user/projects/studio-flow',
    });
    assert.ok(project.id.startsWith('ep-'));
    assert.equal(project.userId, 'user1');
    assert.equal(project.name, 'studio-flow');
    assert.equal(project.sourcePath, '/home/user/projects/studio-flow');
    assert.equal(project.backlogPath, 'docs/ROADMAP.md');
    assert.ok(project.createdAt > 0);
    assert.equal(project.createdAt, project.updatedAt);
  });

  test('create() uses custom backlogPath when provided', async () => {
    const project = await store.create('user1', {
      name: 'custom',
      description: '',
      sourcePath: '/tmp/custom',
      backlogPath: 'BACKLOG.md',
    });
    assert.equal(project.backlogPath, 'BACKLOG.md');
  });

  test('create() writes Redis detail and user index through one transaction', async () => {
    const mod = await import('../dist/domains/projects/external-project-store.js');
    const calls = [];
    const transaction = {
      hset: (...args) => calls.push(['hset', ...args]),
      zadd: (...args) => calls.push(['zadd', ...args]),
      exec: async () => calls.push(['exec']),
    };
    const redis = {
      hset: () => {
        throw new Error('create() must not write detail outside MULTI');
      },
      zadd: () => {
        throw new Error('create() must not write index outside MULTI');
      },
      multi: () => transaction,
    };
    const redisStore = new mod.ExternalProjectStore(redis);

    const project = await redisStore.create('user1', { name: 'redis', description: '', sourcePath: '/redis' });

    assert.deepEqual(
      calls.map(([name]) => name),
      ['hset', 'zadd', 'exec'],
    );
    assert.match(calls[0][1], new RegExp(`^external:project:${project.id}$`));
    assert.equal(calls[1][1], 'external:projects:user:user1');
    assert.equal(calls[1][3], project.id);
  });

  test('create() throws if sourcePath is empty', async () => {
    await assert.rejects(
      async () => store.create('user1', { name: 'x', description: '', sourcePath: '' }),
      /sourcePath is required/,
    );
  });

  test('listByUser() returns projects newest-first', async () => {
    await store.create('user1', { name: 'a', description: '', sourcePath: '/a' });
    await store.create('user1', { name: 'b', description: '', sourcePath: '/b' });
    await store.create('user2', { name: 'c', description: '', sourcePath: '/c' });

    const user1Projects = await store.listByUser('user1');
    assert.equal(user1Projects.length, 2);
    assert.equal(user1Projects[0].name, 'b');
    assert.equal(user1Projects[1].name, 'a');

    assert.equal((await store.listByUser('user2')).length, 1);
  });

  test('getById() returns project or null', async () => {
    const created = await store.create('user1', { name: 'test', description: '', sourcePath: '/test' });
    assert.deepStrictEqual(await store.getById(created.id), created);
    assert.equal(await store.getById('nonexistent'), null);
  });

  test('update() modifies fields and bumps updatedAt', async () => {
    const created = await store.create('user1', { name: 'old', description: '', sourcePath: '/old' });
    const updated = await store.update(created.id, { name: 'new', sourcePath: '/new' });
    assert.equal(updated.name, 'new');
    assert.equal(updated.sourcePath, '/new');
    assert.ok(updated.updatedAt >= created.updatedAt);
    assert.equal(updated.description, '');
  });

  test('update() returns null for nonexistent id', async () => {
    assert.equal(await store.update('nope', { name: 'x' }), null);
  });

  test('delete() removes project', async () => {
    const created = await store.create('user1', { name: 'del', description: '', sourcePath: '/del' });
    assert.equal(await store.delete(created.id), true);
    assert.equal(await store.getById(created.id), null);
    assert.equal(await store.delete(created.id), false);
  });
});
