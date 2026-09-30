import { type PlatformActionDef, type PlatformOperationStatus } from '../../HubConfigIcons';
import { type ActionPhase, type ResultState } from './ActionRendererParts';

export interface ActionApiResult {
  ok: boolean;
  render?: string;
  data?: unknown;
  label?: string;
  advance?: boolean;
}

/** A result the plugin marks as failed (`advance: false` or `data.status === 'error'`), with its message. */
function actionResultFailure(result: ActionApiResult): string | null {
  const data = result.data;
  const failedStatus = data !== null && typeof data === 'object' && 'status' in data && data.status === 'error';
  if (result.advance !== false && !failedStatus) return null;
  const message = data !== null && typeof data === 'object' && 'message' in data ? data.message : undefined;
  return typeof message === 'string' && message.length > 0 ? message : (result.label ?? 'Action failed');
}

/** Why an action call failed — the request itself, or a result the plugin marks as failed — or null. */
export function actionCallFailure(result: ActionApiResult | null): string | null {
  if (!result?.ok) return result?.label ?? 'Network error';
  return actionResultFailure(result);
}

export type ActionRendererTarget =
  | { readonly kind: 'connector'; readonly id: string }
  | { readonly kind: 'plugin'; readonly id: string };

function targetBasePath(target: ActionRendererTarget): string {
  const resource = target.kind === 'connector' ? 'connectors' : 'plugins';
  return `/api/${resource}/${encodeURIComponent(target.id)}`;
}

function actionUrl(target: ActionRendererTarget, operationName: string, actionId: string): string {
  return `${targetBasePath(target)}/actions/${encodeURIComponent(operationName)}/${encodeURIComponent(actionId)}`;
}

export function actionRequest(
  target: ActionRendererTarget,
  operationName: string,
  actionId: string,
  pendingValues?: Readonly<Record<string, string>>,
): { readonly url: string; readonly init: RequestInit } {
  const url = actionUrl(target, operationName, actionId);
  if (!pendingValues || Object.keys(pendingValues).length === 0) return { url, init: { method: 'POST' } };
  const body = target.kind === 'connector' ? { values: pendingValues } : pendingValues;
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/** F202 W2-3 h1 ④: a row action is invoked with the input of the row it acts on. */
export function rowActionRequest(
  target: ActionRendererTarget,
  operationName: string,
  actionId: string,
  input: Readonly<Record<string, string | number | boolean>>,
): { readonly url: string; readonly init: RequestInit } {
  return {
    url: actionUrl(target, operationName, actionId),
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) },
  };
}

export function operationResetRequest(
  target: ActionRendererTarget,
  operationName: string,
  currentAction: string,
): { readonly url: string; readonly init: RequestInit } {
  const url = `${targetBasePath(target)}/operations/${encodeURIComponent(operationName)}/reset`;
  if (target.kind === 'plugin') return { url, init: { method: 'POST' } };
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentAction }),
    },
  };
}

export function toResultState(r: ActionApiResult): ResultState {
  return { render: r.render ?? 'status', data: r.data, label: r.label };
}

const TERMINAL_POLL_STATUSES = new Set(['denied', 'error', 'expired']);

function getTerminalPollMessage(state: ResultState): string | null {
  if (state.render !== 'polling' || state.data == null || typeof state.data !== 'object') return null;
  const payload = state.data as { message?: unknown; status?: unknown };
  if (typeof payload.status !== 'string' || !TERMINAL_POLL_STATUSES.has(payload.status)) return null;
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message;
  return state.label ?? payload.status;
}

/** Determine what phase to enter when we land on a given action. */
export function phaseForAction(
  actionId: string | undefined,
  actions: PlatformActionDef[],
  disconnectId: string | undefined,
): ActionPhase {
  if (!actionId) return 'idle';
  if (disconnectId && actionId === disconnectId) return 'connected';
  const action = actions.find((a) => a.id === actionId);
  if (action?.render === 'polling') return 'polling';
  return 'idle';
}

export function deriveActionState(
  operation: PlatformOperationStatus,
  actions: PlatformActionDef[],
  configured: boolean | undefined,
  disconnectId: string | undefined,
  firstActionId: string | undefined,
): { currentActionId: string | undefined; lastResult: ResultState | undefined; phase: ActionPhase } {
  const persistedActionId = operation.currentAction;
  if (persistedActionId && disconnectId && persistedActionId === disconnectId && configured !== true) {
    return { currentActionId: firstActionId, lastResult: undefined, phase: 'idle' };
  }

  const currentActionId = persistedActionId ?? (configured ? disconnectId : undefined) ?? firstActionId;
  if (!operation.currentAction && configured && disconnectId) {
    return { currentActionId, lastResult: operation.lastResult, phase: 'connected' };
  }
  const initial = phaseForAction(operation.currentAction, actions, disconnectId);
  return {
    currentActionId,
    lastResult: operation.lastResult,
    phase: initial === 'idle' && operation.lastResult ? 'result' : initial,
  };
}

/** Classify a poll response into retry / continue / done with parsed state. */
export type PollVerdict =
  | { outcome: 'retry' }
  | { outcome: 'error'; message: string }
  | { outcome: 'terminal'; state: ResultState; message: string }
  | { outcome: 'continue'; state: ResultState }
  | { outcome: 'done'; state: ResultState };

export function classifyPollResult(raw: ActionApiResult | null, actionRender?: string): PollVerdict {
  if (!raw) return { outcome: 'retry' };
  if (!raw.ok) return { outcome: 'error', message: raw.label ?? 'Action failed' };
  const state = toResultState(raw);
  const terminalMessage = getTerminalPollMessage(state);
  if (terminalMessage) return { outcome: 'terminal', state, message: terminalMessage };
  if (raw.render === 'polling' || raw.render === actionRender) return { outcome: 'continue', state };
  return { outcome: 'done', state };
}
