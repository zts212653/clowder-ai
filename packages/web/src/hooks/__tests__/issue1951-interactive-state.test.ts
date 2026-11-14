import { beforeEach, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { currentRecoveryGeneration } from '@/stores/thread-recovery';
import { writeStoredSnapshot } from '../named-message-writer';
import { applyResponseStreamReplay, type StreamReplay } from '../response-stream-replay';
import { issueReplaceRead, mergeReplaceHydrationMessages } from '../useChatHistory';

const threadId = 'question-thread';
const question = {
  id: 'async-question',
  kind: 'interactive' as const,
  v: 1 as const,
  interactiveType: 'select' as const,
  options: [{ id: 'custom', label: 'Other answer', customInput: true }],
};

function response(): ChatMessage {
  return {
    id: 'response',
    type: 'assistant',
    catId: 'codex',
    origin: 'stream',
    content: 'Work continues',
    timestamp: 100,
    isStreaming: true,
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn',
      invocationId: 'turn',
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
    extra: {
      stream: { invocationId: 'parent', turnInvocationId: 'turn' },
      rich: { v: 1, blocks: [{ ...question, disabled: true, selectedIds: ['custom'] }] },
    },
  };
}

function replay(): StreamReplay {
  return {
    threadId,
    joinId: 'join',
    responses: [
      {
        messageId: 'response',
        catId: 'codex',
        timestamp: 100,
        complete: true,
        nextIndex: 1,
        events: [
          {
            type: 'system_info',
            catId: 'codex',
            messageId: 'response',
            invocationId: 'parent',
            turnInvocationId: 'turn',
            content: JSON.stringify({ type: 'rich_block', block: question }),
            timestamp: 100,
          },
        ],
      },
    ],
  };
}

function shown() {
  return useChatStore
    .getState()
    .getThreadState(threadId)
    .messages.find((message) => message.id === 'response');
}

function expectAnswered(message = shown()) {
  const block = message?.extra?.rich?.blocks[0];
  expect(block?.kind).toBe('interactive');
  if (block?.kind !== 'interactive') throw new Error('Expected the question');
  expect(block.disabled).toBe(true);
  expect(block.selectedIds).toEqual(['custom']);
}

beforeEach(() => {
  useChatStore.setState({
    currentThreadId: 'other-thread',
    messages: [],
    threadStates: {},
    catInvocations: {},
    activeInvocations: {},
  });
});

it('#1951 keeps the saved answer when returning to a still-streaming response', () => {
  writeStoredSnapshot(threadId, response());
  applyResponseStreamReplay(replay());
  expectAnswered();
});

it('#1951 keeps the saved answer when History arrives after the original stream replay', () => {
  const issue = issueReplaceRead(threadId);
  applyResponseStreamReplay(replay());
  const merged = mergeReplaceHydrationMessages(
    [response()],
    useChatStore.getState().getThreadState(threadId).messages,
    {
      ...issue,
      landedInGeneration: currentRecoveryGeneration(threadId),
    },
  );
  expectAnswered(merged.messages[0]);
});
