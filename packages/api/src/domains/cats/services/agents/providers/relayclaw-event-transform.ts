/**
 * RelayClaw Event Transformer
 *
 * relay-claw AgentResponseChunk → Clowder AI AgentMessage mapping.
 *
 * Mapping (event_type → AgentMessageType):
 *   chat.delta              → text   (streaming text fragment)
 *   chat.final              → (skip; completion marker only)
 *   chat.tool_call          → tool_use
 *   chat.tool_result        → tool_result
 *   chat.error              → error
 *   chat.processing_status  → system_info
 *   chat.ask_user_question  → system_info
 *   context.compressed      → (skip)
 *   todo.updated            → (skip)
 */

import type { CatId, RelayClawChunkPayload, RelayClawWsFrame } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

function msg(type: AgentMessage['type'], catId: CatId, content?: string): AgentMessage {
  return { type, catId, content, timestamp: Date.now() };
}

/**
 * Transform a single relay-claw WS chunk into an AgentMessage (or null to skip).
 */
export function transformRelayClawChunk(
  frame: RelayClawWsFrame,
  catId: CatId,
): AgentMessage | null {
  // connection.ack is handled at connection level, not yielded as a message
  if (frame.type === 'event' && frame.event === 'connection.ack') {
    return null;
  }

  const payload: RelayClawChunkPayload | null | undefined = frame.payload;
  if (!payload) return null;

  const eventType = payload.event_type;

  // Terminal chunk with no event_type — just marks stream end
  if (!eventType && payload.is_complete) return null;

  switch (eventType) {
    case 'chat.delta': {
      const content = payload.content;
      if (!content) return null;
      return msg('text', catId, content);
    }

    case 'chat.final': {
      return null;
    }

    case 'chat.tool_call': {
      const toolCall = payload.tool_call;
      if (!toolCall) return null;
      const toolName = (toolCall.name ?? toolCall.tool_name ?? 'unknown') as string;
      const toolInput = (toolCall.arguments ?? toolCall.input ?? toolCall) as Record<string, unknown>;
      return {
        type: 'tool_use',
        catId,
        toolName,
        toolInput,
        timestamp: Date.now(),
      };
    }

    case 'chat.tool_result': {
      const result = payload.result ?? '';
      return msg('tool_result', catId, typeof result === 'string' ? result : JSON.stringify(result));
    }

    case 'chat.error': {
      const error = payload.error ?? 'Unknown relay-claw error';
      return { type: 'error', catId, error, timestamp: Date.now() };
    }

    case 'chat.processing_status': {
      const status = payload.is_processing ? (payload.current_task ?? 'thinking') : 'idle';
      return msg('system_info', catId, `[processing] ${status}`);
    }

    case 'chat.ask_user_question': {
      const question = payload.content ?? JSON.stringify(payload);
      return msg('system_info', catId, question);
    }

    // Events we intentionally skip
    case 'context.compressed':
    case 'todo.updated':
    case 'chat.media':
    case 'chat.file':
    case 'chat.interrupt_result':
    case 'chat.subtask_update':
    case 'chat.session_result':
    case 'connection.ack':
      return null;

    default: {
      // Unknown event: extract content if present, otherwise skip
      const content = payload.content;
      if (content) return msg('text', catId, content);
      return null;
    }
  }
}
