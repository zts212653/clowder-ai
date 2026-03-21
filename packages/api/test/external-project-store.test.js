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

  test('create() returns project with generated id and timestamps', () => {
    const project = store.create('user1', {
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

  test('create() uses custom backlogPath when provided', () => {
    const project = store.create('user1', {
      name: 'custom',
      description: '',
      sourcePath: '/tmp/custom',
      backlogPath: 'BACKLOG.md',
    });
    assert.equal(project.backlogPath, 'BACKLOG.md');
  });

  test('create() throws if sourcePath is empty', () => {
    assert.throws(
      () => store.create('user1', { name: 'x', description: '', sourcePath: '' }),
      /sourcePath is required/,
    );
  });

  test('listByUser() returns projects newest-first', () => {
    store.create('user1', { name: 'a', description: '', sourcePath: '/a' });
    store.create('user1', { name: 'b', description: '', sourcePath: '/b' });
    store.create('user2', { name: 'c', description: '', sourcePath: '/c' });

    const user1Projects = store.listByUser('user1');
    assert.equal(user1Projects.length, 2);
    assert.equal(user1Projects[0].name, 'b');
    assert.equal(user1Projects[1].name, 'a');

    assert.equal(store.listByUser('user2').length, 1);
  });

  test('getById() returns project or null', () => {
    const created = store.create('user1', { name: 'test', description: '', sourcePath: '/test' });
    assert.deepStrictEqual(store.getById(created.id), created);
    assert.equal(store.getById('nonexistent'), null);
  });

  test('update() modifies fields and bumps updatedAt', () => {
    const created = store.create('user1', { name: 'old', description: '', sourcePath: '/old' });
    const updated = store.update(created.id, { name: 'new', sourcePath: '/new' });
    assert.equal(updated.name, 'new');
    assert.equal(updated.sourcePath, '/new');
    assert.ok(updated.updatedAt >= created.updatedAt);
    assert.equal(updated.description, '');
  });

  test('update() returns null for nonexistent id', () => {
    assert.equal(store.update('nope', { name: 'x' }), null);
  });

  test('delete() removes project', () => {
    const created = store.create('user1', { name: 'del', description: '', sourcePath: '/del' });
    assert.equal(store.delete(created.id), true);
    assert.equal(store.getById(created.id), null);
    assert.equal(store.delete(created.id), false);
  });
});
