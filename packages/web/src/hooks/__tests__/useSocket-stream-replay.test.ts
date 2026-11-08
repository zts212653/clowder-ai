/**
 * PR-3a2 (contract §3.11.1): a stream replay is applied only together with the join confirmation
 * it was sent under, and in the same ordered queue as the live events around it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { writeStoredSnapshot, writeStreamText } from '../named-message-writer';
import { type StreamReplay, StreamReplayItem } from '../response-stream-replay';
import { createAgentMessageCoalescer } from '../useSocket-message-coalescer';
import { createStreamReplayRelay, dispatchAgentQueueItem } from '../useSocket-stream-replay';

const T = 'relay-thread';

function replayFor(joinId: string, threadId = T): StreamReplay {
  return { threadId, joinId, responses: [] };
}

describe('createStreamReplayRelay', () => {
  function relay() {
    const calls: string[] = [];
    const enqueued: StreamReplayItem[] = [];
    const subject = createStreamReplayRelay({
      runningResponses: () => new Set(),
      enqueue: (item) => {
        calls.push(`enqueue:${item.replay.joinId}`);
        enqueued.push(item);
      },
      beginRecovery: (threadId) => calls.push(`recovery:${threadId}`),
      requestCatchUp: (threadId) => calls.push(`catch-up:${threadId}`),
    });
    return { subject, calls, enqueued };
  }

  it('applies a replay with the confirmation of the join it was sent under', () => {
    const { subject, calls } = relay();
    subject.received(replayFor('j1'));
    subject.confirmed(`thread:${T}`, { joinId: 'j1', firstInNeededPeriod: true });
    // Pending first, so the replay's rebuild clears the marks of the replies it holds.
    expect(calls).toEqual([`recovery:${T}`, 'enqueue:j1', `catch-up:${T}`]);
  });

  it('drops a replay sent for a join the page gave up on', () => {
    const { subject, calls } = relay();
    subject.received(replayFor('j1'));
    subject.received(replayFor('j2'));
    subject.confirmed(`thread:${T}`, { joinId: 'j1', firstInNeededPeriod: false });
    expect(calls).toEqual([`catch-up:${T}`]);
    subject.confirmed(`thread:${T}`, { joinId: 'j2', firstInNeededPeriod: false });
    expect(calls).toEqual([`catch-up:${T}`, `catch-up:${T}`]);
  });

  it('applies nothing for an older server that names no join, and still catches up', () => {
    const { subject, calls } = relay();
    subject.confirmed(`thread:${T}`, { firstInNeededPeriod: true });
    expect(calls).toEqual([`recovery:${T}`, `catch-up:${T}`]);
  });

  it('forgets replays of a lost connection and ignores rooms other than threads', () => {
    const { subject, calls } = relay();
    subject.received(replayFor('j1'));
    subject.reset();
    subject.confirmed(`thread:${T}`, { joinId: 'j1', firstInNeededPeriod: false });
    subject.confirmed('workspace:global', { firstInNeededPeriod: true });
    expect(calls).toEqual([`catch-up:${T}`]);
  });

  it('ignores a payload that is not a replay', () => {
    const { subject, calls } = relay();
    subject.received({ threadId: T });
    subject.received(null);
    subject.confirmed(`thread:${T}`, { joinId: 'undefined', firstInNeededPeriod: false });
    expect(calls).toEqual([`catch-up:${T}`]);
  });
});

describe('dispatchAgentQueueItem', () => {
  beforeEach(() => {
    useChatStore.setState({ currentThreadId: 'elsewhere', messages: [], threadStates: {} });
  });

  it('keeps a replay in order with the live events around it', async () => {
    const response = {
      id: 'r',
      type: 'assistant',
      catId: 'opus',
      origin: 'stream',
      content: '',
      timestamp: 1,
      isStreaming: true,
      lifecycle: {
        kind: 'response',
        orderKey: '1:turn',
        invocationId: 'turn',
        targetId: 'opus',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 1,
      },
    } as ChatMessage;
    writeStoredSnapshot(T, response);
    const target = { threadId: T, messageId: 'r', catId: 'opus' };
    const onMessage = vi.fn((message: { content?: string }) =>
      writeStreamText(target, { content: message.content ?? '' }),
    );
    const queue = createAgentMessageCoalescer((item) => dispatchAgentQueueItem(item, onMessage));
    const text = (content: string) => ({ type: 'text', catId: 'opus', messageId: 'r', content, threadId: T });

    // X reached this connection before the join was confirmed (an earlier, timed-out join).
    queue.push(text('X|'));
    queue.push(
      new StreamReplayItem({
        threadId: T,
        joinId: 'j',
        responses: [
          {
            messageId: 'r',
            catId: 'opus',
            timestamp: 1,
            events: [text('A|'), text('X|')] as unknown as StreamReplay['responses'][0]['events'],
            complete: true,
            nextIndex: 2,
          },
        ],
      }),
    );
    queue.push(text('Y|'));
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();

    expect(
      useChatStore
        .getState()
        .getThreadState(T)
        .messages.find((message) => message.id === 'r')?.content,
    ).toBe('A|X|Y|');
    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});
