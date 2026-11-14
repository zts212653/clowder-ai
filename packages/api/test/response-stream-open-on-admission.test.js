/**
 * PR-3a2 (contract §3.11.1): the Queue opens a response's stream record as soon as R is admitted,
 * before the route broadcasts anything into it, so a record never misses R's first event.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitLifecycleResponseFromAppendInput } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { harness, waitFor } from './helpers/issue1371-queue-harness.js';

test('an admitted response is recorded before its first broadcast', async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
  });
  const timeline = [];
  h.processor.deps.socketManager.openResponseStream = (response) => timeline.push(['open', response]);
  h.processor.deps.socketManager.broadcastAgentMessage = (message) => timeline.push(['broadcast', message]);
  const admittedIds = [];
  h.routeExecution.mock.mockImplementation(
    async function* (userId, _content, threadId, messageId, targets, _intent, options) {
      for (const catId of targets) {
        const childId = `stream-${catId}`;
        const admitted = await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId,
          invocationId: childId,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        admittedIds.push(admitted.responseMessageId);
        await options.onPromptMessagesExposed({
          threadId,
          userId,
          catId,
          invocationId: childId,
          messageIds: [messageId],
          seenAt: Date.now(),
        });
        yield { type: 'text', catId, invocationId: childId, content: 'first chunk', timestamp: Date.now() };
        await commitLifecycleResponseFromAppendInput(
          h.store,
          admitted.responseMessageId,
          childId,
          { status: 'completed', completedAt: Date.now() },
          {
            from: { kind: 'agent', catId },
            userId,
            threadId,
            content: 'first chunk',
            mentions: [],
            timestamp: Date.now(),
            extra: { stream: { invocationId: options.parentInvocationId, turnInvocationId: childId } },
          },
        );
        yield { type: 'done', catId, invocationId: childId, isFinal: true, timestamp: Date.now() };
      }
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

  assert.equal(admittedIds.length, 2);
  for (const responseId of admittedIds) {
    const openAt = timeline.findIndex(([kind, value]) => kind === 'open' && value.id === responseId);
    const firstBodyAt = timeline.findIndex(
      ([kind, value]) => kind === 'broadcast' && value.type === 'text' && value.messageId === responseId,
    );
    assert.ok(openAt >= 0, `record opened for ${responseId}`);
    assert.ok(firstBodyAt > openAt, `record opened before ${responseId} broadcasts its body`);
    const opened = timeline[openAt][1];
    assert.equal(opened.threadId, 'thread-1');
    assert.equal(opened.userId, 'user-1');
    assert.equal(opened.lifecycle.kind, 'response');
    assert.equal(opened.lifecycle.status, 'processing');
  }
});
