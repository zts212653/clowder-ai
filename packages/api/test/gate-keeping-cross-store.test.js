import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');

describe('F167/F280 cross-store boundaries', () => {
  test('keeper ownership is same-thread only and fails closed on store errors', async () => {
    const noExisting = { getBySubject: async () => null };
    assert.equal(await verifyKeeperOwnership(noExisting, 'thread_1', 'external-subject:7'), 'keeper');

    const sameThread = { getBySubject: async () => ({ threadId: 'thread_1' }) };
    assert.equal(await verifyKeeperOwnership(sameThread, 'thread_1', 'external-subject:7'), 'keeper');

    const otherThread = { getBySubject: async () => ({ threadId: 'thread_2' }) };
    assert.equal(await verifyKeeperOwnership(otherThread, 'thread_1', 'external-subject:7'), 'distributed');

    const broken = {
      getBySubject: async () => {
        throw new Error('store unavailable');
      },
    };
    assert.equal(await verifyKeeperOwnership(broken, 'thread_1', 'external-subject:7'), 'distributed');
  });

  test('the parallel PR-tracker callback detector no longer exists', async () => {
    const module = await import('../dist/routes/gate-keeping-cross-store.js');
    assert.equal(Object.hasOwn(module, 'detectEventCallback'), false);
  });
});
