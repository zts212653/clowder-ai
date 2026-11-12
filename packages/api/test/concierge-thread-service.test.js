/**
 * ConciergeThreadService tests (F229 PR-A1)
 * 使用猫猫球插件配置 fixture + in-memory ThreadStore，无需真实 Redis
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { companionConfigurationFixture } from './helpers/companion-configuration-fixture.js';

// Register gemini35 for tests so the default member can be found
// even when this file runs with an isolated minimal registry.
if (!catRegistry.has('gemini35')) {
  catRegistry.register('gemini35', {
    id: 'gemini35',
    name: '暹罗猫 Gemini 3.6 Flash',
    displayName: '暹罗猫',
    avatar: '/avatars/gemini25.png',
    color: { primary: '#2563EB', secondary: '#DBEAFE' },
    mentionPatterns: ['@gemini35', '@gemini36'],
    clientId: 'google',
    defaultModel: 'Gemini 3.6 Flash (High)',
    mcpSupport: true,
    roleDescription: '暹罗猫 Gemini 3.6 Flash',
    personality: '创意灵感丰富',
  });
}

describe('ConciergeThreadService', () => {
  let ConciergeThreadService;
  let ThreadStore;

  beforeEach(async () => {
    const svcModule = await import('../dist/domains/concierge/ConciergeThreadService.js');
    ConciergeThreadService = svcModule.ConciergeThreadService;
    const tsModule = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    ThreadStore = tsModule.ThreadStore;
  });

  function makeService(opts = {}) {
    const threadStore = opts.threadStore ?? new ThreadStore();
    const companion = companionConfigurationFixture();
    return {
      service: new ConciergeThreadService({ threadStore, companionSettings: companion.read }),
      threadStore,
      companion,
    };
  }

  it('getOrCreate returns a threadId for a new user', async () => {
    const { service } = makeService();
    const threadId = await service.getOrCreate('user-1');
    assert.ok(typeof threadId === 'string' && threadId.length > 0);
  });

  it('getOrCreate is idempotent — same userId returns same threadId', async () => {
    const { service } = makeService();
    const first = await service.getOrCreate('user-2');
    const second = await service.getOrCreate('user-2');
    assert.equal(first, second);
  });

  it('different users get different threadIds', async () => {
    const { service } = makeService();
    const a = await service.getOrCreate('user-a');
    const b = await service.getOrCreate('user-b');
    assert.notEqual(a, b);
  });

  it('created thread has threadKind=concierge in ThreadStore', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('user-3');
    const thread = await threadStore.get(threadId);
    assert.ok(thread, 'thread should exist in store');
    assert.equal(thread.threadKind, 'concierge');
    assert.equal(thread.title, '猫猫球 · 伴随对话');
  });

  it('migrates the generated legacy title without replacing a title chosen by the user', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('user-legacy');
    await threadStore.updateTitle(threadId, '前台猫·user-legacy');
    assert.equal(await service.getOrCreate('user-legacy'), threadId);
    assert.equal((await threadStore.get(threadId)).title, '猫猫球 · 伴随对话');
    await threadStore.updateTitle(threadId, '我的散步聊天');
    assert.equal(await service.getOrCreate('user-legacy'), threadId);
    assert.equal((await threadStore.get(threadId)).title, '我的散步聊天');
  });

  it('repairs an empty canonical title but preserves a literal user title', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('user-empty');
    const thread = await threadStore.get(threadId);
    thread.title = null;
    assert.equal(await service.getOrCreate('user-empty'), threadId);
    assert.equal((await threadStore.get(threadId)).title, '猫猫球 · 伴随对话');
    await threadStore.updateTitle(threadId, '未命名对话');
    assert.equal(await service.getOrCreate('user-empty'), threadId);
    assert.equal((await threadStore.get(threadId)).title, '未命名对话');
  });

  it('finds a stored legacy carrier whose creator predates per-user thread indexing', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('legacy-owner');
    const thread = await threadStore.get(threadId);
    thread.createdBy = 'concierge-system';
    thread.title = null;
    assert.equal(await service.findThreadId('legacy-owner'), threadId);
    assert.equal((await threadStore.get(threadId)).title, '猫猫球 · 伴随对话');
  });

  it('thread is user-indexed with threadKind=concierge for canonical route discovery', async () => {
    const { service, threadStore } = makeService();
    await service.getOrCreate('user-4');

    // createdBy=userId keeps the canonical carrier in its owner's list.
    // The route uses threadKind plus the stored key to hide only noncanonical orphans.
    const threads = await threadStore.list('user-4');
    const conciergeThreads = threads.filter((t) => t.threadKind === 'concierge');
    assert.equal(conciergeThreads.length, 1, 'canonical concierge thread is in the owner list');
  });

  it('getOrCreate returns existing threadId even after multiple calls', async () => {
    const { service } = makeService();
    const ids = await Promise.all([
      service.getOrCreate('user-5'),
      service.getOrCreate('user-5'),
      service.getOrCreate('user-5'),
    ]);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[1], ids[2]);
  });

  it('getOrCreate creates a fresh thread when stored thread is soft-deleted', async () => {
    const { service, threadStore } = makeService();

    // Create thread, then soft-delete it (matches DELETE /api/threads/:id route behavior)
    const originalId = await service.getOrCreate('user-sd');
    const didDelete = threadStore.softDelete(originalId);
    assert.ok(didDelete, 'softDelete should succeed');
    const deleted = await threadStore.get(originalId);
    assert.ok(deleted?.deletedAt, 'thread should be soft-deleted');

    // getOrCreate should create a new thread, not reuse the soft-deleted one
    const freshId = await service.getOrCreate('user-sd');
    assert.notEqual(freshId, originalId, 'fresh thread must have a new id');
    const fresh = await threadStore.get(freshId);
    assert.ok(fresh && !fresh.deletedAt, 'fresh thread should not be deleted');
  });

  it('getOrCreate self-heals missing threadKind=concierge marker (R19 P2)', async () => {
    // Regression: crash between storeThreadId() and updateThreadKind() leaves the canonical
    // thread without the threadKind='concierge' marker. getOrCreate must repair it on next
    // call so ConciergePromptSection injection and route-layer filtering work correctly.
    const { service, threadStore } = makeService();

    const threadId = await service.getOrCreate('user-r19');
    // Simulate crash: manually clear threadKind as if crash happened between
    // storeThreadId (key claimed) and updateThreadKind (marker set).
    threadStore.updateThreadKind(threadId, null);
    const broken = await threadStore.get(threadId);
    assert.ok(!broken?.threadKind, 'precondition: threadKind should be absent after clear');

    // getOrCreate must self-heal the marker
    const healedId = await service.getOrCreate('user-r19');
    assert.equal(healedId, threadId, 'must return the same canonical thread');
    const healed = await threadStore.get(healedId);
    assert.equal(healed?.threadKind, 'concierge', 'threadKind must be repaired to concierge');
  });

  it('findThreadId returns null for soft-deleted threads', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('user-sd2');
    threadStore.softDelete(threadId);

    const found = await service.findThreadId('user-sd2');
    assert.strictEqual(found, null, 'findThreadId should return null for soft-deleted threads');
  });

  it('findThreadId returns null when no thread exists yet', async () => {
    const { service } = makeService();
    const result = await service.findThreadId('user-no-thread');
    assert.strictEqual(result, null);
  });

  it('findThreadId returns the threadId after getOrCreate', async () => {
    const { service } = makeService();
    const threadId = await service.getOrCreate('user-7');
    const found = await service.findThreadId('user-7');
    assert.strictEqual(found, threadId);
  });

  it('getOrCreate syncs preferredCats to [dutyCatProfileId] from the companion configuration', async () => {
    const { service, threadStore, companion } = makeService();
    companion.set({ dutyCatProfileId: 'gemini25' });

    const threadId = await service.getOrCreate('user-6');
    const thread = await threadStore.get(threadId);

    assert.ok(thread, 'thread should exist');
    assert.deepStrictEqual(thread.preferredCats, ['gemini25'], 'preferredCats should contain dutyCatProfileId');
  });

  it('companion settings come from the plugin manifest defaults for an unconfigured owner', async () => {
    const settings = await companionConfigurationFixture().read();
    assert.equal(settings.dutyCatProfileId, 'gemini35', 'an unchosen member falls back to gemini35');
    assert.equal(settings.skin, 'xianxian-codex', 'default skin should be 宪宪');
    assert.equal(settings.ballSize, 72);
  });

  it('companion settings keep a saved skin choice', async () => {
    const companion = companionConfigurationFixture({ skin: 'yanyan-codex' });
    assert.equal((await companion.read()).skin, 'yanyan-codex');
  });
});
