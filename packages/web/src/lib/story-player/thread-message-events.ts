/**
 * F252 — Hub message history → replay transcript events.
 *
 * Session transcripts are per-cat runtime logs. They contain tools/thinking,
 * but they are not the canonical conversation timeline: user turns and other
 * cats live in the Hub message store. Thread/feature replay therefore uses Hub
 * messages as the primary narrative and keeps transcript-only system notices as
 * supplements.
 */

import { projectCanonicalBubbles } from '@/stores/bubble-projection';
import type { ChatMessage, MessageContent, ToolEvent } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';
import { mergeSessionEvents } from './merge-session-events';
import type { RawTranscriptEvent } from './types';

const HUB_SESSION_ID = 'hub-message-history';
const HUB_CLI_SESSION_ID = 'hub-message-history';

const TRANSCRIPT_PRIMARY_TYPES = new Set(['text', 'assistant', 'user', 'thinking', 'tool_use', 'tool_result']);

function messageTimestamp(message: ChatMessage): number {
  return getMessageTimelineOrderTime(message);
}

function normalizeProjectionTimestamp(message: ChatMessage): ChatMessage {
  const timestamp = messageTimestamp(message);
  return timestamp === message.timestamp ? message : { ...message, timestamp };
}

function textFromBlocks(blocks: MessageContent[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .filter((block): block is Extract<MessageContent, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function messageContent(message: ChatMessage): string {
  return message.content || textFromBlocks(message.contentBlocks);
}

function narrativeContent(message: ChatMessage, wasStreamOrigin: boolean): string {
  if (message.type !== 'assistant') return messageContent(message);
  return message.extra?.stream?.speechContent ?? (wasStreamOrigin ? '' : messageContent(message));
}

function cliStdoutContent(message: ChatMessage, wasStreamOrigin: boolean): string {
  if (message.type !== 'assistant') return '';
  return message.extra?.stream?.cliStdout ?? (wasStreamOrigin ? messageContent(message) : '');
}

function messageInvocationId(message: ChatMessage): string | undefined {
  if (message.extra?.isExplicitPost) return `hub-message:${message.id}`;
  if (message.origin === 'callback') return `hub-message:${message.id}`;
  return message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId ?? `hub-message:${message.id}`;
}

function messageSessionId(message: ChatMessage): string {
  return message.metadata?.sessionId ?? HUB_SESSION_ID;
}

function messageEventType(message: ChatMessage): 'assistant' | 'user' | 'system' {
  if (message.type === 'assistant') return 'assistant';
  if (message.type === 'user' || message.type === 'connector') return 'user';
  return 'system';
}

function isReplayableMessage(message: ChatMessage): boolean {
  if (message.type === 'summary') return false;
  return Boolean(messageContent(message) || message.thinking || message.toolEvents?.length);
}

function makeBaseEvent(
  message: ChatMessage,
  threadId: string,
  eventNo: number,
  timestamp: number,
  event: Record<string, unknown>,
): RawTranscriptEvent {
  const catId = message.catId;
  return {
    v: 1,
    t: timestamp,
    threadId,
    ...(catId ? { catId } : {}),
    sessionId: messageSessionId(message),
    cliSessionId: message.metadata?.sessionId ?? HUB_CLI_SESSION_ID,
    ...(messageInvocationId(message) ? { invocationId: messageInvocationId(message) } : {}),
    eventNo,
    event,
  };
}

function toolEventPayload(tool: ToolEvent): Record<string, unknown> {
  const toolUseId = tool.toolUseId;
  if (tool.type === 'tool_use') {
    return {
      type: 'tool_use',
      toolName: tool.label,
      ...(toolUseId ? { toolUseId } : {}),
      ...(tool.detail ? { toolInput: tool.detail } : {}),
    };
  }
  return {
    type: 'tool_result',
    ...(toolUseId ? { toolUseId } : {}),
    ...(tool.detail ? { content: tool.detail } : {}),
    ...(tool.status ? { status: tool.status } : {}),
  };
}

function collectStreamOriginMessageIds(messages: ChatMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message) => message.type === 'assistant' && message.origin === 'stream')
      .map((message) => message.id),
  );
}

function appendMessageEvent(
  events: RawTranscriptEvent[],
  message: ChatMessage,
  threadId: string,
  timestamp: number,
  content: string,
): void {
  if (!content) return;
  events.push(
    makeBaseEvent(message, threadId, events.length, timestamp, {
      type: messageEventType(message),
      content,
    }),
  );
}

function appendCliStdoutEvent(
  events: RawTranscriptEvent[],
  message: ChatMessage,
  threadId: string,
  timestamp: number,
  cliStdout: string,
): void {
  if (!cliStdout) return;
  events.push(
    makeBaseEvent(message, threadId, events.length, timestamp, {
      type: 'cli_stdout',
      content: cliStdout,
    }),
  );
}

function appendAssistantSupplementEvents(
  events: RawTranscriptEvent[],
  message: ChatMessage,
  threadId: string,
  timestamp: number,
): void {
  if (message.type !== 'assistant') return;
  if (message.thinking) {
    events.push(
      makeBaseEvent(message, threadId, events.length, timestamp, {
        type: 'thinking',
        content: message.thinking,
      }),
    );
  }

  for (const tool of message.toolEvents ?? []) {
    events.push(makeBaseEvent(message, threadId, events.length, timestamp, toolEventPayload(tool)));
  }
}

export function chatMessagesToTranscriptEvents(messages: ChatMessage[], threadId: string): RawTranscriptEvent[] {
  const events: RawTranscriptEvent[] = [];
  const streamOriginMessageIds = collectStreamOriginMessageIds(messages);
  const projectedMessages = projectCanonicalBubbles({ records: messages.map(normalizeProjectionTimestamp) }).messages;

  for (const message of projectedMessages) {
    if (!isReplayableMessage(message)) continue;

    const baseTimestamp = messageTimestamp(message);
    const wasStreamOrigin = streamOriginMessageIds.has(message.id);
    const content = narrativeContent(message, wasStreamOrigin);
    const cliStdout = cliStdoutContent(message, wasStreamOrigin);

    appendMessageEvent(events, message, threadId, baseTimestamp, content);
    appendCliStdoutEvent(events, message, threadId, baseTimestamp, cliStdout);
    appendAssistantSupplementEvents(events, message, threadId, baseTimestamp);
  }

  return mergeSessionEvents([events]);
}

export function isSupplementalTranscriptEvent(event: RawTranscriptEvent): boolean {
  const type = event.event.type;
  if (type === 'system_info' && isThinkingSystemInfo(event.event)) return false;
  return typeof type === 'string' && !TRANSCRIPT_PRIMARY_TYPES.has(type);
}

function isThinkingSystemInfo(event: Record<string, unknown>): boolean {
  const content = event.content;
  if (typeof content !== 'string') return false;
  try {
    const parsed = JSON.parse(content) as { type?: unknown };
    return parsed.type === 'thinking';
  } catch {
    return false;
  }
}

export function mergeHubMessagesWithTranscriptSupplements(
  messages: ChatMessage[],
  transcriptEvents: RawTranscriptEvent[],
  threadId: string,
): RawTranscriptEvent[] {
  const hubEvents = chatMessagesToTranscriptEvents(messages, threadId);
  if (hubEvents.length === 0) return mergeSessionEvents([transcriptEvents]);
  return mergeSessionEvents([hubEvents, transcriptEvents.filter(isSupplementalTranscriptEvent)]);
}
