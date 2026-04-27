import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

let store;

beforeEach(async () => {
  const { InMemoryCommunityPrStore } = await import(
    '../dist/domains/cats/services/stores/memory/InMemoryCommunityPrStore.js'
  );
  store = new InMemoryCommunityPrStore();
});

describe('CommunityPrStore', () => {
  test('create + get round-trip', async () => {
    const item = await store.create({
      repo: 'org/repo',
      prNumber: 42,
      title: 'Add feature',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'abc123',
      draft: false,
    });
    assert.ok(item);
    assert.equal(item.prNumber, 42);
    const got = await store.get(item.id);
    assert.deepEqual(got, item);
  });

  test('create returns null on duplicate repo+prNumber', async () => {
    await store.create({
      repo: 'org/repo',
      prNumber: 1,
      title: 'PR 1',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'aaa',
      draft: false,
    });
    const dup = await store.create({
      repo: 'org/repo',
      prNumber: 1,
      title: 'PR 1 dup',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'aaa',
      draft: false,
    });
    assert.equal(dup, null);
  });

  test('getByRepoAndNumber', async () => {
    await store.create({
      repo: 'org/repo',
      prNumber: 10,
      title: 'PR 10',
      author: 'bob',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'bbb',
      draft: false,
    });
    const found = await store.getByRepoAndNumber('org/repo', 10);
    assert.ok(found);
    assert.equal(found.prNumber, 10);
    const miss = await store.getByRepoAndNumber('org/repo', 999);
    assert.equal(miss, null);
  });

  test('listByRepo filters by repo', async () => {
    await store.create({
      repo: 'org/a',
      prNumber: 1,
      title: 'A PR',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'a1',
      draft: false,
    });
    await store.create({
      repo: 'org/b',
      prNumber: 2,
      title: 'B PR',
      author: 'bob',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'b1',
      draft: false,
    });
    const list = await store.listByRepo('org/a');
    assert.equal(list.length, 1);
    assert.equal(list[0].repo, 'org/a');
  });

  test('update changes fields', async () => {
    const item = await store.create({
      repo: 'org/repo',
      prNumber: 5,
      title: 'Old title',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'old',
      draft: false,
    });
    const updated = await store.update(item.id, {
      replyState: 'replied',
      lastReviewedSha: 'old',
      headSha: 'new',
    });
    assert.equal(updated.replyState, 'replied');
    assert.equal(updated.lastReviewedSha, 'old');
    assert.equal(updated.headSha, 'new');
  });

  test('delete returns true/false', async () => {
    const item = await store.create({
      repo: 'org/repo',
      prNumber: 99,
      title: 'Del me',
      author: 'alice',
      state: 'open',
      replyState: 'unreplied',
      headSha: 'x',
      draft: false,
    });
    assert.equal(await store.delete(item.id), true);
    assert.equal(await store.delete(item.id), false);
  });
});
