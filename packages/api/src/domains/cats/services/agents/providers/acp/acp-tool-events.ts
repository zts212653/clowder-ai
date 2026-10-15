import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AcpSessionState } from './acp-event-transformer.js';
import { isRecord, toolResultText } from './acp-tool-content.js';

const log = createModuleLogger('acp-tool-events');
export interface AcpToolSnapshot {
  name?: string;
  input?: Record<string, unknown>;
  payload: NonNullable<AgentMessage['toolRawPayload']>;
}

/** Omission retains facts; raw null is a reported value, while experimental name null retains. */
function mergeSnapshot(inner: Record<string, unknown>, previous?: AcpToolSnapshot): AcpToolSnapshot {
  const snapshot: AcpToolSnapshot = { ...previous, payload: { ...previous?.payload } };
  const name = (inner.name !== undefined ? [inner.name] : [inner.toolName, inner.tool_name]).find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (name !== undefined) snapshot.name = name;
  else if (snapshot.name === undefined && typeof inner.title === 'string' && inner.title.length > 0)
    snapshot.name = inner.title;
  const input = [inner.rawInput, inner.toolInput, inner.input, inner.tool_input].find((value) => value !== undefined);
  if (input !== undefined) {
    snapshot.input = isRecord(input) ? input : { rawInput: input };
    snapshot.payload.rawInput = input;
  }
  if (inner.content !== undefined) snapshot.payload.content = inner.content;
  if (inner.rawOutput !== undefined) snapshot.payload.rawOutput = inner.rawOutput;
  return snapshot;
}

/** Shared ACP consumer; no DSH-specific dispatch, profile changes or module-level call state. */
export function transformAcpToolEvent(
  inner: Record<string, unknown>,
  catId: CatId,
  metadata: MessageMetadata,
  timestamp: number,
  state?: AcpSessionState,
): AgentMessage | AgentMessage[] | null {
  const id = typeof inner.toolCallId === 'string' && inner.toolCallId.length > 0 ? inner.toolCallId : undefined;
  // Fixed Claude bridge vendor extension; this is ancestry, never approval authority.
  const vendor = isRecord(inner._meta) && isRecord(inner._meta.claudeCode) ? inner._meta.claudeCode : undefined;
  const parent =
    typeof vendor?.parentToolUseId === 'string' && vendor.parentToolUseId ? vendor.parentToolUseId : undefined;
  const key = id ? JSON.stringify([parent ?? null, id]) : undefined;
  if (state && key && state.finalEmittedByCallId.has(key)) return null;
  const snapshot = mergeSnapshot(inner, key ? state?.toolCallsByCallId.get(key) : undefined);
  const known = Boolean(state && key && state.emittedToolUseByCallId.has(key));
  if (state && key) state.toolCallsByCallId.set(key, snapshot);
  if (!snapshot.name && !known && inner.sessionUpdate === 'tool_call') {
    log.warn({ toolCallId: id, keys: Object.keys(inner) }, 'ACP tool name unavailable');
  }
  const toolUse: AgentMessage = {
    type: 'tool_use',
    catId,
    metadata,
    timestamp,
    ...(id ? { toolUseId: id } : {}),
    ...(parent ? { toolParentUseId: parent } : {}),
    ...(snapshot.name !== undefined ? { toolName: snapshot.name } : {}),
    ...(snapshot.input !== undefined ? { toolInput: snapshot.input } : {}),
    ...(Object.keys(snapshot.payload).length ? { toolRawPayload: snapshot.payload } : {}),
  };
  const final = inner.status === 'completed' || inner.status === 'failed';
  if (!final) {
    if (known) return null;
    if (state && key) state.emittedToolUseByCallId.add(key);
    return toolUse;
  }
  const result: AgentMessage = {
    type: 'tool_result',
    catId,
    metadata,
    timestamp,
    ...(id ? { toolUseId: id } : {}),
    ...(parent ? { toolParentUseId: parent } : {}),
    ...(snapshot.name !== undefined ? { toolName: snapshot.name } : {}),
    ...(snapshot.input !== undefined ? { toolInput: snapshot.input } : {}),
    content: toolResultText(snapshot.payload),
    toolResultStatus: inner.status === 'failed' ? 'error' : 'ok',
    ...(Object.keys(snapshot.payload).length ? { toolRawPayload: snapshot.payload } : {}),
  };
  if (state && key) {
    state.emittedToolUseByCallId.add(key);
    state.finalEmittedByCallId.add(key);
    state.toolCallsByCallId.delete(key);
  }
  // Orphan final observations still produce a pair, with no fabricated name or ID.
  return known ? result : [toolUse, result];
}
