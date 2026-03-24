/**
 * DARE Event Transformer
 * DARE headless envelope → Clowder AI AgentMessage 映射
 *
 * DARE headless envelope (client-headless-event-envelope.v1):
 *   { schema_version, ts, session_id, run_id, seq, event, data }
 *
 * Event mapping:
 *   session.started  → session_init
 *   tool.invoke      → tool_use
 *   tool.result      → tool_result
 *   tool.error       → tool_result (with error content)
 *   task.completed   → text (rendered_output is the agent's final answer)
 *   task.failed      → error
 *   approval.pending → system_info
 *   Others (log.*, transport.*, model.response, plan.*) → null (skip)
 */

import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

const DARE_SCHEMA = 'client-headless-event-envelope.v1';

interface DareEnvelope {
  schema_version: string;
  ts: number;
  session_id: string;
  run_id: string;
  seq: number;
  event: string;
  data: Record<string, unknown>;
}

function isDareEnvelope(event: unknown): event is DareEnvelope {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as Record<string, unknown>;
  return e.schema_version === DARE_SCHEMA && typeof e.event === 'string';
}

function str(val: unknown, fallback = ''): string {
  return typeof val === 'string' ? val : fallback;
}

export function transformDareEvent(event: unknown, catId: CatId | string): AgentMessage | null {
  if (!isDareEnvelope(event)) return null;

  const ts = typeof event.ts === 'number' ? Math.round(event.ts * 1000) : Date.now();
  const data = event.data ?? {};

  switch (event.event) {
    case 'session.started':
      return {
        type: 'session_init',
        catId: catId as CatId,
        sessionId: event.session_id,
        timestamp: ts,
      };

    case 'tool.invoke': {
      const msg: AgentMessage = {
        type: 'tool_use',
        catId: catId as CatId,
        toolName: str(data.tool_name, 'unknown'),
        timestamp: ts,
      };
      // Forward all available fields from DARE's tool.invoke event.
      // DARE emits: tool_call_id, capability_id, attempt, risk_level,
      // requires_approval, policy_decision, arguments (if present).
      const input: Record<string, unknown> = {};
      if (typeof data.tool_call_id === 'string') input.tool_call_id = data.tool_call_id;
      if (typeof data.capability_id === 'string') input.capability_id = data.capability_id;
      if (data.arguments != null && typeof data.arguments === 'object') {
        Object.assign(input, data.arguments as Record<string, unknown>);
      }
      if (Object.keys(input).length > 0) msg.toolInput = input;
      return msg;
    }

    case 'tool.result': {
      const resultContent =
        typeof data.output === 'string' && data.output.length > 0 ? data.output : `${str(data.tool_name)} completed`;
      return {
        type: 'tool_result',
        catId: catId as CatId,
        toolName: str(data.tool_name),
        content: resultContent,
        timestamp: ts,
      };
    }

    case 'tool.error':
      return {
        type: 'tool_result',
        catId: catId as CatId,
        toolName: str(data.tool_name),
        content: `Error: ${str(data.error, 'tool execution failed')}`,
        timestamp: ts,
      };

    case 'task.completed':
      return {
        type: 'text',
        catId: catId as CatId,
        content: str(data.rendered_output),
        timestamp: ts,
      };

    case 'task.failed': {
      let errorMsg: string;
      if (typeof data.error === 'string') {
        errorMsg = data.error;
      } else if (Array.isArray(data.errors)) {
        errorMsg = (data.errors as unknown[]).map(String).join('; ');
      } else {
        errorMsg = 'DARE task failed';
      }
      return {
        type: 'error',
        catId: catId as CatId,
        error: errorMsg,
        timestamp: ts,
      };
    }

    case 'approval.pending':
      return {
        type: 'system_info',
        catId: catId as CatId,
        content: `DARE approval pending: ${str(data.tool_name, 'unknown tool')}`,
        timestamp: ts,
      };

    default:
      return null;
  }
}
