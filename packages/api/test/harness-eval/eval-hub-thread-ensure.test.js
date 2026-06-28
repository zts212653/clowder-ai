import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { ensureEvalDomainThreads } from '../../dist/infrastructure/harness-eval/hub/eval-hub-thread-ensure.js';

describe('ensureEvalDomainThreads', () => {
  function makeDomain(domainId, systemThreadId, displayName) {
    return {
      domainId,
      displayName,
      systemThreadId,
      evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
      frequency: 'daily',
      sourceAdapter: 'test-adapter',
      sourceRefsKind: 'test-source-refs',
      threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: [] },
      legacyScheduledTaskIds: [],
      handoffTargetResolver: { featureId: 'F999', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
      sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
    };
  }

  it('creates system thread when it does not exist', async () => {
    const store = new ThreadStore();
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];

    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results.length, 1);
    assert.equal(results[0].created, true);
    assert.equal(results[0].threadId, 'thread_eval_a2a');

    const thread = await store.get('thread_eval_a2a');
    assert.ok(thread, 'thread should exist after ensure');
    assert.equal(thread.id, 'thread_eval_a2a');
    assert.equal(thread.title, 'A2A Harness Eval');
    assert.equal(thread.createdBy, 'system');
  });

  it('is a no-op when system thread already exists', async () => {
    const store = new ThreadStore();
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];

    // First call creates
    await ensureEvalDomainThreads(store, domains);
    // Second call should be a no-op
    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results.length, 1);
    assert.equal(results[0].created, false);
    assert.equal(results[0].threadId, 'thread_eval_a2a');
  });

  it('creates multiple domain threads in one call', async () => {
    const store = new ThreadStore();
    const domains = [
      makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval'),
      makeDomain('eval:memory', 'thread_eval_memory', 'Memory Recall & Library Health Eval'),
    ];

    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.created));

    const t1 = await store.get('thread_eval_a2a');
    const t2 = await store.get('thread_eval_memory');
    assert.equal(t1.title, 'A2A Harness Eval');
    assert.equal(t2.title, 'Memory Recall & Library Health Eval');
  });

  it('does not overwrite title of existing thread', async () => {
    const store = new ThreadStore();
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];

    // Create thread first, then update title
    await ensureEvalDomainThreads(store, domains);
    await store.updateTitle('thread_eval_a2a', 'Custom Title');

    // Ensure again — should NOT overwrite the custom title
    await ensureEvalDomainThreads(store, domains);

    const thread = await store.get('thread_eval_a2a');
    assert.equal(thread.title, 'Custom Title');
  });

  it('heals existing thread with null/empty title (P2 regression)', async () => {
    const store = new ThreadStore();
    // Simulate a placeholder thread with null title (created by default thread path)
    store.ensureThread('thread_eval_a2a', '');

    const thread = await store.get('thread_eval_a2a');
    assert.ok(thread, 'placeholder thread should exist');
    assert.equal(thread.title, '', 'title should be empty before healing');

    // Now ensureEvalDomainThreads should repair the empty title
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];
    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results.length, 1);
    assert.equal(results[0].created, false, 'thread already existed');
    assert.equal(results[0].healed, true, 'title should be marked as healed');

    const healed = await store.get('thread_eval_a2a');
    assert.equal(healed.title, 'A2A Harness Eval', 'title should be repaired to display name');
  });

  it('restores soft-deleted system thread (P2 regression)', async () => {
    const store = new ThreadStore();
    // Create and then soft-delete a system thread
    store.ensureThread('thread_eval_a2a', 'A2A Harness Eval');
    store.softDelete('thread_eval_a2a');

    const deleted = store.get('thread_eval_a2a');
    assert.ok(deleted?.deletedAt, 'thread should be soft-deleted');

    // ensureEvalDomainThreads should restore the soft-deleted thread
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];
    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results.length, 1);
    assert.equal(results[0].created, false, 'thread already existed');
    assert.equal(results[0].healed, true, 'should be marked as healed');

    const restored = await store.get('thread_eval_a2a');
    assert.ok(restored, 'thread should exist after restore');
    assert.equal(restored.deletedAt, null, 'deletedAt should be cleared');
    assert.equal(restored.title, 'A2A Harness Eval');
  });

  it('heals null title (not just empty string)', async () => {
    const store = new ThreadStore();
    // Create thread with a title then manually null it out to simulate placeholder
    store.ensureThread('thread_eval_memory', 'temp');
    // Directly set title to null to simulate a placeholder thread created without title
    const thread = store.get('thread_eval_memory');
    thread.title = null;

    assert.equal(thread.title, null, 'title should be null before healing');

    const domains = [makeDomain('eval:memory', 'thread_eval_memory', 'Memory Recall Eval')];
    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results[0].healed, true);
    const healed = store.get('thread_eval_memory');
    assert.equal(healed.title, 'Memory Recall Eval');
  });

  // F192 livefix: systemKind must be set on eval domain threads
  it('sets systemKind to eval_domain on newly created threads', async () => {
    const store = new ThreadStore();
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];

    await ensureEvalDomainThreads(store, domains);

    const thread = await store.get('thread_eval_a2a');
    assert.equal(thread.systemKind, 'eval_domain', 'new eval thread must have systemKind set');
  });

  it('heals existing thread missing systemKind', async () => {
    const store = new ThreadStore();
    // Simulate a pre-existing eval thread without systemKind
    store.ensureThread('thread_eval_a2a', 'A2A Harness Eval');
    const pre = store.get('thread_eval_a2a');
    assert.equal(pre.systemKind, undefined, 'should have no systemKind before heal');

    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];
    const results = await ensureEvalDomainThreads(store, domains);

    assert.equal(results[0].healed, true, 'should be marked healed');
    const healed = store.get('thread_eval_a2a');
    assert.equal(healed.systemKind, 'eval_domain', 'systemKind should be healed');
  });

  it('indexes newly created eval thread for default user sidebar visibility (cloud P1)', async () => {
    const store = new ThreadStore();
    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];

    await ensureEvalDomainThreads(store, domains, 'default-user');

    // The thread should appear in the default user's thread list
    const userThreads = await store.list('default-user');
    const evalThread = userThreads.find((t) => t.id === 'thread_eval_a2a');
    assert.ok(evalThread, 'eval thread must appear in default user thread list for sidebar visibility');
  });

  it('indexes healed eval thread for default user sidebar visibility (cloud P1)', async () => {
    const store = new ThreadStore();
    // Create thread without user indexing (simulating old behavior)
    store.ensureThread('thread_eval_a2a', '');

    const domains = [makeDomain('eval:a2a', 'thread_eval_a2a', 'A2A Harness Eval')];
    await ensureEvalDomainThreads(store, domains, 'default-user');

    // Even healed threads should be in the user list
    const userThreads = await store.list('default-user');
    const evalThread = userThreads.find((t) => t.id === 'thread_eval_a2a');
    assert.ok(evalThread, 'healed eval thread must appear in default user thread list');
  });
});
