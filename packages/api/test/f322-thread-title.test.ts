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
