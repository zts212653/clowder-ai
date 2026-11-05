import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { settleOwnedThread } from './browser/native-team-cleanup.mjs';

function fixture(snapshots) {
  const writes = [];
  const request = async (url, options, statuses) => {
    if (!options) return { executions: snapshots.shift() ?? [] };
    writes.push({ url, ...options, statuses });
    return {};
  };
  return { request, writes };
}
const live = (threadId, executionId = 'owned-execution') => ({
  threadId,
  cancelability: { state: 'cancelable', target: { kind: 'live_invocation', threadId, catId: 'pi', executionId } },
});
const options = { pause: async () => {} };

test('cleanup cancels only exact owned executions and converges over ended/replaced responses', async () => {
  const { request, writes } = fixture([
    [live('foreign'), live('owned', 'old')],
    [live('foreign'), live('owned', 'replacement')],
    [live('foreign')],
  ]);
  assert.equal((await settleOwnedThread(request, 'owned', options)).length, 2);
  assert.deepEqual(
    writes.map((write) => write.url),
    ['/api/threads/owned/executions/live/old/cancel', '/api/threads/owned/executions/live/replacement/cancel'],
  );
  assert.ok(writes.every((write) => write.method === 'POST' && write.statuses.includes(409)));
});
test('cleanup uses the existing managed-command owner for its own thread', async () => {
  const execution = {
    threadId: 'owned',
    cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'a/b' } },
  };
  const { request, writes } = fixture([[execution]]);
  await settleOwnedThread(request, 'owned', options);
  assert.equal(writes[0].url, '/api/callbacks/hold-ball/a%2Fb');
  assert.equal(writes[0].method, 'DELETE');
});
test('cleanup refuses inconsistent cross-thread capabilities', async () => {
  const execution = live('foreign');
  execution.threadId = 'owned';
  const { request, writes } = fixture([[execution]]);
  await assert.rejects(settleOwnedThread(request, 'owned', options), /cross-thread/);
  assert.deepEqual(writes, []);
});
test('noncancelable occupancy stays red instead of being killed by cat name or PID', async () => {
  const { request, writes } = fixture([
    [{ threadId: 'owned', cancelability: { state: 'not_cancelable', reason: 'foreign_principal' } }],
  ]);
  await assert.rejects(settleOwnedThread(request, 'owned', { timeoutMs: 0, pause: () => delay(5) }), /quiet state/);
  assert.deepEqual(writes, []);
});
test('cleanup requires three consecutive empty snapshots, retaining late scheduled work', async () => {
  const { request, writes } = fixture([[], [], [live('owned')], [], [], []]);
  await settleOwnedThread(request, 'owned', options);
  assert.equal(writes.length, 1);
});
test('successful journeys wait for natural completion without canceling legitimate returns', async () => {
  const { request, writes } = fixture([[live('owned')], [live('owned')], [], [], []]);
  assert.deepEqual(await settleOwnedThread(request, 'owned', { ...options, cancel: false }), []);
  assert.deepEqual(writes, []);
});
