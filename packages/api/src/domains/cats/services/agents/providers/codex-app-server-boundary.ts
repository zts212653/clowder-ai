import type { ProviderNativeFreshnessToolSurface } from '../../freshness/FreshnessAttentionEventLog.js';
import type { ProviderNativeSafeBoundary } from '../../freshness/FreshnessNoticeBroker.js';

const CODEX_TOOL_SURFACES: Readonly<Record<string, ProviderNativeFreshnessToolSurface>> = {
  commandExecution: 'command_execution',
  command_execution: 'command_execution',
  fileChange: 'file_change',
  file_change: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  mcp_tool_call: 'mcp_tool_call',
  dynamicToolCall: 'dynamic_tool_call',
  dynamic_tool_call: 'dynamic_tool_call',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export function classifyCodexAppServerToolSurface(event: unknown): ProviderNativeFreshnessToolSurface | null {
  const envelope = asRecord(event);
  if (envelope?.method !== 'item/started' && envelope?.method !== 'item/completed') return null;
  const params = asRecord(envelope.params);
  const item = asRecord(params?.item);
  const itemType = item?.type;
  return typeof itemType === 'string' ? (CODEX_TOOL_SURFACES[itemType] ?? null) : null;
}

export function classifyCodexSafeBoundary(event: unknown): ProviderNativeSafeBoundary | null {
  const envelope = asRecord(event);
  if (envelope?.method !== 'item/completed') return null;
  const params = asRecord(envelope.params);
  const threadId = params?.threadId;
  const turnId = params?.turnId;
  const toolSurface = classifyCodexAppServerToolSurface(event);
  if (typeof threadId !== 'string' || typeof turnId !== 'string') return null;
  if (!toolSurface) return null;
  return { threadId, turnId, toolSurface };
}

/** `codex exec --json` exposes the same completion surfaces but has no steerable turn id. */
export function classifyCodexExecToolSurface(event: unknown): ProviderNativeFreshnessToolSurface | null {
  const record = asRecord(event);
  if (record?.type !== 'item.completed') return null;
  const item = asRecord(record.item);
  const itemType = item?.type;
  return typeof itemType === 'string' ? (CODEX_TOOL_SURFACES[itemType] ?? null) : null;
}
