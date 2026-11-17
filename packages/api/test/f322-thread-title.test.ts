import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';

test('temporary first-message title becomes a cat title exactly once', async () => {
  const store = new ThreadStore();
  const thread = store.create('u');
  assert.equal(await store.setAutomaticTitle(thread.id, '帮我做一个能接上已有会话的入口', 'temporary'), true);
  assert.equal(await store.setAutomaticTitle(thread.id, '接上已有会话', 'cat', 'codex61-sol'), true);
  assert.equal(store.get(thread.id)?.titleSource, 'cat');
  assert.equal(store.get(thread.id)?.titleCatId, 'codex61-sol');
  assert.equal(await store.setAutomaticTitle(thread.id, '再次起名', 'cat', 'sonnet'), false);
  assert.equal(store.get(thread.id)?.title, '接上已有会话');
});

test('explicit creation title and user rename, including an unchanged title, block automatic naming', async () => {
  const store = new ThreadStore();
  const named = store.create('u', '我的名字');
  assert.equal(await store.setAutomaticTitle(named.id, '猫想改名', 'cat', 'sonnet'), false);
  const thread = store.create('u');
  await store.setAutomaticTitle(thread.id, '临时名', 'temporary');
  store.updateTitle(thread.id, '临时名');
  assert.equal(store.get(thread.id)?.titleSource, 'user');
  assert.equal(await store.setAutomaticTitle(thread.id, '猫想改名', 'cat', 'sonnet'), false);
});

test('parallel cats can only claim one automatic title', async () => {
  const store = new ThreadStore();
  const thread = store.create('u');
  const results = await Promise.all([
    store.setAutomaticTitle(thread.id, '一个短名', 'cat', 'sonnet'),
    store.setAutomaticTitle(thread.id, '另一个短名', 'cat', 'codex61-sol'),
  ]);
  assert.deepEqual(results, [true, false]);
});

test('progress updates a cat title but respects a subsequent user rename', () => {
  const store = new ThreadStore();
  const thread = store.create('u');
  store.setAutomaticTitle(thread.id, '排查问题', 'cat', 'sonnet');
  assert.equal(store.setAutomaticTitle(thread.id, 'issue#2006 提交修复', 'cat', 'codex', 'update'), true);
  assert.equal(store.get(thread.id)?.title, 'issue#2006 提交修复');
  assert.equal(store.get(thread.id)?.titleCatId, 'codex');
  store.updateTitle(thread.id, '用户保留的标题');
  assert.equal(store.setAutomaticTitle(thread.id, '自动更新', 'cat', 'codex', 'update'), false);
  assert.equal(store.get(thread.id)?.title, '用户保留的标题');
});

(['cat', 'user'] as const).forEach((source) => {
  test(`an explicit user request replaces a ${source} title and remains protected`, () => {
    const store = new ThreadStore();
    const thread = store.create('u', source === 'user' ? '原来的标题' : undefined);
    if (source === 'cat') store.setAutomaticTitle(thread.id, '原来的标题', 'cat', 'sonnet');
    assert.equal(store.setUserRequestedTitle(thread.id, '用户指定的新标题', 0), 'applied');
    assert.equal(store.get(thread.id)?.title, '用户指定的新标题');
    assert.equal(store.get(thread.id)?.titleSource, 'user');
    assert.equal(store.get(thread.id)?.titleCatId, undefined);
    assert.equal(store.setAutomaticTitle(thread.id, '继续自动更新', 'cat', 'codex', 'update'), false);
  });
});

test('protected title decisions invalidate old requests even when a menu saves the same name or restores it', () => {
  const store = new ThreadStore();
  const thread = store.create('u', '原名');
  store.updateTitle(thread.id, '原名');
  assert.equal(store.setUserRequestedTitle(thread.id, '旧委托', 0), 'revision_conflict');
  store.updateTitle(thread.id, '其他名字');
  store.updateTitle(thread.id, '原名');
  assert.equal(store.setUserRequestedTitle(thread.id, '旧委托', 0), 'revision_conflict');
  assert.equal(store.get(thread.id)?.title, '原名');
  assert.equal(store.get(thread.id)?.userTitleRevision, 3);
});

test('requested title writes report missing/deleted threads and only one request wins a decision revision', async () => {
  const store = new ThreadStore();
  assert.equal(store.setUserRequestedTitle('missing', '新名', 0), 'not_found');
  const thread = store.create('u');
  const outcomes = await Promise.all([
    store.setUserRequestedTitle(thread.id, '甲', 0),
    store.setUserRequestedTitle(thread.id, '乙', 0),
  ]);
  assert.deepEqual(outcomes, ['applied', 'revision_conflict']);
  thread.deletedAt = Date.now();
  assert.equal(store.setUserRequestedTitle(thread.id, '丙', 1), 'deleted');
});
