/**
 * opencode Event Transformer
 * opencode JSON event stream → Clowder AI AgentMessage 映射
 *
 * opencode `run --format json` NDJSON 事件格式:
 *   { type, timestamp, sessionID, part: { type, ... } }
 *
 * Event mapping:
 *   step_start → session_init (first occurrence establishes session)
 *   text       → text (part.text)
 *   tool_use   → tool_use (part.tool, part.state.input)
 *   error      → error (error.data.message or error.name)
 *   step_finish → null (cost/token metadata, skipped)
 *   Others     → null
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

interface OpenCodeEvent {
  type: string;
  timestamp: number;
  sessionID: string;
  part?: {
    type: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
    };
    [key: string]: unknown;
  };
  error?: {
    name?: string;
    data?: {
      message?: string;
      statusCode?: number;
      [key: string]: unknown;
    };
  };
}

function isOpenCodeEvent(event: unknown): event is OpenCodeEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return typeof e.type === 'string';
}

export function transformOpenCodeEvent(event: unknown, catId: CatId | string): AgentMessage | null {
  if (!isOpenCodeEvent(event)) return null;

  const ts = typeof event.timestamp === 'number' ? event.timestamp : Date.now();

  switch (event.type) {
    case 'step_start':
      return {
        type: 'session_init',
        catId: catId as CatId,
        sessionId: event.sessionID,
        timestamp: ts,
      };

    case 'text': {
      const text = event.part?.text;
      if (typeof text !== 'string' || text.length === 0) return null;
      return {
        type: 'text',
        catId: catId as CatId,
        content: text,
        timestamp: ts,
      };
    }

    case 'tool_use': {
      const msg: AgentMessage = {
        type: 'tool_use',
        catId: catId as CatId,
        toolName: event.part?.tool ?? 'unknown',
        timestamp: ts,
      };
      if (event.part?.state?.input) {
        msg.toolInput = event.part.state.input;
      }
      return msg;
    }

    case 'error': {
      const errorMsg = event.error?.data?.message ?? event.error?.name ?? 'opencode error';
      return {
        type: 'error',
        catId: catId as CatId,
        error: errorMsg,
        timestamp: ts,
      };
    }

    case 'step_finish':
      return null;

    default:
      return null;
  }
}
