/**
 * ConciergeThreadService tests (F229 PR-A1)
 * 使用 MemoryConciergeConfigStore + in-memory ThreadStore，无需真实 Redis
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

// gemini35 lives in the runtime catalog overlay (not cat-template.json).
// Register it for tests so resolveDefaultDutyCatProfileId() can find it.
if (!catRegistry.has('gemini35')) {
  catRegistry.register('gemini35', {
    id: 'gemini35',
    name: '暹罗猫 Gemini 3.5 Flash',
    displayName: '暹罗猫',
    avatar: '/avatars/gemini25.png',
    color: { primary: '#2563EB', secondary: '#DBEAFE' },
    mentionPatterns: ['@gemini35'],
    clientId: 'google',
    defaultModel: 'Gemini 3.5 Flash (High)',
    mcpSupport: true,
    roleDescription: '暹罗猫 Gemini 3.5 Flash',
    personality: '创意灵感丰富',
  });
}

describe('ConciergeThreadService', () => {
  let ConciergeThreadService;
  let ThreadStore;
  let MemoryConciergeConfigStore;

  beforeEach(async () => {
    const svcModule = await import('../dist/domains/concierge/ConciergeThreadService.js');
    ConciergeThreadService = svcModule.ConciergeThreadService;
    const tsModule = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    ThreadStore = tsModule.ThreadStore;
    const storeModule = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    MemoryConciergeConfigStore = storeModule.MemoryConciergeConfigStore;
  });

  function makeService(opts = {}) {
    const threadStore = opts.threadStore ?? new ThreadStore();
    const conciergeConfigStore = opts.conciergeConfigStore ?? new MemoryConciergeConfigStore();
    return {
      service: new ConciergeThreadService({ threadStore, conciergeConfigStore }),
      threadStore,
      conciergeConfigStore,
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
  });

  it('thread is user-indexed with threadKind=concierge (route layer hides it by default)', async () => {
    const { service, threadStore } = makeService();
    await service.getOrCreate('user-4');

    // P1 fix: createdBy=userId means threadStore.list(userId) DOES include the concierge thread.
    // Route layer filters it out when !includeConcierge (threadKind='concierge' signal).
    const threads = await threadStore.list('user-4');
    const conciergeThreads = threads.filter((t) => t.threadKind === 'concierge');
    assert.equal(
      conciergeThreads.length,
      1,
      'concierge thread is in list() — hidden at route level via threadKind filter',
    );
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

  it('syncPreferredCats is no-op when thread does not exist', async () => {
    const { service } = makeService();
    // Should not throw
    await service.syncPreferredCats('user-8', 'gemini35');
  });

  it('syncPreferredCats updates preferredCats on existing thread', async () => {
    const { service, threadStore } = makeService();
    const threadId = await service.getOrCreate('user-9');

    // Change duty cat via syncPreferredCats directly
    await service.syncPreferredCats('user-9', 'opus47');

    const thread = await threadStore.get(threadId);
    assert.ok(thread, 'thread should exist');
    assert.deepStrictEqual(thread.preferredCats, ['opus47'], 'preferredCats should update to new duty cat');
  });

  it('getOrCreate syncs preferredCats to [dutyCatProfileId] from config', async () => {
    const { service, threadStore, conciergeConfigStore } = makeService();

    // Pre-configure the duty cat — use gemini25 (its catId).
    // FIX-3 R2: ConciergeConfigStore.get() now validates dutyCatProfileId against catRegistry,
    // so using an alias would be re-resolved to the default.
    await conciergeConfigStore.put('user-6', {
      enabled: true,
      skin: 'ragdoll-v1',
      displayName: '猫猫球',
      personaTone: '温暖',
      dutyCatProfileId: 'gemini25',
      proactivePolicy: 'quiet-badge',
      muted: false,
    });

    const threadId = await service.getOrCreate('user-6');
    const thread = await threadStore.get(threadId);

    assert.ok(thread, 'thread should exist');
    assert.ok(Array.isArray(thread.preferredCats), 'preferredCats should be an array');
    assert.deepStrictEqual(thread.preferredCats, ['gemini25'], 'preferredCats should contain dutyCatProfileId');
  });

  it('getOrCreate normalizes stale dutyCatProfileId to valid catId (FIX-3 R2)', async () => {
    const { service, threadStore, conciergeConfigStore } = makeService();

    // Store a config with a stale/invalid dutyCatProfileId (e.g., removed cat).
    // FIX-3: ConciergeConfigStore.get() should re-resolve it to the default (gemini35).
    await conciergeConfigStore.put('user-stale', {
      enabled: true,
      skin: 'ragdoll-v1',
      displayName: '猫猫球',
      personaTone: '温暖',
      dutyCatProfileId: 'removed-cat-xyz',
      proactivePolicy: 'quiet-badge',
      muted: false,
    });

    const threadId = await service.getOrCreate('user-stale');
    const thread = await threadStore.get(threadId);

    assert.ok(thread, 'thread should exist');
    // The stale 'removed-cat-xyz' should be re-resolved to 'gemini35' (default duty cat)
    assert.deepStrictEqual(
      thread.preferredCats,
      ['gemini35'],
      'stale dutyCatProfileId should be normalized to valid catId via ConciergeConfigStore.get()',
    );
  });

  it('MemoryConciergeConfigStore default dutyCatProfileId resolves to gemini35', async () => {
    // Default duty cat: gemini35 (暹罗猫 Gemini 3.5 Flash, co-creator directive 2026-06-12).
    // gemini35 is registered in runtime catalog (not cat-template.json), so test setup
    // manually registers it above.
    const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    const store = new MemoryConciergeConfigStore();
    const config = await store.get('user-default-check');
    assert.equal(config.dutyCatProfileId, 'gemini35', 'default duty cat should be gemini35 (暹罗猫 Gemini 3.5 Flash)');
  });
});
