import { isAbsolute, normalize } from 'node:path';
import type { AgentService, ToolExecutionPolicy } from '../../types.js';

const MAX_REPLAY_DENIED_TOOL_NAMES = 32;
const MAX_ALLOWED_CALLBACK_ROUTES = 32;

export class ToolExecutionPolicyUnavailableError extends Error {
  readonly code: string;

  constructor(policy?: ToolExecutionPolicy) {
    super(
      policy?.mode === 'collective_work'
        ? 'The named agent service cannot enforce the admitted private Work boundary'
        : 'agent service cannot enforce the requested read-only tool policy',
    );
    this.code =
      policy?.mode === 'collective_work'
        ? 'collective_work_tool_policy_unavailable'
        : 'read_only_tool_policy_unavailable';
    this.name = 'ToolExecutionPolicyUnavailableError';
  }
}

export function normalizeToolExecutionName(rawName: string): string {
  const trimmed = rawName.trim().toLowerCase().split('?')[0];
  let name = trimmed;
  const callbackMarker = '/api/callbacks/';
  const callbackIndex = name.lastIndexOf(callbackMarker);
  if (callbackIndex >= 0) name = name.slice(callbackIndex + callbackMarker.length);

  const catCafeIndex = name.lastIndexOf('cat_cafe_');
  if (catCafeIndex >= 0) name = name.slice(catCafeIndex);
  else
    name =
      name
        .split(/(?:__|[/:.])/)
        .filter(Boolean)
        .at(-1) ?? name;

  name = name
    .replace(/-/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return name.startsWith('cat_cafe_') ? name : `cat_cafe_${name}`;
}

export function normalizeToolExecutionPolicy(policy: ToolExecutionPolicy): ToolExecutionPolicy {
  if (policy.mode === 'collective_participation') return { mode: 'collective_participation' };
  if (policy.mode === 'callback_allowlist') {
    if (
      !Array.isArray(policy.allowedCallbackRoutes) ||
      policy.allowedCallbackRoutes.length > MAX_ALLOWED_CALLBACK_ROUTES ||
      !policy.allowedCallbackRoutes.every(
        (route) => typeof route === 'string' && /^(GET|POST) \/api\/callbacks\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route),
      )
    ) {
      throw new Error('invalid callback allowlist policy');
    }
    return { mode: 'callback_allowlist', allowedCallbackRoutes: [...new Set(policy.allowedCallbackRoutes)].sort() };
  }
  if (policy.mode === 'collective_work') {
    if (
      !policy.taskId?.trim() ||
      !policy.threadId?.trim() ||
      !Number.isInteger(policy.executionRevision) ||
      policy.executionRevision < 1 ||
      !policy.executionRef?.trim() ||
      !isAbsolute(policy.workspaceRoot) ||
      normalize(policy.workspaceRoot) === '/' ||
      !Array.isArray(policy.readOnlyRoots) ||
      policy.readOnlyRoots.length > 16 ||
      policy.readOnlyRoots.some((root) => typeof root !== 'string' || !isAbsolute(root) || normalize(root) === '/')
    )
      throw new Error('invalid scoped private Work policy');
    return {
      mode: 'collective_work',
      taskId: policy.taskId,
      threadId: policy.threadId,
      executionRevision: policy.executionRevision,
      executionRef: policy.executionRef,
      workspaceRoot: normalize(policy.workspaceRoot),
      readOnlyRoots: [...new Set(policy.readOnlyRoots.map(normalize))].sort(),
    };
  }
  if (policy.mode !== 'read_only') throw new Error('unsupported tool execution policy');
  return {
    mode: 'read_only',
    replayDeniedToolNames: [...new Set(policy.replayDeniedToolNames.map(normalizeToolExecutionName))]
      .sort()
      .slice(0, MAX_REPLAY_DENIED_TOOL_NAMES),
  };
}

