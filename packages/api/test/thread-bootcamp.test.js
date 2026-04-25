import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F087: Thread bootcampState', () => {
  let store;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    store = new ThreadStore();
  });

  it('creates thread without bootcampState by default', () => {
    const thread = store.create('user1', 'Test');
    assert.strictEqual(thread.bootcampState, undefined);
  });

  it('updateBootcampState sets state on thread', () => {
    const thread = store.create('user1', 'Bootcamp');
    const state = {
      v: 1,
      phase: 'phase-1-intro',
      startedAt: Date.now(),
    };
    store.updateBootcampState(thread.id, state);
    const updated = store.get(thread.id);
    assert.deepStrictEqual(updated.bootcampState, state);
  });

  it('updateBootcampState transitions phase', () => {
    const thread = store.create('user1', 'Bootcamp');
    store.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-1-intro',
      startedAt: Date.now(),
    });

    store.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-1-intro',
      leadCat: 'opus',
      startedAt: Date.now(),
    });

    const updated = store.get(thread.id);
    assert.strictEqual(updated.bootcampState.phase, 'phase-1-intro');
    assert.strictEqual(updated.bootcampState.leadCat, 'opus');
  });

  it('updateBootcampState with null clears state', () => {
    const thread = store.create('user1', 'Bootcamp');
    store.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-1-intro',
      startedAt: Date.now(),
    });
    assert.ok(store.get(thread.id).bootcampState);

    store.updateBootcampState(thread.id, null);
    assert.strictEqual(store.get(thread.id).bootcampState, undefined);
  });

  it('updateBootcampState with task selection', () => {
    const thread = store.create('user1', 'Bootcamp');
    store.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-4-task-select',
      leadCat: 'gemini',
      selectedTaskId: 'Q1',
      startedAt: Date.now(),
    });

    const updated = store.get(thread.id);
    assert.strictEqual(updated.bootcampState.selectedTaskId, 'Q1');
    assert.strictEqual(updated.bootcampState.leadCat, 'gemini');
  });

  it('ignores update on non-existent thread', () => {
    store.updateBootcampState('nonexistent', {
      v: 1,
      phase: 'phase-1-intro',
      startedAt: Date.now(),
    });
    // Should not throw
  });
});
