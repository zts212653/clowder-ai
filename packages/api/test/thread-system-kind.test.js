/**
 * Thread systemKind Tests (F192 livefix — OQ-19)
 *
 * System threads need a `systemKind` discriminator so the sidebar "系统" section
 * can show both IM Hub threads AND eval domain threads.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Thread systemKind', () => {
  test('systemKind is undefined by default', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Regular thread');
    assert.equal(thread.systemKind, undefined);
  });

  test('updateSystemKind sets kind on thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Eval thread');

    store.updateSystemKind(thread.id, 'eval_domain');
    const updated = store.get(thread.id);
    assert.equal(updated.systemKind, 'eval_domain');
  });

  test('updateSystemKind supports connector_hub kind', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'IM Hub thread');

    store.updateSystemKind(thread.id, 'connector_hub');
    const updated = store.get(thread.id);
    assert.equal(updated.systemKind, 'connector_hub');
  });

  test('updateSystemKind(null) clears systemKind', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    const thread = store.create('user-1', 'Temp system thread');

    store.updateSystemKind(thread.id, 'eval_domain');
    assert.equal(store.get(thread.id).systemKind, 'eval_domain');

    store.updateSystemKind(thread.id, null);
    assert.equal(store.get(thread.id).systemKind, undefined);
  });

  test('updateSystemKind no-ops for nonexistent thread', async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    const store = new ThreadStore();
    // Should not throw
    store.updateSystemKind('nonexistent-id', 'eval_domain');
  });
});
