/**
 * F260 PR-5 T1: Thread privacy resolver — determines if a thread is
 * workspace-scope (eligible for registration candidate output②) or
 * private (suppressed per KD-7 "宁哑不漏").
 *
 * This resolver breaks the output② dormancy: route-serial/parallel
 * F282 calls it before phrase extraction so private text never reaches the
 * proactive occurrence map.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('resolveThreadPrivacy', () => {
  /** @type {typeof import('../../dist/domains/memory/thread-privacy-resolver.js').resolveThreadPrivacy} */
  let resolveThreadPrivacy;

  // Minimal thread stub factory — only fields the resolver reads
  const makeThread = (overrides = {}) => ({
    id: 'thread_test',
    projectPath: '/test',
    title: 'Test Thread',
    createdBy: 'user-1',
    participants: ['opus'],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  });

  // Minimal thread store stub
  const storeWith = (thread) => ({
    get: (id) => (thread && thread.id === id ? thread : null),
  });

  it('loads the module', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    assert.equal(typeof resolveThreadPrivacy, 'function');
  });

  // ── Workspace (non-private) cases ──

  it('returns false (workspace) for a normal thread with no special flags', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread();
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, false, 'normal threads should be workspace-scope');
  });

  it('returns false for a concierge thread (sidebar-hidden but not private)', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({ threadKind: 'concierge' });
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, false, 'concierge is sidebar-visibility, not privacy');
  });

  // ── Private cases ──

  it('returns true (private) for a system thread with systemKind=connector_hub', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({ systemKind: 'connector_hub' });
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, true, 'system threads should be private');
  });

  it('returns true (private) for a system thread with systemKind=eval_domain', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({ systemKind: 'eval_domain' });
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, true, 'eval domain threads should be private');
  });

  it('returns true (private) for a gate-keeping thread', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({ threadKind: 'gate-keeping' });
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, true, 'gate-keeping threads are ops, not workspace');
  });

  it('returns true (private) for a soft-deleted thread and false again after restore', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({ deletedAt: Date.now() });

    assert.equal(
      await resolveThreadPrivacy(thread.id, storeWith(thread)),
      true,
      'soft-deleted threads must fail closed',
    );

    thread.deletedAt = null;
    assert.equal(
      await resolveThreadPrivacy(thread.id, storeWith(thread)),
      false,
      'restored workspace threads become eligible again',
    );
  });

  it('returns true (private) for threads with metadata notes privacy=private', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread({
      threadMetadata: { v: 1, notes: { privacy: 'private' } },
    });
    const result = await resolveThreadPrivacy(thread.id, storeWith(thread));
    assert.equal(result, true, 'explicit privacy metadata should be respected');
  });

  // ── Fail-closed: unknown thread ──

  it('returns true (private) when thread not found — KD-7 宁哑不漏', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const result = await resolveThreadPrivacy('thread_nonexistent', storeWith(null));
    assert.equal(result, true, 'unknown thread = private (fail-closed)');
  });

  // ── Async store support ──

  it('supports async thread store (Promise-returning get)', async () => {
    ({ resolveThreadPrivacy } = await import('../../dist/domains/memory/thread-privacy-resolver.js'));
    const thread = makeThread();
    const asyncStore = { get: async (id) => (thread.id === id ? thread : null) };
    const result = await resolveThreadPrivacy(thread.id, asyncStore);
    assert.equal(result, false, 'should work with async stores');
  });
});