export function parseToolExecutionPolicy(raw: string): ToolExecutionPolicy {
  const parsed = JSON.parse(raw) as Partial<ToolExecutionPolicy>;
  if (parsed.mode === 'collective_participation') return { mode: 'collective_participation' };
  if (parsed.mode === 'callback_allowlist') return normalizeToolExecutionPolicy(parsed as ToolExecutionPolicy);
  if (parsed.mode === 'collective_work') return normalizeToolExecutionPolicy(parsed as ToolExecutionPolicy);
  if (parsed.mode !== 'read_only' || !Array.isArray(parsed.replayDeniedToolNames)) {
    throw new Error('invalid persisted tool execution policy');
  }
  if (!parsed.replayDeniedToolNames.every((name) => typeof name === 'string')) {
    throw new Error('invalid persisted replay-denied tool names');
  }
  return normalizeToolExecutionPolicy(parsed as ToolExecutionPolicy);
}

export function assertToolExecutionPolicySupported(service: AgentService, policy?: ToolExecutionPolicy): void {
  if (!policy) return;
  if (service.supportsToolExecutionPolicy?.(policy) !== true) {
    throw new ToolExecutionPolicyUnavailableError(policy);
  }
}

export function toolExecutionPolicyDenial(
  policy: ToolExecutionPolicy | undefined,
  rawToolName: string,
): {
  reason:
    | 'replay_denied_tool'
    | 'read_only_tool_policy'
    | 'collective_participation_tool_policy'
    | 'callback_allowlist_tool_policy'
    | 'collective_work_tool_policy';
  toolName: string;
} | null {
  if (!policy) return null;
  if (policy.mode === 'callback_allowlist') {
    const route = rawToolName.split('?')[0] ?? '';
    const normalized = normalizeToolExecutionPolicy(policy);
    if (normalized.mode !== 'callback_allowlist') throw new Error('invalid callback allowlist policy');
    return normalized.allowedCallbackRoutes.includes(route)
      ? null
      : { reason: 'callback_allowlist_tool_policy', toolName: normalizeToolExecutionName(rawToolName) };
  }
  const toolName = normalizeToolExecutionName(rawToolName);
  const normalized = normalizeToolExecutionPolicy(policy);
  if (normalized.mode === 'collective_work')
    return COLLECTIVE_WORK_TOOLS.has(toolName) ? null : { reason: 'collective_work_tool_policy', toolName };
  if (normalized.mode === 'collective_participation') {
    return COLLECTIVE_PARTICIPATION_TOOLS.has(toolName)
      ? null
      : { reason: 'collective_participation_tool_policy', toolName };
  }
  if (normalized.mode !== 'read_only') throw new Error('invalid callback allowlist policy');
  // read_only denies every tool. replayDeniedToolNames only preserves the stronger audit reason
  // for tools whose prior execution makes replay specifically unsafe.
  return normalized.replayDeniedToolNames.includes(toolName)
    ? { reason: 'replay_denied_tool', toolName }
    : { reason: 'read_only_tool_policy', toolName };
}

const COLLECTIVE_PARTICIPATION_TOOLS = new Set([
  'cat_cafe_collective_current_context',
  'cat_cafe_collective_read_context',
  'cat_cafe_collective_reply',
  'cat_cafe_collective_set_interest',
  'cat_cafe_collective_propose_work',
  'cat_cafe_collective_accept_work',
  'cat_cafe_collective_continue_work',
]);

/** Existing collaboration operations plus the exact public return seam. No owner or global memory tools. */
export const COLLECTIVE_WORK_TOOL_NAMES = [
  'cat_cafe_generate_document',
  'cat_cafe_post_message',
  'cat_cafe_list_tasks',
  'cat_cafe_read_entrusted_work',
  'cat_cafe_update_entrusted_work',
  'cat_cafe_update_task',
  'cat_cafe_create_rich_block',
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_collective_current_context',
  'cat_cafe_collective_read_context',
  'cat_cafe_collective_reply',
  'cat_cafe_collective_progress',
  'cat_cafe_native_turn_admission',
  'cat_cafe_refresh_token',
] as const;
export const COLLECTIVE_WORK_TOOLS = new Set<string>(COLLECTIVE_WORK_TOOL_NAMES);
