/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type { CatId, ConnectorSource, MessageContent, RichMessageExtra } from '@cat-cafe/shared';
import type { MessageMetadata } from '../../types.js';
import type { StoredToolEvent } from '../ports/MessageStore.js';

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

/** F22+F52: Parse extra field (contains rich blocks, stream metadata, cross-post origin) */
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

    return hasField ? result : undefined;
  } catch {
    return undefined;
  }
}

/** F97: Parse connector source field */
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
