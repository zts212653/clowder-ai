import { type PlatformActionDef, type PlatformOperationStatus } from '../../HubConfigIcons';
import { type ActionPhase, type ResultState } from './ActionRendererParts';

export interface ActionApiResult {
  ok: boolean;
  render?: string;
  data?: unknown;
  label?: string;
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
