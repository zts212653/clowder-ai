import type { AgyDeniedAction, AgyProtocolAnomaly } from './agy-stream-json-parser.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Absence is allowed for sparse updates; present unreadable evidence is never absence. */
export function parseAgyToolFields(value: unknown): {
  toolParameters: Record<string, unknown> | null;
  toolOutput: string | null;
  toolErrorMessage: string | null;
  anomalies: readonly AgyProtocolAnomaly[];
} {
  const anomalies: AgyProtocolAnomaly[] = [];
  const invalid = (field: string): void => {
    anomalies.push({ kind: 'invalid_tool_evidence', detail: `unrecognized ${field}` });
  };
  const info = asRecord(value);
  if (value != null && !info) invalid('tool_info');
  const parameters = asRecord(info?.parameters);
  if (info?.parameters != null && !parameters) invalid('tool_info.parameters');
  const output = typeof info?.output === 'string' ? info.output : null;
  if (info?.output != null && output === null) invalid('tool_info.output');
  const error = asRecord(info?.error);
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : null;
  if (info?.error != null && message === null) invalid('tool_info.error');
  return {
    toolParameters: parameters,
    toolOutput: output,
    toolErrorMessage:
      message ?? (anomalies.length > 0 ? 'Native tool result unconfirmed: unreadable tool evidence.' : null),
    anomalies,
  };
}

export function parseAgyResultFields(result: Record<string, unknown>): {
  error: string | null;
  deniedActions: readonly AgyDeniedAction[];
  anomalies: readonly AgyProtocolAnomaly[];
} {
  const anomalies: AgyProtocolAnomaly[] = [];
  const error = typeof result.error === 'string' ? result.error : null;
  if (result.error != null && error === null) {
    anomalies.push({ kind: 'invalid_result_evidence', detail: 'unrecognized result.error' });
  }
  const deniedActions: AgyDeniedAction[] = [];
  const denied = result.denied_actions;
  const invalidDenial = (): void => {
    anomalies.push({ kind: 'invalid_denial_evidence', detail: 'unrecognized result.denied_actions' });
  };
  if (denied != null) {
    if (!Array.isArray(denied)) invalidDenial();
    else {
      for (const entry of denied) {
        const record = asRecord(entry);
        if (!record || typeof record.action !== 'string' || !record.action.trim()) {
          invalidDenial();
          continue;
        }
        deniedActions.push({
          action: record.action,
          displayName: typeof record.display_name === 'string' ? record.display_name : record.action,
        });
      }
    }
  }
  return { error, deniedActions, anomalies };
}
