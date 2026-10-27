import type { AgentService, PluginNativeActionTarget, ToolExecutionPolicy } from '../../types.js';

const MAX_REPLAY_DENIED_TOOL_NAMES = 32;
const MAX_ALLOWED_CALLBACK_ROUTES = 32;

function nativeCoordinate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

export class ToolExecutionPolicyUnavailableError extends Error {
  readonly code: string;

  constructor(_policy?: ToolExecutionPolicy) {
    super('agent service cannot enforce the requested read-only tool policy');
    this.code = 'read_only_tool_policy_unavailable';
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
  if (policy.mode === 'plugin_native') {
    if (!nativeCoordinate(policy.pluginInstanceId) || !nativeCoordinate(policy.contributionId))
      throw new Error('invalid plugin native policy');
    return {
      mode: 'plugin_native',
      pluginInstanceId: policy.pluginInstanceId,
      contributionId: policy.contributionId,
    };
  }
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
  if (parsed.mode === 'callback_allowlist' || parsed.mode === 'plugin_native')
    return normalizeToolExecutionPolicy(parsed as ToolExecutionPolicy);
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
  nativeTarget?: PluginNativeActionTarget,
): {
  reason:
    | 'replay_denied_tool'
    | 'read_only_tool_policy'
    | 'callback_allowlist_tool_policy'
    | 'plugin_native_tool_policy';
  toolName: string;
} | null {
  if (!policy) return null;
  if (policy.mode === 'plugin_native') {
    const normalized = normalizeToolExecutionPolicy(policy);
    if (normalized.mode !== 'plugin_native') throw new Error('invalid plugin native policy');
    return rawToolName === 'POST /api/plugin-runtime/action' &&
      nativeTarget?.instanceId === normalized.pluginInstanceId &&
      nativeTarget.contributionId === normalized.contributionId
      ? null
      : { reason: 'plugin_native_tool_policy', toolName: normalizeToolExecutionName(rawToolName) };
  }
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
  if (normalized.mode !== 'read_only') throw new Error('invalid callback allowlist policy');
  // read_only denies every tool. replayDeniedToolNames only preserves the stronger audit reason
  // for tools whose prior execution makes replay specifically unsafe.
  return normalized.replayDeniedToolNames.includes(toolName)
    ? { reason: 'replay_denied_tool', toolName }
    : { reason: 'read_only_tool_policy', toolName };
}

/**
 * Project a durable invocation policy onto the exact tool names an in-process
 * carrier may advertise and execute. `undefined` means the invocation has no
 * durable policy (the family surface applies). Every current durable mode
 * denies the MCP gateway surface: read_only denies all tools, while
 * callback_allowlist and plugin_native are callback-route/plugin-action
 * boundaries that an MCP tool name cannot represent, so they fail closed.
 */
export function toolExecutionPolicyAllowedToolNames(
  policy: ToolExecutionPolicy | undefined,
): readonly string[] | undefined {
  if (!policy) return undefined;
  const normalized = normalizeToolExecutionPolicy(policy);
  switch (normalized.mode) {
    case 'read_only':
    case 'callback_allowlist':
    case 'plugin_native':
      return [];
  }
}
