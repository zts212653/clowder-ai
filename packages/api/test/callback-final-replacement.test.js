import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const replacementModule = import('../dist/domains/cats/services/agents/routing/callback-final-replacement.js');

describe('callback final replacement boundary', () => {
  it('requires an explicit replacement disposition', async () => {
    const { readCallbackStreamDisposition } = await replacementModule;

    assert.equal(readCallbackStreamDisposition({ streamDisposition: 'replace_final' }), 'replace_final');
    assert.equal(readCallbackStreamDisposition('{"streamDisposition":"replace_final"}'), 'replace_final');
    assert.equal(readCallbackStreamDisposition({ streamDisposition: 'independent' }), 'independent');
    assert.equal(readCallbackStreamDisposition('{not json'), 'independent');
    assert.equal(readCallbackStreamDisposition('replace_final'), 'independent');
  });

  it('requires a durable message id before accepting a terminal acknowledgement', async () => {
    const { parseCallbackPostResult } = await replacementModule;

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

  it('owns confirmed callback and final-replacement state as one resettable unit', async () => {
    const { CallbackFinalReplacementTracker } = await replacementModule;
    const persistedMessageIds = [];
    const tracker = new CallbackFinalReplacementTracker((messageId) => persistedMessageIds.push(messageId));

    tracker.recordConfirmedPost('independent', {
      confirmed: true,
      messageId: 'callback-independent',
      threadId: 'thread-1',
    });
    assert.equal(tracker.postConfirmed, true);
    assert.equal(tracker.postMessageId, 'callback-independent');
    assert.equal(tracker.finalReplacementConfirmed, false);

    tracker.recordConfirmedPost('replace_final', {
      confirmed: true,
      messageId: 'callback-replacement',
      threadId: 'thread-1',
    });
    assert.equal(tracker.finalReplacementConfirmed, true);
    assert.equal(tracker.finalReplacementMessageId, 'callback-replacement');
    assert.deepEqual(persistedMessageIds, ['callback-independent', 'callback-replacement']);

    tracker.reset();
    assert.equal(tracker.postConfirmed, false);
    assert.equal(tracker.postMessageId, undefined);
    assert.equal(tracker.finalReplacementConfirmed, false);
    assert.equal(tracker.finalReplacementMessageId, undefined);
  });

  it('assembles all stream-only metadata for the canonical callback bubble', async () => {
    const { buildCallbackFinalReplacementMetadataPatch } = await replacementModule;
    const richBlock = { id: 'card-1', kind: 'card', v: 1, title: 'Card' };
    const toolEvent = { id: 'tool-1', type: 'tool_use', toolName: 'Read', timestamp: 1 };

    const patch = buildCallbackFinalReplacementMetadataPatch({
      thinkingChunks: ['first', 'second'],
      metadata: { provider: 'mock', model: 'mock-model' },
      toolEvents: [toolEvent],
      replyTo: 'trigger-message',
      mentionsUser: true,
      richBlocks: [richBlock],
      visibleTurnInvocationId: 'turn-invocation',
      persistedInvocationId: 'parent-invocation',
      turnTriggerMessageId: 'trigger-message',
      tracing: { traceId: 'trace-1', spanId: 'span-1' },
      executionProjections: {},
    });

    assert.equal(patch.thinking, 'first\n\n---\n\nsecond');
    assert.deepEqual(patch.metadata, { provider: 'mock', model: 'mock-model' });
    assert.deepEqual(patch.toolEvents, [toolEvent]);
    assert.equal(patch.replyTo, 'trigger-message');
    assert.equal(patch.mentionsUser, true);
    assert.deepEqual(patch.extra.rich, { v: 1, blocks: [richBlock] });
    assert.deepEqual(patch.extra.stream, {
      invocationId: 'parent-invocation',
      turnInvocationId: 'turn-invocation',
    });
    assert.deepEqual(patch.extra.causal, {
      kind: 'invocation_reply',
      triggerMessageId: 'trigger-message',
    });
    assert.deepEqual(patch.extra.tracing, { traceId: 'trace-1', spanId: 'span-1' });
  });
});
