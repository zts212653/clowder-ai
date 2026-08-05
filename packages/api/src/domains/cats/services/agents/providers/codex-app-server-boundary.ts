import type { ProviderNativeFreshnessToolSurface } from '../../freshness/FreshnessAttentionEventLog.js';
import type { ProviderNativeSafeBoundary } from '../../freshness/FreshnessNoticeBroker.js';

export type CodexProtocolItemClassification =
  | 'safe_boundary'
  | 'intentional_non_boundary'
  | 'deferred_no_data'
  | 'unknown';

interface CodexThreadItemCensusEntry {
  classification: Exclude<CodexProtocolItemClassification, 'unknown'>;
  toolSurface?: ProviderNativeFreshnessToolSurface;
}

/**
 * Exhaustive against the installed app-server ThreadItem union. New variants
 * must be consciously classified before the census guard turns green.
 */
export const CODEX_THREAD_ITEM_CENSUS = {
  userMessage: { classification: 'intentional_non_boundary' },
  hookPrompt: { classification: 'intentional_non_boundary' },
  agentMessage: { classification: 'intentional_non_boundary' },
  plan: { classification: 'intentional_non_boundary' },
  reasoning: { classification: 'intentional_non_boundary' },
  commandExecution: { classification: 'safe_boundary', toolSurface: 'command_execution' },
  fileChange: { classification: 'safe_boundary', toolSurface: 'file_change' },
  mcpToolCall: { classification: 'safe_boundary', toolSurface: 'mcp_tool_call' },
  dynamicToolCall: { classification: 'safe_boundary', toolSurface: 'dynamic_tool_call' },
  collabAgentToolCall: { classification: 'safe_boundary', toolSurface: 'collab_agent_tool_call' },
  subAgentActivity: { classification: 'intentional_non_boundary', toolSurface: 'sub_agent_activity' },
  webSearch: { classification: 'deferred_no_data', toolSurface: 'web_search' },
  imageView: { classification: 'deferred_no_data', toolSurface: 'image_view' },
  sleep: { classification: 'deferred_no_data', toolSurface: 'sleep' },
  imageGeneration: { classification: 'deferred_no_data', toolSurface: 'image_generation' },
  enteredReviewMode: { classification: 'intentional_non_boundary' },
  exitedReviewMode: { classification: 'intentional_non_boundary' },
  contextCompaction: { classification: 'intentional_non_boundary' },
} as const satisfies Readonly<Record<string, CodexThreadItemCensusEntry>>;

const LEGACY_TOOL_SURFACES: Readonly<Record<string, ProviderNativeFreshnessToolSurface>> = {
  command_execution: 'command_execution',
  file_change: 'file_change',
  mcp_tool_call: 'mcp_tool_call',
  dynamic_tool_call: 'dynamic_tool_call',
  collab_agent_tool_call: 'collab_agent_tool_call',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeStatus(envelopeMethod: unknown, itemStatus: unknown): string {
  if (itemStatus === 'inProgress' || itemStatus === 'in_progress') return 'in_progress';
  if (
    itemStatus === 'completed' ||
    itemStatus === 'failed' ||
    itemStatus === 'declined' ||
    itemStatus === 'interrupted'
  ) {
    return itemStatus;
  }
  return envelopeMethod === 'item/completed'
    ? 'completed'
    : envelopeMethod === 'item/started'
      ? 'in_progress'
      : 'unknown';
}

export interface CodexProtocolItemObservation {
  itemType: string;
  status: string;
  classification: CodexProtocolItemClassification;
  toolSurface: ProviderNativeFreshnessToolSurface;
  boundedUnknownSample?: string;
}

export function classifyCodexProtocolItem(event: unknown): CodexProtocolItemObservation | null {
  const envelope = asRecord(event);
  if (envelope?.method !== 'item/started' && envelope?.method !== 'item/completed') return null;
  const item = asRecord(asRecord(envelope.params)?.item);
  const rawItemType = item?.type;
  if (typeof rawItemType !== 'string') return null;
  const known = CODEX_THREAD_ITEM_CENSUS[rawItemType as keyof typeof CODEX_THREAD_ITEM_CENSUS] as
    | CodexThreadItemCensusEntry
    | undefined;
  if (!known) {
    return {
      itemType: 'unknown',
      status: normalizeStatus(envelope.method, item?.status),
      classification: 'unknown',
      toolSurface: 'unknown',
      boundedUnknownSample: rawItemType.slice(0, 64),
    };
  }
  return {
    itemType: rawItemType,
    status: normalizeStatus(envelope.method, item?.status),
    classification: known.classification,
    toolSurface: known.toolSurface ?? 'other',
  };
}

export function assertCodexThreadItemCensus(installedItemTypes: readonly string[]): void {
  const expected = Object.keys(CODEX_THREAD_ITEM_CENSUS).sort();
  const actual = [...new Set(installedItemTypes)].sort();
  const missing = expected.filter((itemType) => !actual.includes(itemType));
  const unknown = actual.filter((itemType) => !expected.includes(itemType));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Codex app-server ThreadItem census drift: missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`,
    );
  }
}

export function classifyCodexAppServerToolSurface(event: unknown): ProviderNativeFreshnessToolSurface | null {
  const observation = classifyCodexProtocolItem(event);
  return observation?.classification === 'safe_boundary' ? observation.toolSurface : null;
}

export function classifyCodexSafeBoundary(event: unknown): ProviderNativeSafeBoundary | null {
  const envelope = asRecord(event);
  if (envelope?.method !== 'item/completed') return null;
  const params = asRecord(envelope.params);
  const threadId = params?.threadId;
  const turnId = params?.turnId;
  const observation = classifyCodexProtocolItem(event);
  if (typeof threadId !== 'string' || typeof turnId !== 'string') return null;
  if (!observation || observation.classification !== 'safe_boundary' || observation.status === 'in_progress')
    return null;
  return { threadId, turnId, toolSurface: observation.toolSurface };
}

/** `codex exec --json` exposes completion surfaces but has no steerable turn id. */
export function classifyCodexExecToolSurface(event: unknown): ProviderNativeFreshnessToolSurface | null {
  const record = asRecord(event);
  if (record?.type !== 'item.completed') return null;
  const item = asRecord(record.item);
  const itemType = item?.type;
  if (typeof itemType !== 'string') return null;
  const known = CODEX_THREAD_ITEM_CENSUS[itemType as keyof typeof CODEX_THREAD_ITEM_CENSUS] as
    | CodexThreadItemCensusEntry
    | undefined;
  if (known?.classification === 'safe_boundary') return known.toolSurface ?? null;
  return LEGACY_TOOL_SURFACES[itemType] ?? null;
}
