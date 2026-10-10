import { describe, expect, it } from 'vitest';
import { chatMessagesToTranscriptEvents } from '@/lib/story-player/thread-message-events';
import type { ChatMessage } from '../chat-types';
import { getOrderedMessageTimeline } from '../message-timeline';

describe('independent failed responses retain their durable identities', () => {
  it('keeps chronological private-input failures separate in current/history and replay', () => {
    const source: ChatMessage = {
      id: 'source-1',
      type: 'user',
      content: '@狸花猫 test',
      timestamp: 100,
      lifecycle: {
        kind: 'input',
        orderKey: '100:source-1',
        dispatchRefs: [{ targetId: 'tabby', phase: 'settled', statusMessageId: 'final-failure', dispatchedAt: 1_000 }],
      },
    };
    const auxiliaryFailure: ChatMessage = {
      id: 'aux-failure',
      type: 'assistant',
      catId: 'tabby',
      content: 'Error: first attempt',
      timestamp: 110,
      origin: 'stream',
      extra: {
        stream: { turnInvocationId: 'attempt-1' },
        freshness: { priorFrontierMessageId: source.id },
      },
      lifecycle: {
        kind: 'response',
        orderKey: '110:attempt-1',
        invocationId: 'attempt-1',
        targetId: 'tabby',
        inputEntryIds: ['aux-entry'],
        inputMessageIds: [],
        startedAt: 110,
        status: 'failed',
        completedAt: 115,
        reason: 'PROVIDER_EXECUTION_FAILED',
      },
    };
    const finalFailure: ChatMessage = {
      id: 'final-failure',
      type: 'assistant',
      catId: 'tabby',
      replyTo: source.id,
      content: 'Error: final attempt',
      timestamp: 120,
      origin: 'stream',
      extra: {
        stream: { turnInvocationId: 'attempt-2' },
        freshness: { priorFrontierMessageId: auxiliaryFailure.id },
      },
      lifecycle: {
        kind: 'response',
        orderKey: '120:attempt-2',
        invocationId: 'attempt-2',
        targetId: 'tabby',
        inputEntryIds: ['source-entry'],
        inputMessageIds: [source.id],
        startedAt: 120,
        status: 'failed',
        completedAt: 125,
        reason: 'PROVIDER_EXECUTION_FAILED',
      },
    };

    const messages = getOrderedMessageTimeline([source, auxiliaryFailure, finalFailure]);

    expect(messages.map((message) => message.id)).toEqual([source.id, auxiliaryFailure.id, finalFailure.id]);
    expect(messages.map((message) => message.content)).toEqual([
      source.content,
      auxiliaryFailure.content,
      finalFailure.content,
    ]);
    expect(messages[1]).toBe(auxiliaryFailure);
    expect(messages[2]).toBe(finalFailure);
    const replay = chatMessagesToTranscriptEvents([source, auxiliaryFailure, finalFailure], 'thread-1');
    expect(replay.filter((event) => event.event.content).map((event) => event.event.content)).toEqual([
      source.content,
      auxiliaryFailure.content,
      finalFailure.content,
    ]);
  });

  it('does not fold a prior failed response without the exact final source/ref/frontier chain', () => {
    const source: ChatMessage = { id: 'source-1', type: 'user', content: 'test', timestamp: 100 };
    const first: ChatMessage = {
      id: 'failure-1',
      type: 'assistant',
      catId: 'tabby',
      content: 'Error: unrelated',
      timestamp: 110,
      extra: { stream: { turnInvocationId: 'attempt-1' } },
      lifecycle: {
        kind: 'response',
        orderKey: '110:attempt-1',
        invocationId: 'attempt-1',
        targetId: 'tabby',
        inputEntryIds: ['entry-1'],
        inputMessageIds: [],
        startedAt: 110,
        status: 'failed',
        completedAt: 111,
      },
    };
    const second: ChatMessage = {
      ...first,
      id: 'failure-2',
      timestamp: 120,
      content: 'Error: final',
      extra: { stream: { turnInvocationId: 'attempt-2' } },
      lifecycle: {
        ...first.lifecycle!,
        orderKey: '120:attempt-2',
        invocationId: 'attempt-2',
      } as ChatMessage['lifecycle'],
    };

    expect(getOrderedMessageTimeline([source, first, second])).toHaveLength(3);
  });
});
