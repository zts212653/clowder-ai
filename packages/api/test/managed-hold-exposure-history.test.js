import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAgentReadableManagedHoldMessage,
  resolveThreadMessageVisibility,
} from '../dist/domains/cats/services/stores/visibility.js';

function wake() {
  return {
    id: 'previous-wake',
    userId: 'user-1',
    from: { kind: 'system', service: 'hold-ball' },
    threadId: 'thread-managed-owner',
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      meta: {
        managedHold: true,
        taskId: 'previous-task',
        threadId: 'thread-managed-owner',
        catId: 'opus',
        wakeWhen: true,
      },
    },
  };
}

test('managed wake publication depends on durable delivery, independently of read receipts', () => {
  const source = wake();
  const history = resolveThreadMessageVisibility({}, 'user-1');
  assert.equal(history(source), false);
  assert.equal(isAgentReadableManagedHoldMessage(source), false);
  assert.equal(resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, 'user-1')(source), true);
  for (const status of ['pending', 'read']) {
    const delivered = {
      ...source,
      deliveryStatus: 'delivered',
      lifecycle: {
        kind: 'input',
        dispatchRefs: [{ targetId: 'opus', inputRead: { status, ...(status === 'read' ? { at: 1350 } : {}) } }],
      },
    };
    assert.equal(history(delivered), true);
    assert.equal(isAgentReadableManagedHoldMessage(delivered), true);
  }
});

test('managed wake history preserves owner, hidden-trigger and typed source boundaries', () => {
  const source = { ...wake(), deliveryStatus: 'delivered' };
  assert.equal(resolveThreadMessageVisibility({}, 'other-owner')(source), false);
  const history = resolveThreadMessageVisibility({}, 'user-1');
  assert.equal(history({ ...source, extra: { scheduler: { hiddenTrigger: true } } }), false);
  assert.equal(
    history({ ...source, source: { ...source.source, meta: { ...source.source.meta, threadId: 'foreign' } } }),
    false,
  );
  assert.equal(history({ ...source, userId: 'scheduler' }), false);
  assert.equal(history({ ...source, source: { connector: 'hold-ball' } }), false);
});
