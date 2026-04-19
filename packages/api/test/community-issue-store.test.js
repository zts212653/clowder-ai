import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('CommunityIssueStore (in-memory)', () => {
  let store;

  before(async () => {
    const { createCommunityIssueStore } = await import(
      '../dist/domains/cats/services/stores/factories/CommunityIssueStoreFactory.js'
    );
    store = createCommunityIssueStore();
  });

  it('create + get round-trip', async () => {
    const item = await store.create({
      repo: 'zts212653/clowder-ai',
      issueNumber: 42,
      issueType: 'feature',
      title: 'Support dark mode',
    });
    assert.equal(item.repo, 'zts212653/clowder-ai');
    assert.equal(item.issueNumber, 42);
    assert.equal(item.state, 'unreplied');
    assert.equal(item.replyState, 'unreplied');
    assert.ok(item.id);
    assert.ok(item.createdAt > 0);
    assert.ok(item.updatedAt > 0);
    assert.equal(item.assignedThreadId, null);
    assert.equal(item.assignedCatId, null);
    assert.deepEqual(item.linkedPrNumbers, []);
    assert.equal(item.directionCard, null);
    assert.equal(item.ownerDecision, null);
    assert.equal(item.relatedFeature, null);

    const got = await store.get(item.id);
    assert.deepEqual(got, item);
  });

  it('listByRepo returns items for that repo only', async () => {
    await store.create({
      repo: 'other/repo',
      issueNumber: 1,
      issueType: 'bug',
      title: 'Other repo issue',
    });
    const items = await store.listByRepo('zts212653/clowder-ai');
    assert.ok(items.length >= 1);
    assert.ok(items.every((i) => i.repo === 'zts212653/clowder-ai'));
  });

  it('listAll returns all items', async () => {
    const all = await store.listAll();
    assert.ok(all.length >= 2);
  });

  it('update state', async () => {
    const items = await store.listByRepo('zts212653/clowder-ai');
    const item = items[0];
    const updated = await store.update(item.id, {
      state: 'discussing',
      replyState: 'replied',
      consensusState: 'discussing',
    });
    assert.equal(updated.state, 'discussing');
    assert.equal(updated.replyState, 'replied');
    assert.equal(updated.consensusState, 'discussing');
    assert.ok(updated.updatedAt >= item.updatedAt);
  });

  it('update returns null for non-existent id', async () => {
    const result = await store.update('nonexistent', { state: 'closed' });
    assert.equal(result, null);
  });

  it('getByRepoAndNumber dedup lookup', async () => {
    const found = await store.getByRepoAndNumber('zts212653/clowder-ai', 42);
    assert.ok(found);
    assert.equal(found.issueNumber, 42);
    assert.equal(found.repo, 'zts212653/clowder-ai');
  });

  it('getByRepoAndNumber returns null for unknown', async () => {
    const result = await store.getByRepoAndNumber('zts212653/clowder-ai', 9999);
    assert.equal(result, null);
  });

  it('delete removes item', async () => {
    const items = await store.listByRepo('zts212653/clowder-ai');
    const target = items[0];
    const deleted = await store.delete(target.id);
    assert.equal(deleted, true);
    const got = await store.get(target.id);
    assert.equal(got, null);
  });

  it('delete returns false for non-existent', async () => {
    const result = await store.delete('nonexistent');
    assert.equal(result, false);
  });

  it('get returns null for non-existent id', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });
});
