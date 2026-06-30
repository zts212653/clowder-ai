/**
 * F252 Phase E — ReplayEvent → ChatMessage Bridge
 *
 * Maps the replay engine's ReplayEvent into a ChatMessage-compatible shape
 * that Hub components (MessageBubble, ThinkingContent, CliOutputBlock) can render.
 *
 * This is a pure function (INV-6: referential transparency, INV-7: total mapping).
 * No state, no side effects.
 */

import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Output type — subset of ChatMessage that Hub rendering components need
// ---------------------------------------------------------------------------

export interface ReplayChatMessage {
  /** Unique id for React key + MessageBubble */
  id: string;
  /** ChatMessage-compatible type */
  type: 'user' | 'assistant' | 'system';
  /** Text content */
  content: string;
  /** Original timestamp (epoch ms) */
  timestamp: number;
  /** Cat actor ID (for avatar rendering) */
  catId?: string;
  /** Invocation grouping (for session boundary display) */
  invocationId?: string;
  /** Source thread grouping (for feature theater multi-cam panels) */
  sourceThreadId?: string;
  /** Always false — replayed events are never streaming */
  isStreaming: false;
  /** Tool call events (for CliOutputBlock rendering) */
  toolEvents?: Array<{
    id: string;
    name: string;
    input?: string;
    output?: string;
    isError?: boolean;
    status: 'completed' | 'error';
  }>;
  /** Extended thinking content (for ThinkingContent rendering) */
  thinking?: string;
}

// ---------------------------------------------------------------------------
// Role → ChatMessage type mapping
// ---------------------------------------------------------------------------

const ROLE_TO_TYPE: Record<string, ReplayChatMessage['type']> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bridge a ReplayEvent into a ChatMessage-compatible shape for Hub rendering.
 *
 * Invariants:
 * - INV-6: Same input → same output (pure function)
 * - INV-7: All ReplayEvent.type values produce a valid result (total function)
 */
export function bridgeReplayEvent(event: ReplayEvent): ReplayChatMessage {
  const base: Pick<
    ReplayChatMessage,
    'id' | 'timestamp' | 'catId' | 'invocationId' | 'sourceThreadId' | 'isStreaming'
  > = {
    id: `replay_${event.index}`,
    timestamp: event.timestamp,
    catId: event.catId,
    invocationId: event.invocationId,
    sourceThreadId: event.sourceThreadId,
    isStreaming: false,
  };

  switch (event.type) {
    case 'message':
      return {
        ...base,
        type: ROLE_TO_TYPE[event.role] ?? 'system',
        content: event.content,
      };

    case 'tool_call':
      return {
        ...base,
        type: 'assistant',
        content: '',
        toolEvents: [
          {
            id: `tool_${event.index}`,
            name: event.toolName ?? 'unknown',
            input: event.toolInput,
            output: event.toolResult,
            isError: event.toolIsError,
            status: event.toolIsError ? 'error' : 'completed',
          },
        ],
      };

    case 'thinking':
      return {
        ...base,
        type: 'assistant',
        content: '',
        thinking: event.content,
      };

    case 'system':
      return {
        ...base,
        type: 'system',
        content: event.content,
      };
  }
}

function appendText(existing: string | undefined, next: string | undefined): string {
  if (!next) return existing === undefined ? '' : existing;
  if (!existing) return next;
  return `${existing}\n\n${next}`;
}

function sameAssistantGroup(message: ReplayChatMessage, event: ReplayEvent): boolean {
  if (message.type !== 'assistant') return false;
  if (message.catId !== event.catId) return false;
  if (message.sourceThreadId !== event.sourceThreadId) return false;
  if (message.invocationId === undefined && event.invocationId === undefined) return true;
  return message.invocationId === event.invocationId;
}

function mergeAssistantEvent(message: ReplayChatMessage, event: ReplayEvent): void {
  const next = bridgeReplayEvent(event);
  message.content = appendText(message.content, next.content);
  const mergedThinking = appendText(message.thinking, next.thinking);
  message.thinking = mergedThinking === '' ? undefined : mergedThinking;
  if (next.toolEvents?.length) {
    const existingToolEvents = message.toolEvents === undefined ? [] : message.toolEvents;
    message.toolEvents = [...existingToolEvents, ...next.toolEvents];
  }
}

function isEmptySystemMessage(message: ReplayChatMessage): boolean {
  return message.type === 'system' && message.content.trim() === '';
}

/**
 * Bridge visible ReplayEvents into chat-like bubbles.
 *
 * The live Hub UI does not create one bubble per raw event: stream text,
 * thinking, and tool output from the same assistant turn are presented as one
 * assistant bubble. Replay keeps that shape here so cinematic playback looks
 * like the real conversation instead of a stack of tiny event fragments.
 */
export function buildReplayChatMessages(events: ReplayEvent[]): ReplayChatMessage[] {
  const messages: ReplayChatMessage[] = [];
  let activeAssistantIndex: number | null = null;

  for (const event of events) {
    const bridged = bridgeReplayEvent(event);

    if (isEmptySystemMessage(bridged)) {
      activeAssistantIndex = null;
      continue;
    }

    if (bridged.type !== 'assistant') {
      messages.push(bridged);
      activeAssistantIndex = null;
      continue;
    }

    const active = activeAssistantIndex == null ? undefined : messages[activeAssistantIndex];
    if (active && sameAssistantGroup(active, event)) {
      mergeAssistantEvent(active, event);
      continue;
    }

    messages.push(bridged);
    activeAssistantIndex = messages.length - 1;
  }

  return messages;
}
