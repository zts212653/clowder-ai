import { normalizeMcpToolName } from '../../../domains/cats/services/tool-usage/normalize-mcp-tool-name.js';
import type {
  CapabilityName,
  CapabilityPreviewAvailability,
  CapabilityTraceInput,
  NormalizedCapabilityUsageCandidate,
  NormalizedTranscriptToolUse,
} from './eval-capability-wakeup-types.js';
import { CHANGE_TOOL_NAMES } from './eval-capability-wakeup-types.js';

export function normalizeTranscriptToolUse(
  eventNo: number,
  timestamp: number,
  invocationId: string,
  event: Record<string, unknown>,
): NormalizedTranscriptToolUse {
  const toolName =
    typeof event.toolName === 'string' ? event.toolName : typeof event.name === 'string' ? event.name : '';
  const toolInput =
    event.toolInput && typeof event.toolInput === 'object'
      ? (event.toolInput as Record<string, unknown>)
      : event.input && typeof event.input === 'object'
        ? (event.input as Record<string, unknown>)
        : undefined;
  const normalizedToolName = normalizeMcpToolName(toolName).toLowerCase();
  const referencedPaths = extractPaths(toolInput, normalizedToolName);
  const changedFiles = CHANGE_TOOL_NAMES.has(normalizedToolName) ? [...referencedPaths] : [];
  return {
    invocationId,
    eventNo,
    timestamp,
    toolName,
    normalizedToolName,
    ...(toolInput ? { toolInput } : {}),
    changedFiles,
    referencedPaths,
  };
}

export function normalizeToolUsageCandidate(
  event: CapabilityTraceInput['toolEvents'][number],
): NormalizedCapabilityUsageCandidate | null {
  const summary = event.summary as Record<string, unknown> | undefined;
  const command = typeof summary?.command === 'string' ? summary.command : '';
  const worktreeId = typeof summary?.worktreeId === 'string' ? (summary.worktreeId as string) : undefined;
  const path = readPath(summary);
  const action = typeof summary?.action === 'string' ? (summary.action as string) : undefined;
  const normalizedToolName = normalizeMcpToolName(event.toolName).toLowerCase();
  const directCapability = MCP_TOOL_CAPABILITY[normalizedToolName];
  if (directCapability) {
    return {
      source: 'tool',
      sourceId: `${event.invocationId}:${event.toolName}`,
      capability: directCapability,
      threadId: event.threadId,
      catId: event.catId,
      sessionId: event.sessionId,
      worktreeId,
      timestamp: event.timestamp,
      action,
      ...(path ? { path } : {}),
      successful: toolEventSucceeded(event),
    };
  }
  if (command.includes('/api/workspace/navigate')) {
    return {
      source: 'tool',
      sourceId: `${event.invocationId}:${event.toolName}`,
      capability: 'workspace-navigator',
      threadId: event.threadId,
      catId: event.catId,
      sessionId: event.sessionId,
      worktreeId,
      timestamp: event.timestamp,
      action,
      ...(path ? { path } : {}),
      successful: commandExecutionSucceeded(summary, 'workspace-navigator'),
    };
  }
  if (command.includes('/api/preview/auto-open')) {
    return {
      source: 'tool',
      sourceId: `${event.invocationId}:${event.toolName}`,
      capability: 'browser-preview',
      threadId: event.threadId,
      catId: event.catId,
      sessionId: event.sessionId,
      worktreeId,
      timestamp: event.timestamp,
      successful: commandExecutionSucceeded(summary, 'browser-preview'),
    };
  }
  return null;
}

const MCP_TOOL_CAPABILITY: Record<string, CapabilityName> = {
  create_rich_block: 'rich-messaging',
  workspace_navigate: 'workspace-navigator',
  preview_open: 'browser-preview',
  preview_auto_open: 'browser-preview',
  imagegen: 'image-generation',
  generate_image: 'image-generation',
  run_perspective: 'expert-panel',
  update_guide_state: 'guide-interaction',
  get_available_guides: 'guide-interaction',
  start_guide: 'guide-interaction',
  guide_control: 'guide-interaction',
  propose_thread: 'propose-thread',
  list_external_runtime_sessions: 'external-runtime-sessions',
  read_external_runtime_session: 'external-runtime-sessions',
  register_external_runtime_session: 'external-runtime-sessions',
  publish_verdict: 'eval-verdict',
  search_evidence: 'memory-drilldown',
  graph_resolve: 'memory-drilldown',
  list_recent: 'memory-drilldown',
  read_session_digest: 'memory-drilldown',
  read_session_events: 'memory-drilldown',
  read_invocation_detail: 'memory-drilldown',
  update_workflow: 'update-workflow',
  update_workflow_sop: 'update-workflow',
};

