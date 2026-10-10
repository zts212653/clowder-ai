import type { ToolEvent } from '@/stores/chat-types';
import { extractRecallMetaDetail, toolResultDetail } from '@/utils/toolPreview';

/** Debug switch: receive file_change tool events without rendering their card. */
export const DEBUG_SKIP_FILE_CHANGE_UI = process.env.NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI === '1';

/** Short random suffix for ids of tool events and rows this client creates (never message identity). */
export function randomIdSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function safeJsonDetail(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    return raw ?? '[unserializable input]';
  } catch {
    return '[unserializable input]';
  }
}

interface ToolEventBase {
  id: string;
  catId: string;
  timestamp: number;
}

export function toolUseEvent(input: ToolEventBase & { toolName?: string; toolInput?: Record<string, unknown> }) {
  const detail = input.toolInput ? safeJsonDetail(input.toolInput) : undefined;
  const event: ToolEvent = {
    id: input.id,
    type: 'tool_use',
    label: `${input.catId} → ${input.toolName ?? 'unknown'}`,
    ...(detail ? { detail } : {}),
    timestamp: input.timestamp,
  };
  return event;
}

/** Tool output shown without the appended recall-meta block; the block travels as `resultMeta`. */
export function toolResultEvent(input: ToolEventBase & { content?: string }): ToolEvent {
  const raw = input.content ?? '';
  const resultMeta = extractRecallMetaDetail(raw);
  return {
    id: input.id,
    type: 'tool_result',
    label: `${input.catId} ← result`,
    detail: toolResultDetail(raw),
    ...(resultMeta ? { resultMeta } : {}),
    timestamp: input.timestamp,
  };
}

/** F045: web_search is shown as a tool call (privacy: the count only, never the query). */
export function webSearchEvent(input: ToolEventBase & { count: number }): ToolEvent {
  return {
    id: input.id,
    type: 'tool_use',
    label: `${input.catId} → web_search${input.count > 1 ? ` x${input.count}` : ''}`,
    timestamp: input.timestamp,
  };
}

/**
 * file_change diagnostics on the open thread: log receipt, and honour the debug switch that skips
 * the card. Returns true when the event must not be written.
 */
export function skipFileChangeCard(catId: string, detail: string | undefined): boolean {
  console.info('[agent_message] file_change tool_use received', {
    catId,
    skipUi: DEBUG_SKIP_FILE_CHANGE_UI,
    detail: detail ?? null,
  });
  if (!DEBUG_SKIP_FILE_CHANGE_UI) return false;
  console.warn('[agent_message] file_change UI append skipped', {
    catId,
    reason: 'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI=1',
  });
  return true;
}
