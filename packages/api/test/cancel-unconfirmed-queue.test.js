import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, waitFor } from './helpers/issue1371-queue-harness.js';

for (const batch of [false, true])
  test(`the Queue owner retains an admitted unknown stop, including batch abort=${batch}`, async (t) => {
    const h = await harness();
    t.after(async () => {
      h.processor.releaseExactTerminalExecutionOwner('thread-1', ['opus', 'codex'], 'inv-1');
      await h.app.close();
    });
    const responses = [];
    const emitted = [];
    const completions = [];
    h.processor.deps.socketManager.broadcastAgentMessage = (message) => emitted.push(message);
    h.processor.registerEntryCompleteHook(h.entry.id, (...args) => completions.push(args));
    h.routeExecution.mock.mockImplementation(
      async function* (userId, _content, threadId, messageId, targets, _intent, options) {
        for (const catId of targets) {
          const childId = `unconfirmed-${catId}`;
          const admitted = await options.onLifecycleInvocationStarted({
            userId,
            threadId,
            catId,
            invocationId: childId,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          responses.push(admitted.responseMessageId);
          await options.onPromptMessagesExposed({
            userId,
            threadId,
            catId,
            invocationId: childId,
            messageIds: [messageId],
            seenAt: Date.now(),
          });
        }
        if (batch) h.tracker.cancelAll(threadId, userId, 'cancel_all');
        else
          targets.forEach((catId) => {
            h.tracker.cancel(threadId, catId, userId, 'user_cancel');
          });
        for (const catId of targets)
          yield {
            type: 'status',
            catId,
            invocationId: `unconfirmed-${catId}`,
            providerTeardown: 'unconfirmed',
            content: '停止尚未确认，执行绑定仍被占用',
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
    assert.equal((await h.records.get('inv-1')).status, 'running', 'local cancel is not the parent terminal');
    assert.equal(responses.length, 2);
    assert.equal(
      responses.every((id) => h.store.getById(id).lifecycle.status === 'processing'),
      true,
    );
    assert.equal(h.processor.isThreadBusy('thread-1'), true, 'the existing reservation remains fenced');
    assert.equal(completions.length, 0, 'unknown stop is not a completed task');
    assert.equal(emitted.filter((message) => message.providerTeardown === 'unconfirmed').length, 2);
  });
