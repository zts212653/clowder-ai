import type { InvocationTrajectoryStatus } from '@cat-cafe/shared';
import { boundTimelineRows } from './invocation-trajectory-bounds';

export { reconcileInvocationSummary } from './invocation-trajectory-summary';

export interface RawTranscriptEvent {
  v: number;
  t: number;
  threadId: string;
  catId: string;
  sessionId: string;
  cliSessionId?: string;
  invocationId?: string;
  eventNo: number;
  event: Record<string, unknown>;
}

interface TimelineRowBase {
  id: string;
  timestamp: number;
}

export type InvocationTimelineRow =
  | (TimelineRowBase & { kind: 'status-group'; count: number; types: Record<string, number> })
  | (TimelineRowBase & {
      kind: 'tool';
      toolName: string;
      toolUseId?: string;
      input?: unknown;
      result?: string;
      resultStatus?: 'ok' | 'error' | 'unknown';
      durationMs?: number;
      source: 'host_cli' | 'mcp' | 'plugin_connector' | 'unknown';
      channel: 'analysis' | 'commentary' | 'final' | 'unknown';
    })
  | (TimelineRowBase & {
      kind: 'message';
      role: 'user' | 'assistant' | 'system' | 'context';
      content: string;
      fragmentCount?: number;
      appendCount?: number;
      replaceCount?: number;
    })
  | (TimelineRowBase & { kind: 'error'; content: string })
  | (TimelineRowBase & { kind: 'terminal'; content: string })
  | (TimelineRowBase & { kind: 'session'; content: string })
  | (TimelineRowBase & { kind: 'system'; content: string })
  | (TimelineRowBase & { kind: 'overflow'; count: number; types: Record<string, number> });

export interface InvocationTimelineProjection {
  allRows: InvocationTimelineRow[];
  visibleRows: InvocationTimelineRow[];
  totalEffectiveRows: number;
  hiddenRowCount: number;
}

type ToolTimelineRow = Extract<InvocationTimelineRow, { kind: 'tool' }>;

interface TimelineBuildState {
  rows: InvocationTimelineRow[];
  toolRowsById: Map<string, ToolTimelineRow>;
  unmatchedTools: ToolTimelineRow[];
  foldedTypes: Record<string, number>;
  foldedTimestamp?: number;
}

