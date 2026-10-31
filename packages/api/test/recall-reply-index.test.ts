import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectRecallReplies } from '../src/routes/recall-reply-index.js';

test('reply index retains exact turn and parent identities without copying message content', () => {
  assert.deepEqual(
    projectRecallReplies([
      {
        id: 'm',

        catId: 'sonnet',
        timestamp: 100,
        extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
      },
    ]),
    [{ messageId: 'm', catId: 'sonnet', invocationId: 'turn', parentInvocationId: 'parent', timestamp: 100 }],
  );
});
test('reply index does not turn human, explicit post, or unbound messages into invocation replies', () => {
  const base = {
    id: 'm',

    catId: 'sonnet',
    timestamp: 100,
    extra: { stream: { invocationId: 'inv' } },
  };
  assert.deepEqual(
    projectRecallReplies([
      { ...base, catId: null },
      { ...base, extra: { ...base.extra, isExplicitPost: true } },
      { ...base, extra: undefined },
    ]),
    [],
  );
});

test('reply pagination uses the oldest canonical timeline coordinate, independent of array order', async () => {
  const { nextRecallReplyCursor } = await import('../src/routes/recall-reply-index.js');
  const messages = Array.from({ length: 500 }, (_, index) => ({
    id: `reply-${String(index).padStart(3, '0')}`,
    timestamp: 1000 + index,
    timelineOrderAt: index,
  }));
  assert.deepEqual(nextRecallReplyCursor(messages), { timestamp: 0, messageId: 'reply-000' });
  assert.deepEqual(nextRecallReplyCursor(messages.reverse()), { timestamp: 0, messageId: 'reply-000' });
});
