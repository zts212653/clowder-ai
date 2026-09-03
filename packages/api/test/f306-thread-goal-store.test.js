import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

const firstGoal = {
  v: 1,
  intent: 'set',
  objective: '把 Phase C 做成可恢复的用户旅程',
  status: 'active',
  tokenBudget: null,
  revision: 1,
  updatedAt: 1_788_000_000_000,
  sync: { state: 'syncing', source: 'cat_cafe' },
};

describe('F306 ThreadStore goal truth', () => {
  it('persists one revisioned goal and clears only through an exact CAS', () => {
    const store = new ThreadStore();
    const thread = store.create('owner', 'Goal journey');

    assert.equal(store.compareAndSetGoal(thread.id, null, firstGoal), true);
    assert.deepEqual(store.get(thread.id)?.goal, firstGoal);
    assert.equal(store.compareAndSetGoal(thread.id, null, { ...firstGoal, revision: 2 }), false);
    assert.equal(store.compareAndSetGoal(thread.id, 7, null), false);
    assert.equal(store.compareAndSetGoal(thread.id, 1, null), true);
    assert.equal(store.get(thread.id)?.goal, undefined);
  });

  it('rejects stale provider completion after a newer local intent revision', () => {
    const store = new ThreadStore();
    const thread = store.create('owner', 'Goal stale fence');
    store.compareAndSetGoal(thread.id, null, firstGoal);
    const newer = { ...firstGoal, objective: '新的目标', revision: 2, updatedAt: firstGoal.updatedAt + 1 };
    assert.equal(store.compareAndSetGoal(thread.id, 1, newer), true);

    const staleAck = {
      ...firstGoal,
      sync: { state: 'synced', source: 'codex_app_server', observedAt: firstGoal.updatedAt + 2 },
    };
    assert.equal(store.compareAndSetGoal(thread.id, 1, staleAck), false);
    assert.deepEqual(store.get(thread.id)?.goal, newer);
  });
});
