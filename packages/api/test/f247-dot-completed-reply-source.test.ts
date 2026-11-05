import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDotCompletedReplySource } from '../src/domains/cats/services/cloud-bridge/dot/dot-completed-reply-source.js';
import { exposeDotAskToLive } from './helpers/f247-dot-live-lifecycle.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const scenario of [
  'adopted',
  'unread',
  'wrong-child',
  'wrong-response',
  'cross-user',
  'cross-thread',
  'wrong-recipient',
  'deleted',
  'recalled',
  'withdrawn',
  'stale-dispatch',
  'multiple-asks',
] as const) {
  test(`completed dot return uses canonical adoption: ${scenario}`, async () => {
    const f = await dotProactiveFixture();
    try {
      const thread = f.thread(scenario);
      const startedAt = Date.now();
      const ask = await f.ask(thread.id, 'first');
      const rootId = ask.result.structuredContent.messageId as string;
      const root = f.messages.getById(rootId);
      assert.ok(root);
      const { response, processor } = await exposeDotAskToLive(f, {
        threadId: thread.id,
        invocationId: 'current-child',
        messageId: rootId,
        startedAt,
      });
      assert.equal(response.lifecycle?.kind, 'response');
      const input = {
        messages: f.messages,
        responseMessageId: response.id,
        invocationId: 'current-child',
        userId: 'owner',
        threadId: thread.id,
        catId: 'codex',
        triggerMessageId: 'initial-human-source',
      };
      if (scenario === 'unread') {
        const unread = await f.ask(thread.id, 'unread');
        const id = unread.result.structuredContent.messageId as string;
        response.lifecycle!.inputMessageIds = [id];
      }
      if (scenario === 'wrong-child') input.invocationId = 'other-child';
      if (scenario === 'wrong-response') root.lifecycle!.dispatchRefs![0]!.statusMessageId = 'other-response';
      if (scenario === 'cross-user') root.userId = 'other-owner';
      if (scenario === 'cross-thread') root.threadId = 'other-thread';
      if (scenario === 'wrong-recipient') root.extra!.dotAsk!.recipientCatIds = ['sonnet'];
      if (scenario === 'deleted') root.deletedAt = Date.now();
      if (scenario === 'recalled') root.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
      if (scenario === 'withdrawn') root.lifecycle!.dispatchRefs = [];
      if (scenario === 'stale-dispatch') root.lifecycle!.dispatchRefs![0]!.dispatchedAt = startedAt - 1;
      if (scenario === 'multiple-asks') {
        const second = await f.ask(thread.id, 'second');
        const id = second.result.structuredContent.messageId as string;
        const entry = f.queue.list(thread.id, 'owner').find((item) => item.payload.messageId === id);
        assert.ok(entry);
        assert.equal(
          (
            await processor.adoptExposedQueuedEntries({
              threadId: thread.id,
              userId: 'owner',
              catId: 'codex',
              invocationId: 'current-child',
              entries: [{ entryId: entry.id, messageId: id }],
            })
          ).outcome,
          'adopted',
        );
      }
      assert.equal(
        await resolveDotCompletedReplySource(input),
        scenario === 'adopted' ? rootId : input.triggerMessageId,
        'one response may only bind one exact admitted consultation from this child',
      );
    } finally {
      await f.close();
    }
  });
}
