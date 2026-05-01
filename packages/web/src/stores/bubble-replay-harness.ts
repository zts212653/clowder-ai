import type {
  BubbleEventType,
  BubbleInvariantViolation,
  BubbleKind,
  BubbleOriginPhase,
  BubbleSourcePath,
} from '@cat-cafe/shared';
import { findBubbleStoreInvariantViolations, validateIncomingBubbleEvent } from './bubble-invariants';
import type { ChatMessage } from './chat-types';

export interface BubbleEventFixture {
  type: BubbleEventType;
  threadId: string;
  actorId: string;
  canonicalInvocationId?: string;
  bubbleKind: BubbleKind;
  originPhase: BubbleOriginPhase;
  sourcePath: BubbleSourcePath;
  messageId?: string;
  seq?: number;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

export interface BubbleReplayState {
  messages: ChatMessage[];
}

export interface BubbleReplayReducerResult {
  messages: ChatMessage[];
  incomingMessage?: ChatMessage;
}

export type BubbleReplayReducer = (state: BubbleReplayState, event: BubbleEventFixture) => BubbleReplayReducerResult;

export interface BubbleReplayOptions {
  initialMessages?: ChatMessage[];
  initialMessagesByThread?: Record<string, ChatMessage[]>;
  reduceEvent?: BubbleReplayReducer;
}

export interface BubbleReplayResult {
  messages: ChatMessage[];
  violations: BubbleInvariantViolation[];
}

function noopReducer(state: BubbleReplayState): BubbleReplayReducerResult {
  return { messages: state.messages };
}

function flattenMessagesByThread(messagesByThread: Map<string, ChatMessage[]>): ChatMessage[] {
  return Array.from(messagesByThread.values()).flat();
}

const initialMessagesThreadId = '__initial__';

export function replayBubbleEvents(
  events: BubbleEventFixture[],
  options: BubbleReplayOptions = {},
): BubbleReplayResult {
  const reduceEvent = options.reduceEvent ?? noopReducer;
  const messagesByThread = new Map<string, ChatMessage[]>();
  for (const [threadId, messages] of Object.entries(options.initialMessagesByThread ?? {})) {
    messagesByThread.set(threadId, [...messages]);
  }
  if (options.initialMessages) {
    const threadId = events[0]?.threadId ?? initialMessagesThreadId;
    if (!messagesByThread.has(threadId)) messagesByThread.set(threadId, [...options.initialMessages]);
  }
  const violations: BubbleInvariantViolation[] = [];

  for (const event of events) {
    const threadMessages = messagesByThread.get(event.threadId) ?? [];
    const context = {
      threadId: event.threadId,
      eventType: event.type,
      originPhase: event.originPhase,
      sourcePath: event.sourcePath,
      seq: event.seq ?? null,
      timestamp: event.timestamp ?? 0,
    };
    const result = reduceEvent({ messages: threadMessages }, event);
    if (result.incomingMessage) {
      const incomingViolation = validateIncomingBubbleEvent(threadMessages, result.incomingMessage, context);
      if (incomingViolation) violations.push(incomingViolation);
    }

    messagesByThread.set(event.threadId, result.messages);
    violations.push(...findBubbleStoreInvariantViolations(result.messages, context));
  }

  return { messages: flattenMessagesByThread(messagesByThread), violations };
}
