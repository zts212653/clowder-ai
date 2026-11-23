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

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidSubagentEntryFields(value: unknown, state: unknown): string[] {
  const child = asRecord(value);
  if (!child) return ['subagent_info.subagents[]'];
  const invalid = ['type_name', 'role', 'initial_prompt'].filter((key) => !isNonemptyString(child[key]));
  for (const key of ['conversation_id', 'log_uri']) {
    const required = key === 'conversation_id' && state === 'DONE';
    if ((required || child[key] != null) && !isNonemptyString(child[key])) invalid.push(key);
  }
  if (
    child.workspace_uris != null &&
    (!Array.isArray(child.workspace_uris) || child.workspace_uris.some((uri) => typeof uri !== 'string'))
  ) {
    invalid.push('workspace_uris');
  }
  return invalid.map((key) => `subagent_info.subagents[].${key}`);
}

/** AGY 1.5.12 invokes children through a distinct step type, carrying launch
 * declarations/receipts in subagent_info rather than tool_info. A receipt is
 * evidence of invocation only; it is not the child's task result.
 */
export function parseAgySubagentFields(value: unknown, state: unknown): ReturnType<typeof parseAgyToolFields> {
  const info = asRecord(value);
  const subagents = info?.subagents;
  let invalid: string[];
  if (!info || !Array.isArray(subagents) || subagents.length === 0) {
    invalid = ['subagent_info.subagents'];
  } else {
    invalid = subagents.flatMap((entry) => invalidSubagentEntryFields(entry, state));
  }
  const anomalies: AgyProtocolAnomaly[] = invalid.map((field) => ({
    kind: 'invalid_tool_evidence',
    detail: `unrecognized ${field}`,
  }));
  return {
    toolParameters: state === 'ACTIVE' && info ? info : null,
    toolOutput: state === 'DONE' && info ? JSON.stringify(info) : null,
    toolErrorMessage:
      anomalies.length > 0
        ? 'Native subagent invocation unconfirmed: unreadable launch evidence.'
        : state === 'ERROR'
          ? 'Native subagent invocation failed.'
          : null,
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