const FOLDED_TELEMETRY_TYPES = new Set(['status', 'agent_loop', 'provider_signal', 'liveness_signal']);
const MESSAGE_TYPES = new Set(['text', 'assistant', 'user', 'system', 'context']);
const DEFAULT_MAX_VISIBLE_ROWS = 15;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function contentText(event: Record<string, unknown>): string | undefined {
  if (typeof event.content === 'string') return event.content;
  if (!Array.isArray(event.content)) return undefined;
  const parts = event.content.flatMap((part) => {
    const record = asRecord(part);
    return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function displaySystemInfo(event: Record<string, unknown>): string {
  if (typeof event.content !== 'string') return '系统信息';
  try {
    const payload = asRecord(JSON.parse(event.content));
    if (typeof payload?.type === 'string') return payload.type.replaceAll('_', ' ');
  } catch {
    // The original content is still useful when it is not structured JSON.
  }
  return event.content;
}

function toolResultText(event: Record<string, unknown>): string | undefined {
  const content = contentText(event);
  if (content) return content;
  if (event.toolResultStatus === 'ok') return 'ok';
  if (event.toolResultStatus === 'error') return 'error';
  return undefined;
}

function eventType(envelope: RawTranscriptEvent): string {
  return typeof envelope.event.type === 'string' ? envelope.event.type : 'unknown';
}

function toolSource(value: unknown): ToolTimelineRow['source'] {
  return value === 'host_cli' || value === 'mcp' || value === 'plugin_connector' ? value : 'unknown';
}

function toolChannel(value: unknown): ToolTimelineRow['channel'] {
  return value === 'analysis' || value === 'commentary' || value === 'final' ? value : 'unknown';
}

function toolResultStatus(event: Record<string, unknown>): NonNullable<ToolTimelineRow['resultStatus']> {
  if (event.toolResultStatus === 'ok' || event.toolResultStatus === 'error' || event.toolResultStatus === 'unknown') {
    return event.toolResultStatus;
  }
  if (typeof event.is_error === 'boolean') return event.is_error ? 'error' : 'ok';
  return 'unknown';
}

function appendToolUse(state: TimelineBuildState, envelope: RawTranscriptEvent): void {
  const toolName = envelope.event.toolName ?? envelope.event.name;
  const toolUseId = envelope.event.toolUseId ?? envelope.event.id;
  const row: ToolTimelineRow = {
    id: `tool-${envelope.eventNo}`,
    kind: 'tool',
    timestamp: envelope.t,
    toolName: typeof toolName === 'string' && toolName.length > 0 ? toolName : 'unknown',
    source: toolSource(envelope.event.toolSource),
    channel: toolChannel(envelope.event.toolChannel),
    ...(typeof toolUseId === 'string' ? { toolUseId } : {}),
    ...(envelope.event.toolInput !== undefined
      ? { input: envelope.event.toolInput }
      : envelope.event.input !== undefined
        ? { input: envelope.event.input }
        : {}),
  };
  state.rows.push(row);
  state.unmatchedTools.push(row);
  if (row.toolUseId) state.toolRowsById.set(row.toolUseId, row);
}

function findUnmatchedTool(
  state: TimelineBuildState,
  toolUseId: unknown,
  toolName: unknown,
): ToolTimelineRow | undefined {
  const exact = typeof toolUseId === 'string' ? state.toolRowsById.get(toolUseId) : undefined;
  if (exact) return exact;
  for (let index = state.unmatchedTools.length - 1; index >= 0; index -= 1) {
    const candidate = state.unmatchedTools[index];
    if (candidate && (typeof toolName !== 'string' || candidate.toolName === toolName)) return candidate;
  }
  return undefined;
}

function consumeToolResult(state: TimelineBuildState, envelope: RawTranscriptEvent): void {
  const toolUseId = envelope.event.toolUseId ?? envelope.event.tool_use_id;
  const toolName = envelope.event.toolName ?? envelope.event.name;
  const row = findUnmatchedTool(state, toolUseId, toolName);
  if (!row) {
    state.rows.push({
      id: `tool-result-${envelope.eventNo}`,
      kind: 'tool',
      timestamp: envelope.t,
      toolName: typeof toolName === 'string' && toolName.length > 0 ? toolName : 'unknown',
      source: toolSource(envelope.event.toolSource),
      channel: toolChannel(envelope.event.toolChannel),
      result: toolResultText(envelope.event),
      resultStatus: toolResultStatus(envelope.event),
    });
    return;
  }
  const unmatchedIndex = state.unmatchedTools.indexOf(row);
  if (unmatchedIndex >= 0) state.unmatchedTools.splice(unmatchedIndex, 1);
  if (row.toolUseId) state.toolRowsById.delete(row.toolUseId);
  row.result = toolResultText(envelope.event);
  row.resultStatus = toolResultStatus(envelope.event);
  if (row.toolName === 'unknown' && typeof toolName === 'string' && toolName.length > 0) row.toolName = toolName;
  if (row.source === 'unknown') row.source = toolSource(envelope.event.toolSource);
  if (row.channel === 'unknown') row.channel = toolChannel(envelope.event.toolChannel);
  row.durationMs = Math.max(0, envelope.t - row.timestamp);
}

function projectMessageEvent(
  envelope: RawTranscriptEvent,
  type: string,
): Extract<InvocationTimelineRow, { kind: 'message' }> | undefined {
  const content = contentText(envelope.event);
  if (!content) return undefined;
  const role = type === 'text' ? 'assistant' : type;
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'context') return undefined;
  const textMode = envelope.event.textMode === 'replace' ? 'replace' : 'append';
  return {
    id: `message-${envelope.eventNo}`,
    kind: 'message',
    timestamp: envelope.t,
    role,
    content,
    ...(role === 'assistant'
      ? {
          fragmentCount: 1,
          appendCount: textMode === 'append' ? 1 : 0,
          replaceCount: textMode === 'replace' ? 1 : 0,
        }
      : {}),
  };
}

function projectSimpleEvent(envelope: RawTranscriptEvent, type: string): InvocationTimelineRow | undefined {
  if (MESSAGE_TYPES.has(type)) return projectMessageEvent(envelope, type);
  if (type === 'error') {
    return {
      id: `error-${envelope.eventNo}`,
      kind: 'error',
      timestamp: envelope.t,
      content: typeof envelope.event.error === 'string' ? envelope.event.error : 'Invocation error',
    };
  }
  if (type === 'done') {
    return {
      id: `done-${envelope.eventNo}`,
      kind: 'terminal',
      timestamp: envelope.t,
      content: typeof envelope.event.errorCode === 'string' ? envelope.event.errorCode : 'done',
    };
  }
  if (type === 'session_init') {
    return {
      id: `session-${envelope.eventNo}`,
      kind: 'session',
      timestamp: envelope.t,
      content:
        typeof envelope.event.sessionId === 'string' ? `session ${envelope.event.sessionId}` : 'session initialized',
    };
  }
  if (type === 'system_info') {
    return {
      id: `system-${envelope.eventNo}`,
      kind: 'system',
      timestamp: envelope.t,
      content: displaySystemInfo(envelope.event),
    };
  }
  return undefined;
}

function appendMessageEvent(state: TimelineBuildState, envelope: RawTranscriptEvent, type: string): boolean {
  if (!MESSAGE_TYPES.has(type)) return false;
  const row = projectMessageEvent(envelope, type);
  if (!row) return true;
  const previous = state.rows.at(-1);
  if (row.role !== 'assistant' || previous?.kind !== 'message' || previous.role !== 'assistant') {
    state.rows.push(row);
    return true;
  }
  const mode = envelope.event.textMode === 'replace' ? 'replace' : 'append';
  previous.content = mode === 'replace' ? row.content : `${previous.content}${row.content}`;
  previous.fragmentCount = (previous.fragmentCount ?? 1) + 1;
  previous.appendCount = (previous.appendCount ?? 0) + Number(mode === 'append');
  previous.replaceCount = (previous.replaceCount ?? 0) + Number(mode === 'replace');
  return true;
}

function appendEnvelope(state: TimelineBuildState, envelope: RawTranscriptEvent): void {
  const type = eventType(envelope);
  if (FOLDED_TELEMETRY_TYPES.has(type)) {
    state.foldedTimestamp ??= envelope.t;
    state.foldedTypes[type] = (state.foldedTypes[type] ?? 0) + 1;
    return;
  }
  if (type === 'tool_use') {
    appendToolUse(state, envelope);
    return;
  }
  if (type === 'tool_result') {
    consumeToolResult(state, envelope);
    return;
  }
  if (appendMessageEvent(state, envelope, type)) return;
  const row = projectSimpleEvent(envelope, type);
  if (row) state.rows.push(row);
}

export function buildInvocationTimelineRows(
  events: readonly RawTranscriptEvent[],
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
): InvocationTimelineProjection {
  const state: TimelineBuildState = {
    rows: [],
    toolRowsById: new Map(),
    unmatchedTools: [],
    foldedTypes: {},
  };
  for (const envelope of events) appendEnvelope(state, envelope);

  const foldedCount = Object.values(state.foldedTypes).reduce((sum, count) => sum + count, 0);
  if (foldedCount > 0) {
    state.rows.unshift({
      id: 'status-group',
      kind: 'status-group',
      timestamp: state.foldedTimestamp ?? 0,
      count: foldedCount,
      types: state.foldedTypes,
    });
  }

  const { hiddenRowCount, visibleRows } = boundTimelineRows(state.rows, maxVisibleRows);
  return {
    allRows: state.rows,
    visibleRows,
    totalEffectiveRows: state.rows.length,
    hiddenRowCount,
  };
}

export function rankInvocationSummariesForRecall<
  T extends { invocationId: string; status: InvocationTrajectoryStatus; startedAt: number },
>(summaries: readonly T[]): T[] {
  const abnormal = (status: InvocationTrajectoryStatus) =>
    status === 'error' || status === 'cancelled' || status === 'timeout';
  return [...summaries]
    .sort((left, right) => {
      const abnormalDelta = Number(abnormal(right.status)) - Number(abnormal(left.status));
      return abnormalDelta || right.startedAt - left.startedAt || left.invocationId.localeCompare(right.invocationId);
    })
    .slice(0, 3);
}
