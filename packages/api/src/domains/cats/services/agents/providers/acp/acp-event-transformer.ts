/**
 * ACP Event Transformer — maps AcpSessionUpdate → AgentMessage.
 *
 * Pure function, no side effects. Used by GeminiAcpAdapter to convert
 * ACP protocol events into the unified AgentMessage stream format.
 */

import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AcpSessionUpdate } from './types.js';

const log = createModuleLogger('acp-event-xform');

/** Extract tool name from ACP event, tolerating field name variants across CLI versions. */
function resolveToolName(inner: Record<string, unknown>): string | undefined {
  // camelCase (our original expectation)
  if (typeof inner.toolName === 'string') return inner.toolName;
  // plain "name" (observed in some Gemini CLI versions)
  if (typeof inner.name === 'string') return inner.name;
  // snake_case variant
  if (typeof inner.tool_name === 'string') return inner.tool_name;
  // "title" — observed in Gemini CLI v0.36 production payloads
  if (typeof inner.title === 'string') return inner.title;
  return undefined;
}

/** Extract tool input from ACP event, tolerating field name variants. */
function resolveToolInput(inner: Record<string, unknown>): Record<string, unknown> | undefined {
  if (inner.toolInput && typeof inner.toolInput === 'object') return inner.toolInput as Record<string, unknown>;
  if (inner.input && typeof inner.input === 'object') return inner.input as Record<string, unknown>;
  if (inner.tool_input && typeof inner.tool_input === 'object') return inner.tool_input as Record<string, unknown>;
  return undefined;
}

export function transformAcpEvent(
  update: AcpSessionUpdate,
  catId: CatId,
  metadata: MessageMetadata,
): AgentMessage | null {
  // Gemini CLI may send update fields nested under `update.update` (ACP spec)
  // or flat at the top level of notification params (observed in Gemini CLI v0.35.3).
  const inner = (update.update ?? update) as Record<string, unknown>;
  const sessionUpdate = inner.sessionUpdate as string | undefined;
  const content = inner.content as { type: string; text?: string } | undefined;
  if (!sessionUpdate) return null;
  const now = Date.now();

  // Raw event diagnostic: log non-text event types and any event with unexpected content structure.
  // Helps diagnose thread-specific failures where Gemini outputs metadata instead of real content.
  if (sessionUpdate !== 'agent_message_chunk' && sessionUpdate !== 'user_message_chunk') {
    log.debug(
      {
        catId,
        sessionUpdate,
        contentType: content?.type,
        contentTextLen: content?.text?.length,
        keys: Object.keys(inner),
      },
      'ACP event received',
    );
  }

  switch (sessionUpdate) {
    case 'agent_message_chunk':
      return {
        type: 'text',
        catId,
        content: content?.text ?? '',
        metadata,
        timestamp: now,
      };

    case 'agent_thought_chunk':
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'thinking', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'tool_call': {
      const toolName = resolveToolName(inner);
      const toolInput = resolveToolInput(inner);
      if (!toolName) {
        log.warn(
          { sessionUpdate, keys: Object.keys(inner), toolCallId: inner.toolCallId, kind: inner.kind },
          'tool_call: could not resolve toolName',
        );
      }
      return {
        type: 'tool_use',
        catId,
        toolName,
        toolInput,
        metadata,
        timestamp: now,
      };
    }

    case 'tool_call_update': {
      const toolName = resolveToolName(inner);
      return {
        type: 'tool_use',
        catId,
        toolName,
        content: content?.text,
        metadata,
        timestamp: now,
      };
    }

    case 'plan':
      return {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'plan', text: content?.text ?? '' }),
        metadata,
        timestamp: now,
      };

    case 'user_message_chunk':
      return null;

    default:
      return null;
  }
}
