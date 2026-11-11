import assert from 'node:assert/strict';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';

export async function publicationFixture(messages = new MessageStore()) {
  const input = (content, timestamp) => ({
    userId: 'owner',
    threadId: 'line',
    from: { kind: 'agent', catId: 'codex' },
    content,
    timestamp,
    mentions: [],
  });
  const early = (
    await messages.appendAndObservePriorFrontier({
      ...input('', 100),
      lifecycle: {
        kind: 'response',
        orderKey: '100:early',
        invocationId: 'source',
        targetId: 'codex',
        inputEntryIds: ['entry'],
        inputMessageIds: ['input'],
        status: 'processing',
        startedAt: 100,
      },
    })
  ).message;
  const baseline = await messages.append(input('BASELINE', 200));
  const between = [await messages.append(input('UNREAD_689', 210)), await messages.append(input('UNREAD_693', 220))];
  const body = '679🙂原文'.repeat(1100);
  assert.equal(
    (
      await messages.commitLifecycleResponseTerminal(early.id, {
        invocationId: 'source',
        status: 'completed',
        completedAt: 300,
        content: body,
        contentBlocks: [{ type: 'text', text: body }],
        mentions: [],
        origin: 'stream',
      })
    ).kind,
    'applied',
  );
  return { messages, input, early, baseline, between, body };
}
