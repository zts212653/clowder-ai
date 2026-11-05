import type { InvocationTimelineRow } from './invocation-trajectory-model';

type ToolRow = Extract<InvocationTimelineRow, { kind: 'tool' }>;

export function toolSource(value: unknown): ToolRow['source'] {
  return value === 'host_cli' || value === 'mcp' || value === 'plugin_connector' ? value : 'unknown';
}
export function toolChannel(value: unknown): ToolRow['channel'] {
  return value === 'analysis' || value === 'commentary' || value === 'final' ? value : 'unknown';
}
export function toolResultStatus(event: Record<string, unknown>): NonNullable<ToolRow['resultStatus']> {
  if (event.toolResultStatus === 'ok' || event.toolResultStatus === 'error' || event.toolResultStatus === 'unknown') {
    return event.toolResultStatus;
  }
  if (typeof event.is_error === 'boolean') return event.is_error ? 'error' : 'ok';
  return 'unknown';
}
