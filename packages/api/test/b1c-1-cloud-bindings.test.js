/**
 * F247 AC-B1c-1: cloudCatBindings ThreadStore + sanitizer tests.
 *
 * Covers:
 *  - In-memory `updateCloudCatBinding` / `getCloudCatBindings` per-cat semantics
 *  - Privacy: `sanitizeThreadForResponse` strips `cloudCatBindings` from default GET
 *  - Privacy: empty bindings → no field on Thread object (avoid leaking empty `{}`)
 *  - Idempotency: clearing a non-existent binding is a safe no-op
 *  - Multi-catId isolation: setting one binding doesn't touch another
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { sanitizeThreadForResponse } from '../dist/routes/threads.js';

const USER = 'user-alice';

function newStoreWithThread() {
  const store = new ThreadStore();
  const thread = store.create(USER, 'F247 B1c sanity thread');
  return { store, thread };
}

describe('F247 AC-B1c-1: cloudCatBindings ThreadStore (in-memory)', () => {
  describe('updateCloudCatBinding — write', () => {
    it('sets a binding with a valid URL', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/abc-123');
      assert.deepEqual(store.getCloudCatBindings(thread.id), {
        'gpt-pro': 'https://chatgpt.com/c/abc-123',
      });
    });

    it('overwrites an existing binding for the same catId', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/v1');
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/v2');
      assert.deepEqual(store.getCloudCatBindings(thread.id), {
        'gpt-pro': 'https://chatgpt.com/c/v2',
      });
    });

    it('multi-cat bindings are isolated per catId', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/aaa');
      store.updateCloudCatBinding(thread.id, 'claude-cloud', 'https://chatgpt.com/c/bbb');
      assert.deepEqual(store.getCloudCatBindings(thread.id), {
        'gpt-pro': 'https://chatgpt.com/c/aaa',
        'claude-cloud': 'https://chatgpt.com/c/bbb',
      });
    });

    it('no-op when thread does not exist', () => {
      const store = new ThreadStore();
      // Should not throw.
      store.updateCloudCatBinding('thread-does-not-exist', 'gpt-pro', 'https://chatgpt.com/c/abc');
      assert.deepEqual(store.getCloudCatBindings('thread-does-not-exist'), {});
    });
  });

  describe('updateCloudCatBinding — clear (null)', () => {
    it('clears a specific catId binding when chatUrl=null', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/abc');
      store.updateCloudCatBinding(thread.id, 'gpt-pro', null);
      assert.deepEqual(store.getCloudCatBindings(thread.id), {});
    });

    it('clearing one catId leaves other bindings intact', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/aaa');
      store.updateCloudCatBinding(thread.id, 'claude-cloud', 'https://chatgpt.com/c/bbb');
      store.updateCloudCatBinding(thread.id, 'gpt-pro', null);
      assert.deepEqual(store.getCloudCatBindings(thread.id), {
        'claude-cloud': 'https://chatgpt.com/c/bbb',
      });
    });

    it('clearing a non-existent binding is a safe no-op', () => {
      const { store, thread } = newStoreWithThread();
      // Should not throw, should not leak empty {} into thread object.
      store.updateCloudCatBinding(thread.id, 'never-bound', null);
      assert.deepEqual(store.getCloudCatBindings(thread.id), {});
      const t = store.get(thread.id);
      assert.equal(
        t.cloudCatBindings,
        undefined,
        'thread.cloudCatBindings should remain undefined after null clear on empty',
      );
    });

    it('clearing the last binding removes the cloudCatBindings field entirely (no empty {} leak)', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/abc');
      store.updateCloudCatBinding(thread.id, 'gpt-pro', null);
      const t = store.get(thread.id);
      assert.equal(
        t.cloudCatBindings,
        undefined,
        'thread.cloudCatBindings should be undefined after clearing last binding',
      );
    });
  });

  describe('getCloudCatBindings — read', () => {
    it('returns empty object when no bindings exist', () => {
      const { store, thread } = newStoreWithThread();
      assert.deepEqual(store.getCloudCatBindings(thread.id), {});
    });

    it('returns empty object when thread does not exist', () => {
      const store = new ThreadStore();
      assert.deepEqual(store.getCloudCatBindings('does-not-exist'), {});
    });

    it('returned object is a defensive copy — mutating result does not affect store', () => {
      const { store, thread } = newStoreWithThread();
      store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/abc');
      const copy = store.getCloudCatBindings(thread.id);
      copy['gpt-pro'] = 'https://chatgpt.com/c/hacked';
      copy.injected = 'https://chatgpt.com/c/evil';
      assert.deepEqual(store.getCloudCatBindings(thread.id), {
        'gpt-pro': 'https://chatgpt.com/c/abc',
      });
    });
  });
});

describe('F247 AC-B1c-8: privacy — sanitizeThreadForResponse strips cloudCatBindings', () => {
  it('strips cloudCatBindings when present', () => {
    const thread = {
      id: 't1',
      projectPath: 'default',
      title: 'demo',
      createdBy: 'user-alice',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
      cloudCatBindings: { 'gpt-pro': 'https://chatgpt.com/c/abc' },
    };
    const sanitized = sanitizeThreadForResponse(thread, 'user-alice');
    assert.equal(sanitized.cloudCatBindings, undefined, 'cloudCatBindings must be stripped');
    // Other fields preserved
    assert.equal(sanitized.id, 't1');
    assert.equal(sanitized.title, 'demo');
  });

  it('is a no-op when neither pendingContinuation nor cloudCatBindings present', () => {
    const thread = {
      id: 't1',
      projectPath: 'default',
      title: 'demo',
      createdBy: 'user-alice',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
    };
    const sanitized = sanitizeThreadForResponse(thread, 'user-alice');
    // Reference equality — same object returned to avoid unnecessary copy
    assert.equal(sanitized, thread);
  });

  it('strips both pendingContinuation and cloudCatBindings together', () => {
    const thread = {
      id: 't1',
      projectPath: 'default',
      title: 'demo',
      createdBy: 'user-alice',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
      pendingContinuation: { 'codex:user': { capsule: {}, createdAt: 0 } },
      cloudCatBindings: { 'gpt-pro': 'https://chatgpt.com/c/abc' },
    };
    const sanitized = sanitizeThreadForResponse(thread, 'user-alice');
    assert.equal(sanitized.pendingContinuation, undefined);
    assert.equal(sanitized.cloudCatBindings, undefined);
    assert.equal(sanitized.id, 't1');
  });

  it('non-owner userId still gets bindings stripped (privacy is universal, not owner-conditional)', () => {
    const thread = {
      id: 't1',
      projectPath: 'default',
      title: 'demo',
      createdBy: 'user-alice',
      participants: [],
      lastActiveAt: 0,
      createdAt: 0,
      cloudCatBindings: { 'gpt-pro': 'https://chatgpt.com/c/abc' },
    };
    // Sanitize is called with arbitrary userId; bindings stripped regardless.
    // Owner-only access is enforced by the dedicated /cloud-bindings endpoints, not here.
    const sanitized = sanitizeThreadForResponse(thread, 'user-stranger');
    assert.equal(sanitized.cloudCatBindings, undefined);
  });
});

describe('F247 AC-B1c-1: ThreadStore.get hydrates cloudCatBindings (in-memory)', () => {
  it('thread.get returns the cloudCatBindings field directly in-memory', () => {
    // In-memory store stores bindings on the thread object directly (for test ergonomics).
    // Redis store does NOT hydrate it (separate hash fields, privacy by absence) — see RedisThreadStore impl.
    const { store, thread } = newStoreWithThread();
    store.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/abc');
    const refreshed = store.get(thread.id);
    assert.deepEqual(refreshed.cloudCatBindings, { 'gpt-pro': 'https://chatgpt.com/c/abc' });
  });
});
