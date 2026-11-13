import type { CatId } from '@cat-cafe/shared';
import { formatRecallMeta } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { isRecallLookupTool } from '../../../tool-usage/derive-result-summary.js';
import { normalizeMcpToolName } from '../../../tool-usage/normalize-mcp-tool-name.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { AcpSessionState } from './acp-event-transformer.js';
import { isRecord, toolResultText } from './acp-tool-content.js';

const log = createModuleLogger('acp-tool-events');
export interface AcpToolSnapshot {
  name?: string;
  input?: Record<string, unknown>;
  payload: NonNullable<AgentMessage['toolRawPayload']>;
}

/** Optional update fields replace previous values; raw null/omission means unchanged. */
function mergeSnapshot(inner: Record<string, unknown>, previous?: AcpToolSnapshot): AcpToolSnapshot {
  const snapshot: AcpToolSnapshot = { ...previous, payload: { ...previous?.payload } };
  const name = [inner.name, inner.toolName, inner.tool_name].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (name !== undefined) snapshot.name = name;
  else if (snapshot.name === undefined && typeof inner.title === 'string' && inner.title.length > 0)
    snapshot.name = inner.title;
  const input = [inner.rawInput, inner.toolInput, inner.input, inner.tool_input].find((value) => value != null);
  if (input !== undefined) {
    snapshot.input = isRecord(input) ? input : { rawInput: input };
    snapshot.payload.rawInput = input;
  }
  if (inner.content != null) snapshot.payload.content = inner.content;
  if (inner.rawOutput != null) snapshot.payload.rawOutput = inner.rawOutput;
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
  if (state && id && state.finalEmittedByCallId.has(id)) return null;
  const snapshot = mergeSnapshot(inner, id ? state?.toolCallsByCallId.get(id) : undefined);
  const known = Boolean(state && id && state.emittedToolUseByCallId.has(id));
  if (state && id) state.toolCallsByCallId.set(id, snapshot);
  if (!snapshot.name && !known && inner.sessionUpdate === 'tool_call') {
    log.warn({ toolCallId: id, keys: Object.keys(inner) }, 'ACP tool name unavailable');
  }
  const toolUse: AgentMessage = {
    type: 'tool_use',
    catId,
    metadata,
    timestamp,
    ...(id ? { toolUseId: id } : {}),
    ...(snapshot.name !== undefined ? { toolName: snapshot.name } : {}),
    ...(snapshot.input !== undefined ? { toolInput: snapshot.input } : {}),
    ...(Object.keys(snapshot.payload).length ? { toolRawPayload: snapshot.payload } : {}),
  };
  const cancelled = inner.status === 'cancelled';
  const final = inner.status === 'completed' || inner.status === 'failed' || cancelled;
  if (!final) {
    if (known) return null;
    if (state && id) state.emittedToolUseByCallId.add(id);
    return toolUse;
  }
  const result: AgentMessage = {
    type: 'tool_result',
    catId,
    metadata,
    timestamp,
    ...(id ? { toolUseId: id } : {}),
    ...(snapshot.name !== undefined ? { toolName: snapshot.name } : {}),
    ...(snapshot.input !== undefined ? { toolInput: snapshot.input } : {}),
    content:
      cancelled && snapshot.name && isRecallLookupTool(normalizeMcpToolName(snapshot.name))
        ? formatRecallMeta({ resultStatus: 'cancelled', resultCount: null })
        : toolResultText(snapshot.payload),
    toolResultStatus: inner.status === 'failed' || cancelled ? 'error' : 'ok',
    ...(Object.keys(snapshot.payload).length ? { toolRawPayload: snapshot.payload } : {}),
  };
  if (state && id) {
    state.emittedToolUseByCallId.add(id);
    state.finalEmittedByCallId.add(id);
    state.toolCallsByCallId.delete(id);
  }
  // Orphan final observations still produce a pair, with no fabricated name or ID.
  return known ? result : [toolUse, result];
}

/** A known prompt termination ends the Host's wait for its still-open recall calls. */
export function* settlePendingAcpRecalls(
  state: AcpSessionState,
  catId: CatId,
  metadata: MessageMetadata,
  resultStatus: 'timeout' | 'cancelled',
): Iterable<AgentMessage> {
  for (const [toolUseId, snapshot] of state.toolCallsByCallId) {
    if (!snapshot.name || !isRecallLookupTool(normalizeMcpToolName(snapshot.name))) continue;
    if (!state.emittedToolUseByCallId.has(toolUseId)) continue;
    state.toolCallsByCallId.delete(toolUseId);
    state.finalEmittedByCallId.add(toolUseId);
    yield {
      type: 'tool_result',
      catId,
      metadata,
      timestamp: Date.now(),
      toolUseId,
      toolName: snapshot.name,
      toolInput: snapshot.input,
      toolResultStatus: 'error',
      content: formatRecallMeta({ resultStatus, resultCount: null }),
    };
  }
}
