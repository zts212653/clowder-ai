import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../types.js';
import type { AgentSessionEvent } from './types.js';

export function projectSessionEvent(
  event: AgentSessionEvent,
  ctx: { catId: CatId; metadata: MessageMetadata },
): AgentMessage[] {
  const { metadata } = ctx;
  let message: Omit<AgentMessage, 'catId' | 'metadata' | 'timestamp'>;
  switch (event.type) {
    case 'native_bound':
      metadata.sessionId = event.nativeSessionId;
      message = {
        type: 'session_init',
        sessionId: event.nativeSessionId,
        nativeSessionBinding: event.nativeSessionBinding,
        ephemeralSession: event.ephemeralSession,
      };
      break;
    case 'context':
      if (Object.hasOwn(event, 'usage')) metadata.usage = event.usage;
      metadata.model = event.model ?? metadata.model;
      return [];
    case 'continuity':
    case 'compaction_observed':
    case 'input_read':
      return [];
    case 'output':
      message = { type: 'text', content: event.text, textMode: event.textMode };
      if (event.message)
        message.outputMessage = {
          ...event.message,
          provider: metadata.provider,
          runtimeSessionId: metadata.sessionId,
          turnId: event.turn.nativeTurnId,
        };
      break;
    case 'tool_call':
      message = {
        type: 'tool_use',
        toolName: event.name,
        toolUseId: event.callId,
        toolSource: event.source,
        toolRawPayload: event.rawPayload,
        toolInput: projectToolInput(event.input),
      };
      break;
    case 'tool_result':
      message = {
        type: 'tool_result',
        toolName: event.name,
        toolUseId: event.callId,
        toolSource: event.source,
        toolRawPayload: event.rawPayload,
        toolResultStatus: event.status,
        toolInput: projectToolInput(event.input),
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
      };
      break;
    case 'status':
      message = { type: 'status', content: event.detail ?? event.phase };
      break;
    case 'system_info':
    case 'provider_signal':
    case 'liveness_signal':
    case 'agent_loop':
      message = { type: event.type, content: event.content };
      break;
    case 'handoff':
      message = {
        type: 'a2a_handoff',
        content: event.content,
        targetCatId: event.targetCatId,
        routing: event.routing,
      };
      break;
    case 'error':
      message = { type: 'error', error: event.message, errorCode: event.code, errorDisposition: event.disposition };
      break;
    case 'done':
      message = {
        type: 'done',
        ...(event.outcome !== 'completed' ? { errorCode: event.errorCode ?? event.outcome } : {}),
      };
      break;
  }
  return [
    {
      ...message,
      catId: ctx.catId,
      metadata: { ...metadata, ...(Object.hasOwn(event, 'messageUsage') ? { usage: event.messageUsage } : {}) },
      timestamp: Date.now(),
    },
  ];
}

function projectToolInput(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}
