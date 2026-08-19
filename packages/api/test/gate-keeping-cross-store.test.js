import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { extractRepoAndNumber, verifyKeeperOwnership } = await import('../dist/routes/gate-keeping-cross-store.js');

describe('F167/F280 cross-store boundaries', () => {
  test('extractRepoAndNumber normalizes supported GitHub subject forms', () => {
    for (const [input, expected] of [
      ['pr:Owner/Repo#42', { repo: 'owner/repo', number: '42' }],
      ['issue:Owner/Repo#43', { repo: 'owner/repo', number: '43' }],
      ['https://github.com/Owner/Repo/pull/44', { repo: 'owner/repo', number: '44' }],
      ['Owner/Repo#45/comment/9', { repo: 'owner/repo', number: '45' }],
    ]) {
      assert.deepEqual(extractRepoAndNumber(input), expected);
    }
    assert.equal(extractRepoAndNumber('not a subject'), null);
  });

  test('keeper ownership is same-thread only and fails closed on store errors', async () => {
    const noExisting = { getBySubject: async () => null };
    assert.equal(await verifyKeeperOwnership(noExisting, 'thread_1', 'issue:owner/repo#7'), 'keeper');

    const sameThread = { getBySubject: async () => ({ threadId: 'thread_1' }) };
    assert.equal(await verifyKeeperOwnership(sameThread, 'thread_1', 'issue:owner/repo#7'), 'keeper');

    const otherThread = { getBySubject: async () => ({ threadId: 'thread_2' }) };
    assert.equal(await verifyKeeperOwnership(otherThread, 'thread_1', 'issue:owner/repo#7'), 'distributed');

    const broken = {
      getBySubject: async () => {
        throw new Error('store unavailable');
      },
    };
    assert.equal(await verifyKeeperOwnership(broken, 'thread_1', 'issue:owner/repo#7'), 'distributed');
  });

  test('the parallel PR-tracker callback detector no longer exists', async () => {
    const module = await import('../dist/routes/gate-keeping-cross-store.js');
    assert.equal(Object.hasOwn(module, 'detectEventCallback'), false);
  });
});
