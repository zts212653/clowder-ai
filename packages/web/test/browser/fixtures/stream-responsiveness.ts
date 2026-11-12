import { writeStreamText } from '../../../src/hooks/named-message-writer';
import { type StreamReplay, StreamReplayItem } from '../../../src/hooks/response-stream-replay';
import { createAgentMessageCoalescer } from '../../../src/hooks/useSocket-message-coalescer';
import { dispatchAgentQueueItem } from '../../../src/hooks/useSocket-stream-replay';
import type { ChatMessage } from '../../../src/stores/chat-types';
import { useChatStore } from '../../../src/stores/chatStore';

export async function measure(input: { count: number; replay?: StreamReplay; history?: number }) {
  const threadId = 'isolated-diagnostic-thread';
  const messageId = 'isolated-diagnostic-response';
  const target = { threadId, messageId, catId: 'diagnostic' };
  const messages: ChatMessage[] = Array.from({ length: input.history ?? 0 }, (_, index) => ({
    id: `history-${index}`,
    type: 'user',
    content: 'synthetic history',
    timestamp: index + 1,
  }));
  messages.push({
    id: messageId,
    type: 'assistant',
    catId: 'diagnostic',
    content: '',
    timestamp: 1,
    origin: 'stream',
    isStreaming: true,
  });
  useChatStore.setState({ currentThreadId: threadId, messages, threadStates: {} });
  let processed = 0;
  let finishedMs = 0;
  let maxFrameGap = 0;
  let frames = 0;
  let trackFrames = true;
  const started = performance.now();
  let lastFrame = started;
  const observeFrame = () => {
    const now = performance.now();
    maxFrameGap = Math.max(maxFrameGap, now - lastFrame);
    lastFrame = now;
    frames++;
    if (trackFrames) requestAnimationFrame(observeFrame);
  };
  requestAnimationFrame(observeFrame);
  const frame = new Promise<number>((resolve) => requestAnimationFrame(() => resolve(performance.now() - started)));
  const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
  let complete = () => {};
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const queue = createAgentMessageCoalescer((item) => {
    if (item instanceof StreamReplayItem) {
      const steps = dispatchAgentQueueItem(item, () => {
        throw new Error('Unexpected live dispatch');
      });
      return (function* () {
        if (steps) yield* steps;
        processed = input.count;
        finishedMs = performance.now() - started;
        complete();
      })();
    }
    writeStreamText(target, { content: 'x'.repeat(32) });
    if (++processed === input.count) {
      finishedMs = performance.now() - started;
      complete();
    }
  });
  if (input.replay) queue.push(new StreamReplayItem(input.replay));
  else Array.from({ length: input.count }, (_, index) => queue.push(index));
  await done;
  const [frameMs, timerMs] = await Promise.all([frame, timer]);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      trackFrames = false;
      resolve();
    }),
  );
  queue.dispose();
  const result = useChatStore.getState().getThreadState(threadId).messages.at(-1)!;
  return {
    processed,
    finishedMs,
    frameMs,
    timerMs,
    maxFrameGap,
    frames,
    body: { content: result.content, toolEvents: result.toolEvents },
  };
}