export function normalizeAuditCandidates(
  auditEvents: CapabilityTraceInput['auditEvents'],
): NormalizedCapabilityUsageCandidate[] {
  return (auditEvents ?? []).flatMap((event) => {
    const catId = typeof event.data?.catId === 'string' ? (event.data.catId as string) : undefined;
    const worktreeId = typeof event.data?.worktreeId === 'string' ? (event.data.worktreeId as string) : undefined;
    const path = typeof event.data?.path === 'string' ? (event.data.path as string) : undefined;
    const action = typeof event.data?.action === 'string' ? (event.data.action as string) : undefined;
    if (event.type === 'workspace_navigate') {
      return [
        {
          source: 'audit',
          sourceId: event.id,
          capability: 'workspace-navigator',
          threadId: event.threadId,
          catId,
          worktreeId,
          timestamp: event.timestamp,
          action,
          ...(path ? { path } : {}),
          successful: true,
        },
      ];
    }
    if (event.type === 'browser_preview_open') {
      return [
        {
          source: 'audit',
          sourceId: event.id,
          capability: 'browser-preview',
          threadId: event.threadId,
          catId,
          worktreeId,
          timestamp: event.timestamp,
          successful: true,
        },
      ];
    }
    return [];
  });
}

export function hasLivePreviewForInvocation(
  previewAvailability: CapabilityPreviewAvailability[] | undefined,
  worktreeId: string | undefined,
  startTime: number,
  endTime: number,
): boolean {
  return (previewAvailability ?? []).some((entry) => {
    if (!entry.hasLivePort) return false;
    if (entry.observedAt != null && (entry.observedAt < startTime || entry.observedAt > endTime)) return false;
    if (worktreeId) return entry.worktreeId === worktreeId;
    return true;
  });
}

export function readPath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const path = record.file_path ?? record.path;
  return typeof path === 'string' && path.trim() !== '' ? path : undefined;
}

function extractPaths(value: unknown, normalizedToolName: string): string[] {
  const directPath = readPath(value);
  if (directPath) return [directPath];
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (normalizedToolName !== 'file_change' || !Array.isArray(record.changes)) return [];
  const paths: string[] = [];
  for (const change of record.changes) {
    if (typeof change === 'string' && change.trim() !== '') {
      paths.push(change);
      continue;
    }
    if (change && typeof change === 'object') {
      const nested = readPath(change);
      if (nested) paths.push(nested);
    }
  }
  return paths;
}

function commandExecutionSucceeded(
  summary: Record<string, unknown> | undefined,
  capability: 'workspace-navigator' | 'browser-preview',
): boolean {
  if (!summary) return false;
  const exitCode = summary.exitCode;
  const shellSucceeded =
    (typeof exitCode === 'number' && exitCode === 0) || summary.status === 'success' || summary.status === 'completed';
  if (!shellSucceeded) return false;
  if (capability === 'workspace-navigator') {
    if (summary.ok === false) return false;
    return summary.ok === true || isHttpSuccess(summary);
  }
  if (summary.allowed === false || summary.ok === false) return false;
  return summary.allowed === true || isHttpSuccess(summary);
}

function toolEventSucceeded(event: CapabilityTraceInput['toolEvents'][number]): boolean {
  const summary = event.summary as Record<string, unknown> | undefined;
  if (event.status && event.status !== 'success') return false;
  if (summaryIndicatesFailure(summary)) return false;
  return true;
}

function summaryIndicatesFailure(summary: Record<string, unknown> | undefined): boolean {
  if (!summary) return false;
  if (summary.isError === true || summary.ok === false || summary.allowed === false) return true;
  return hasNonEmptyString(summary.error) || hasNonEmptyString(summary.errorMessage);
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isHttpSuccess(summary: Record<string, unknown>): boolean {
  const statusCode = summary.statusCode;
  return typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300;
}
