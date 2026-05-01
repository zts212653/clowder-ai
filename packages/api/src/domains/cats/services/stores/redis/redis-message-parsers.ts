/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type { CatId, ConnectorSource, MessageContent, RichMessageExtra } from '@cat-cafe/shared';
import type { MessageMetadata } from '../../types.js';
import type { StoredMessage, StoredToolEvent } from '../ports/MessageStore.js';

export function safeParseMentions(raw: string | undefined): readonly CatId[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeParseToolEvents(raw: string | undefined): readonly StoredToolEvent[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseContentBlocks(raw: string | undefined): readonly MessageContent[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** F022+F052: Parse extra field (contains rich blocks, stream metadata, cross-post origin) */
export function safeParseExtra(raw: string | undefined):
  | {
      rich?: RichMessageExtra;
      stream?: { invocationId: string };
      crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
      scheduler?: {
        hiddenTrigger?: boolean;
        toast?: {
          type: 'success' | 'error' | 'info';
          title: string;
          message: string;
          duration: number;
          lifecycleEvent: 'registered' | 'paused' | 'resumed' | 'deleted' | 'succeeded' | 'failed' | 'missed_window';
        };
      };
      targetCats?: string[];
      tracing?: { traceId: string; spanId: string; parentSpanId?: string };
    }
  | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const result: {
      rich?: RichMessageExtra;
      stream?: { invocationId: string };
      crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
      scheduler?: {
        hiddenTrigger?: boolean;
        toast?: {
          type: 'success' | 'error' | 'info';
          title: string;
          message: string;
          duration: number;
          lifecycleEvent: 'registered' | 'paused' | 'resumed' | 'deleted' | 'succeeded' | 'failed' | 'missed_window';
        };
      };
      targetCats?: string[];
      tracing?: { traceId: string; spanId: string; parentSpanId?: string };
    } = {};
    let hasField = false;

    // Validate rich sub-field shape
    if (parsed.rich && typeof parsed.rich === 'object' && parsed.rich.v === 1 && Array.isArray(parsed.rich.blocks)) {
      result.rich = parsed.rich as RichMessageExtra;
      hasField = true;
    }

    // Validate stream sub-field shape (#80: draft dedup key)
    if (parsed.stream && typeof parsed.stream === 'object' && typeof parsed.stream.invocationId === 'string') {
      result.stream = { invocationId: parsed.stream.invocationId };
      hasField = true;
    }

    // F52: Validate crossPost sub-field shape
    if (
      parsed.crossPost &&
      typeof parsed.crossPost === 'object' &&
      typeof parsed.crossPost.sourceThreadId === 'string'
    ) {
      result.crossPost = {
        sourceThreadId: parsed.crossPost.sourceThreadId,
        ...(typeof parsed.crossPost.sourceInvocationId === 'string'
          ? { sourceInvocationId: parsed.crossPost.sourceInvocationId }
          : {}),
      };
      hasField = true;
    }

    // #481: Preserve scheduler sub-field (hiddenTrigger, toast) through Redis round-trip
    if (parsed.scheduler && typeof parsed.scheduler === 'object') {
      const sched: NonNullable<typeof result.scheduler> = {};
      if (parsed.scheduler.hiddenTrigger === true) sched.hiddenTrigger = true;
      if (parsed.scheduler.toast && typeof parsed.scheduler.toast === 'object') {
        sched.toast = parsed.scheduler.toast;
      }
      result.scheduler = sched;
      hasField = true;
    }

    // #481: Preserve targetCats sub-field through Redis round-trip
    if (Array.isArray(parsed.targetCats)) {
      result.targetCats = parsed.targetCats;
      hasField = true;
    }

    // F153-F: Preserve tracing pointer sub-field through Redis round-trip.
    // Stored as compact keys (t/s/p) to stay within AC-F6 100-byte budget.
    if (parsed.tracing && typeof parsed.tracing === 'object') {
      const tr = parsed.tracing;
      const t = tr.t ?? tr.traceId;
      const s = tr.s ?? tr.spanId;
      const p = tr.p ?? tr.parentSpanId;
      if (typeof t === 'string' && typeof s === 'string') {
        result.tracing = {
          traceId: t,
          spanId: s,
          ...(typeof p === 'string' ? { parentSpanId: p } : {}),
        };
        hasField = true;
      }
    }

    return hasField ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * F153-F: Serialize extra field with compact tracing keys (t/s/p)
 * to stay within AC-F6 100-byte budget per pointer.
 */
export function serializeExtra(extra: NonNullable<StoredMessage['extra']>): string {
  const { tracing, ...rest } = extra;
  if (!tracing) return JSON.stringify(extra);
  const compact: Record<string, string> = { t: tracing.traceId, s: tracing.spanId };
  if (tracing.parentSpanId) compact.p = tracing.parentSpanId;
  return JSON.stringify({ ...rest, tracing: compact });
}

/** F097: Parse connector source field */
export function safeParseConnectorSource(raw: string | undefined): ConnectorSource | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.connector === 'string' &&
      typeof parsed.label === 'string' &&
      typeof parsed.icon === 'string'
    ) {
      return parsed as ConnectorSource;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function safeParseMetadata(raw: string | undefined): MessageMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.provider === 'string' &&
      typeof parsed.model === 'string'
    ) {
      return parsed as MessageMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
