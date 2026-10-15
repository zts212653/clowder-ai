import { randomUUID } from 'node:crypto';
import type { StoredToolEvent } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';

export function truncateDetail(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
/** Short UI projection; complete native facts remain in the canonical transcript/archive. */
export function toStoredToolEvent(
  msg: AgentMessage,
  executionRef = msg.turnInvocationId ?? msg.invocationId,
): StoredToolEvent | null {
  if (msg.type !== 'tool_use' && msg.type !== 'tool_result') return null;
  const prefix = msg.type === 'tool_use' ? 'tool-' : 'toolr-';
  if (!msg.toolEventId?.startsWith(prefix)) msg.toolEventId = `${prefix}${randomUUID()}`;
  if (executionRef) msg.toolExecutionRef = executionRef;
  const instance = { id: msg.toolEventId, ...(msg.toolExecutionRef ? { executionRef: msg.toolExecutionRef } : {}) };
  const identity = {
    ...(msg.toolUseId ? { toolUseId: msg.toolUseId } : {}),
    ...(msg.toolParentUseId ? { toolParentUseId: msg.toolParentUseId } : {}),
    ...(msg.toolName ? { toolName: msg.toolName } : {}),
    ...(msg.toolTracing ? { tracing: msg.toolTracing } : {}),
  };
  let inputDetail: string | undefined;
  if (msg.toolInput !== undefined) {
    try {
      inputDetail = truncateDetail(JSON.stringify(msg.toolInput), 200);
    } catch {
      inputDetail = '[unserializable]';
    }
  }
  if (msg.type === 'tool_use') {
    const toolName = msg.toolName ?? 'unknown';
    return {
      ...identity,
      ...instance,
      type: 'tool_use',
      label: `${msg.catId} → ${toolName}`,
      toolName,
      ...(inputDetail !== undefined ? { detail: inputDetail } : {}),
      timestamp: msg.timestamp,
      startTimeMs: msg.timestamp,
    };
  }
  const raw = (msg.content ?? '').trimEnd();
  return {
    ...identity,
    ...instance,
    type: 'tool_result',
    label: `${msg.catId} ← result`,
    detail: raw.length ? truncateDetail(raw, 1500) : '(no output)',
    ...(inputDetail !== undefined ? { inputDetail } : {}),
    timestamp: msg.timestamp,
    endTimeMs: msg.timestamp,
    ...(msg.toolResultStatus ? { status: msg.toolResultStatus } : {}),
  };
}
