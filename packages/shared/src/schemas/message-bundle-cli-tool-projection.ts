import { cleanCliToolLabel, projectCliToolUseLabel } from '../cli-tool-label.js';

/** Minimum provider-neutral shape needed to project one visible tool record. */
export interface CliToolProjectionEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  inputDetail?: string;
  executionRef?: string;
  toolUseId?: string;
  toolParentUseId?: string;
  status?: string;
}

function callKey(event: CliToolProjectionEvent): string | undefined {
  return event.toolUseId
    ? JSON.stringify([event.executionRef ?? '', event.toolParentUseId ?? '', event.toolUseId])
    : undefined;
}

/** Fold terminal input into its keyed call, keeping IDs/counts and legacy events intact. */
export function withFinalizedCliToolInputs<T extends CliToolProjectionEvent>(events: readonly T[]): T[] {
  const projected = [...events];
  const pending = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    const key = callKey(event);
    if (!key) continue;
    if (event.type === 'tool_use') pending.set(key, index);
    else {
      const useIndex = pending.get(key);
      if (useIndex !== undefined && event.inputDetail !== undefined) {
        projected[useIndex] = { ...projected[useIndex], detail: event.inputDetail };
      }
      pending.delete(key);
    }
  }
  return projected;
}

/** One call as the v2 reply record paints it. */
export interface CliToolProjectionRow {
  id: string;
  label: string;
  detail?: string;
  failed: boolean;
  settled: boolean;
}

interface PendingCliToolCall {
  row: CliToolProjectionRow | null;
  key?: string;
  settled: boolean;
}

interface CliToolProjectionState {
  rows: CliToolProjectionRow[];
  byUseKey: Map<string, PendingCliToolCall>;
  pendingCalls: PendingCliToolCall[];
}

function appendCliToolUse(state: CliToolProjectionState, event: CliToolProjectionEvent): void {
  const key = callKey(event);
  const hidden = cleanCliToolLabel(event.label) === 'unknown';
  const row: CliToolProjectionRow | null = hidden
    ? null
    : {
        id: event.id,
        label: projectCliToolUseLabel(event.label, event.detail),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        failed: false,
        settled: false,
      };
  const pending: PendingCliToolCall = {
    row,
    ...(key ? { key } : {}),
    settled: false,
  };
  state.pendingCalls.push(pending);
  if (row) state.rows.push(row);
  if (key) state.byUseKey.set(key, pending);
}

function takeNextPendingCliToolCall(state: CliToolProjectionState): PendingCliToolCall | undefined {
  while (state.pendingCalls.length > 0) {
    const pending = state.pendingCalls.shift();
    if (pending && !pending.settled) return pending;
  }
  return undefined;
}

function appendCliToolResult(state: CliToolProjectionState, event: CliToolProjectionEvent): void {
  const key = callKey(event);
  const pending = key ? state.byUseKey.get(key) : takeNextPendingCliToolCall(state);
  if (!pending) return;
  pending.settled = true;
  if (pending.key) state.byUseKey.delete(pending.key);
  if (!pending.row) return;
  if (event.detail !== undefined) pending.row.detail = event.detail;
  pending.row.failed = event.status === 'error';
  pending.row.settled = true;
}

/**
 * Canonical keyed/FIFO pairing for the v2 reply record and its versioned quote
 * plane. Hidden calls keep their FIFO slot; keyed orphan results fail closed.
 */
export function projectCliToolEventRows(events: readonly CliToolProjectionEvent[]): CliToolProjectionRow[] {
  const state: CliToolProjectionState = { rows: [], byUseKey: new Map(), pendingCalls: [] };
  for (const event of withFinalizedCliToolInputs(events)) {
    if (event.type === 'tool_use') appendCliToolUse(state, event);
    else appendCliToolResult(state, event);
  }
  return state.rows;
}
