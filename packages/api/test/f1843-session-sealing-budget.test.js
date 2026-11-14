import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';

test('a failing sealing owner leaves automatic recovery after five attempts without blocking its neighbor', async () => {
  const store = new SessionChainStore();
  const broken = store.create({ catId: 'opus', userId: 'owner', threadId: 'broken' });
  const healthy = store.create({ catId: 'opus', userId: 'owner', threadId: 'healthy' });
  for (const record of [broken, healthy]) store.update(record.id, { status: 'sealing', updatedAt: 1 });
  const update = store.update.bind(store);
  let attempts = 0;
  store.update = (id, patch) => {
    if (id === broken.id && patch.status === 'sealed') {
      attempts++;
      throw new Error('injected owner write failure');
    }
    return update(id, patch);
  };
  const sealer = new SessionSealer(store);
  for (let n = 0; n < 8; n++) await sealer.reconcileAllStuck();
  assert.equal(attempts, 5);
  assert.deepEqual(store.getSealingRecoveryFacts(broken.id), {
    failures: 5,
    disposition: 'needs_attention',
    reasonCode: 'sealing_recovery_failed',
  });
  assert.equal(store.get(broken.id).status, 'sealing');
  assert.equal(store.get(healthy.id).status, 'sealed');
  assert.deepEqual(store.listSealingSessions(), []);
});
