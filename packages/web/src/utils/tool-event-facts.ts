import type { ToolEvent } from '@/stores/chat-types';

interface WireToolFacts {
  toolName?: string;
  toolUseId?: string;
  toolParentUseId?: string;
  toolResultStatus?: 'ok' | 'error' | 'unknown';
}
export function liveToolEventFacts(
  msg: WireToolFacts,
): Pick<ToolEvent, 'toolName' | 'toolUseId' | 'toolParentUseId' | 'status'> {
  return {
    ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
    ...(msg.toolUseId !== undefined ? { toolUseId: msg.toolUseId } : {}),
    ...(msg.toolParentUseId !== undefined ? { toolParentUseId: msg.toolParentUseId } : {}),
    ...(msg.toolResultStatus !== undefined
      ? { status: msg.toolResultStatus === 'ok' ? 'completed' : msg.toolResultStatus }
      : {}),
  };
}
