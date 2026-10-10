import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const postResultModule = import('../dist/domains/cats/services/agents/routing/callback-post-result.js');

describe('callback post result', () => {
  it('requires a durable message id before accepting a terminal acknowledgement', async () => {
    const { parseCallbackPostResult } = await postResultModule;

    assert.deepEqual(
      parseCallbackPostResult(
        'mcp:cat_cafe/cat_cafe_post_message (completed)\n' +
          '{"status":"terminal_ack_recorded","threadId":"thread-1","messageId":"message-1"}',
      ),
      { confirmed: true, messageId: 'message-1', threadId: 'thread-1' },
    );
    assert.deepEqual(parseCallbackPostResult('{"status":"terminal_ack_recorded","threadId":"thread-1"}'), {
      confirmed: false,
      threadId: 'thread-1',
    });
  });

  it('records each confirmed post as its own durable output and resets per turn', async () => {
    const { CallbackPostTracker } = await postResultModule;
    const persistedMessageIds = [];
    const tracker = new CallbackPostTracker((messageId) => persistedMessageIds.push(messageId));

    tracker.recordConfirmedPost({ confirmed: false, messageId: 'unconfirmed' });
    assert.equal(tracker.postConfirmed, false);

    tracker.recordConfirmedPost({ confirmed: true, messageId: 'callback-1', threadId: 'thread-1' });
    tracker.recordConfirmedPost({ confirmed: true, messageId: 'callback-2', threadId: 'thread-1' });
    assert.equal(tracker.postConfirmed, true);
    assert.equal(tracker.postMessageId, 'callback-2');
    assert.deepEqual(persistedMessageIds, ['callback-1', 'callback-2']);

    tracker.reset();
    assert.equal(tracker.postConfirmed, false);
    assert.equal(tracker.postMessageId, undefined);
  });
});
