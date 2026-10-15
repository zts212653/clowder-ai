import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasNativeQueuedCancel, interruptIncludingQueued } from './claude-native-cancel.js';

test('W5.P atomic queued cancel uses the native request seam and returns its receipt', async () => {
  let publicCalls = 0;
  const wire: unknown[] = [];
  const query = {
    async interrupt() {
      publicCalls++;
    },
    async request(input: unknown) {
      wire.push(input);
      return { response: { still_queued: [], cancelled: ['notice'] } };
    },
  };
  assert.deepEqual(await interruptIncludingQueued(query, true), { still_queued: [], cancelled: ['notice'] });
  assert.deepEqual(wire, [{ subtype: 'interrupt', cancel_queued: true }]);
  assert.equal(publicCalls, 0);
});
for (const response of [
  undefined,
  {},
  { still_queued: ['notice'], cancelled: [] },
  { still_queued: [], cancelled: [1] },
  { still_queued: [], cancelled: null },
]) {
  test(`W5.P malformed or surviving-queue receipt cannot confirm cancellation: ${JSON.stringify(response)}`, async () => {
    const query = {
      async interrupt() {},
      async request() {
        return { response };
      },
    };
    await assert.rejects(interruptIncludingQueued(query, true), /receipt_invalid/);
  });
}
test('W5.P old SDK/native retains public interrupt semantics and does not advertise queued cancel', async () => {
  const legacy = {
    async interrupt() {
      return { still_queued: ['legacy'] };
    },
  };
  assert.equal(hasNativeQueuedCancel(legacy), false);
  assert.deepEqual(await interruptIncludingQueued(legacy, false), { still_queued: ['legacy'] });
  await assert.rejects(interruptIncludingQueued(legacy, true), /unsupported/);
});
