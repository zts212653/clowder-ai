/**
 * TranscriptFormatter — F98 Gap 1
 * Formats raw TranscriptEvents into human-readable views.
 *
 * Views:
 * - chat: role/content pairs (filters out tool events)
 * - handoff: per-invocation summaries (meeting-minutes style)
 */

import type { TranscriptEvent } from './TranscriptReader.js';

export interface ChatMessage {
  role: string;
  content: string;
  timestamp: number;
  invocationId?: string;
}

export interface HandoffInvocationSummary {
  invocationId: string;
  /** Exact first raw event number when this is returned by the paged reader. */
  startEventNo?: number;
  eventCount: number;
  toolCalls: string[];
  errors: number;
  durationMs: number;
  keyMessages: string[];
}

// Production AgentMessage uses 'text'; raw NDJSON uses 'assistant'/'user'/'system'.
const MESSAGE_TYPES = new Set(['text', 'assistant', 'user', 'system']);
/** Map production event type → chat role. */
const TYPE_TO_ROLE: Record<string, string> = { text: 'assistant' };
const MAX_KEY_MESSAGE_LEN = 80;
const MAX_KEY_MESSAGES = 5;

/**
 * Chat view: extract role/content message pairs, skip tool events.
 */
export function formatEventsChat(events: TranscriptEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const evt of events) {
    const evtData = evt.event;
    const evtType = evtData.type as string | undefined;
    if (!evtType || !MESSAGE_TYPES.has(evtType)) continue;

    const content = extractTextContent(evtData);
    if (!content) continue;

    messages.push({
      role: TYPE_TO_ROLE[evtType] ?? evtType,
      content,
      timestamp: evt.t,
      ...(evt.invocationId ? { invocationId: evt.invocationId } : {}),
    });
  }

  return messages;
}

/**
 * Handoff view: group events by invocationId, produce per-invocation summaries.
 */
export function formatEventsHandoff(events: TranscriptEvent[]): HandoffInvocationSummary[] {
  const groups = new Map<string, TranscriptEvent[]>();

  for (const evt of events) {
    const key = evt.invocationId ?? '_unknown';
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(evt);
  }

  const summaries: HandoffInvocationSummary[] = [];
  for (const [invocationId, group] of groups) {
    const toolCalls: string[] = [];
    let errors = 0;
    const keyMessages: string[] = [];

    for (const evt of group) {
      const evtData = evt.event;
      const evtType = evtData.type as string | undefined;

      if (evtType === 'tool_use') {
        // Production AgentMessage uses toolName; raw NDJSON uses name.
        const name = (evtData.toolName ?? evtData.name) as string | undefined;
        if (name) toolCalls.push(name);
      }
      if (evtType === 'tool_result' && evtData.is_error) {
        errors++;
      }
      if (evtType === 'error') {
        errors++;
      }
      if ((evtType === 'text' || evtType === 'assistant') && keyMessages.length < MAX_KEY_MESSAGES) {
        const text = extractTextContent(evtData);
        if (text) {
          keyMessages.push(text.slice(0, MAX_KEY_MESSAGE_LEN));
        }
      }
    }

    const first = group[0];
    const last = group[group.length - 1];
    const firstT = first?.t ?? 0;
    const lastT = last?.t ?? 0;

    summaries.push({
      invocationId,
      eventCount: group.length,
      toolCalls: [...new Set(toolCalls)],
      errors,
      durationMs: lastT - firstT,
      keyMessages,
    });
  }

  return summaries;
}

function extractTextContent(evtData: Record<string, unknown>): string | undefined {
  const content = evtData.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter(
        (c): c is { type: string; text: string } =>
          typeof c === 'object' &&
          c !== null &&
          (c as Record<string, unknown>).type === 'text' &&
          typeof (c as Record<string, unknown>).text === 'string',
      )
      .map((c) => c.text);
    return textParts.length > 0 ? textParts.join('\n') : undefined;
  }
  return undefined;
}
