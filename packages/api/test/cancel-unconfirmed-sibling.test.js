import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitLifecycleResponseFromAppendInput } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { harness, waitFor } from './helpers/issue1371-queue-harness.js';

for (const batch of [false, true])
  test(`unknown child does not swallow its confirmed healthy sibling terminal; batch=${batch}`, async (t) => {
    const h = await harness();
    t.after(async () => {
      h.processor.releaseExactTerminalExecutionOwner('thread-1', ['opus', 'codex'], 'inv-1');
      await h.app.close();
    });
    const responses = new Map(),
      emitted = [];
    h.processor.deps.socketManager.broadcastAgentMessage = (message) => emitted.push(message);
    h.routeExecution.mock.mockImplementation(
      async function* (userId, _content, threadId, messageId, targets, _intent, options) {
        for (const catId of targets) {
          const childId = `owned-${catId}`;
          const admitted = await options.onLifecycleInvocationStarted({
            userId,
            threadId,
            catId,
            invocationId: childId,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          responses.set(catId, admitted.responseMessageId);
          await options.onPromptMessagesExposed({
            userId,
            threadId,
            catId,
            invocationId: childId,
            messageIds: [messageId],
            seenAt: Date.now(),
          });
        }
        // The sibling's real lifecycle owner already committed completion; a later
        // batch cancellation cannot rewrite this immutable result or lose its event.
        await commitLifecycleResponseFromAppendInput(
          h.store,
          responses.get('codex'),
          'owned-codex',
          { status: 'completed', completedAt: Date.now() },
          {
            from: { kind: 'agent', catId: 'codex' },
            userId,
            threadId,
            content: 'known completed answer',
            mentions: [],
            timestamp: Date.now(),
            replyTo: messageId,
            extra: {
              causal: { kind: 'invocation_reply', triggerMessageId: messageId },
              stream: { invocationId: options.parentInvocationId, turnInvocationId: 'owned-codex' },
            },
          },
        );
        if (batch) h.tracker.cancelAll(threadId, userId, 'cancel_all');
        else h.tracker.cancel(threadId, 'opus', userId, 'user_cancel');
        yield {
          type: 'status',
          catId: 'opus',
          invocationId: 'owned-opus',
          providerTeardown: 'unconfirmed',
          content: 'owned unknown',
          timestamp: Date.now(),
        };
        yield {
          type: 'done',
          catId: 'codex',
          invocationId: 'owned-codex',
          messageId: responses.get('codex'),
          isFinal: false,
          timestamp: Date.now(),
        };
      },
    );
    const execute = h.processor.executeEntry.bind(h.processor);
    let execution;
    h.processor.executeEntry = (...args) => {
      execution = execute(...args);
      return execution;
    };
    h.releaseCreate();
    await h.processor.requestDrain('thread-1');
    await waitFor(() => execution !== undefined);
    await execution;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.records.get('inv-1')).status, 'running');
    assert.equal(h.store.getById(responses.get('opus')).lifecycle.status, 'processing');
    assert.equal(h.store.getById(responses.get('codex')).lifecycle.status, 'completed');
    assert.equal(emitted.filter((message) => message.providerTeardown === 'unconfirmed').length, 1);
    assert.equal(emitted.filter((message) => message.type === 'done' && message.catId === 'opus').length, 0);
    assert.equal(
      emitted.filter((message) => message.type === 'done' && message.catId === 'codex').length,
      1,
      'a confirmed sibling must still publish its own terminal while only the unknown binding remains occupied',
    );
  });
