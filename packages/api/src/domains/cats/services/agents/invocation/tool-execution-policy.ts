import type { AgentService, ToolExecutionPolicy } from '../../types.js';

const MAX_REPLAY_DENIED_TOOL_NAMES = 32;

export class ToolExecutionPolicyUnavailableError extends Error {
  readonly code = 'read_only_tool_policy_unavailable';

  constructor() {
    super('agent service cannot enforce the requested read-only tool policy');
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
  if (policy.mode !== 'read_only') throw new Error(`unsupported tool execution policy: ${String(policy.mode)}`);
  return {
    mode: 'read_only',
    replayDeniedToolNames: [...new Set(policy.replayDeniedToolNames.map(normalizeToolExecutionName))]
      .sort()
      .slice(0, MAX_REPLAY_DENIED_TOOL_NAMES),
  };
}

export function parseToolExecutionPolicy(raw: string): ToolExecutionPolicy {
  const parsed = JSON.parse(raw) as Partial<ToolExecutionPolicy>;
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
    throw new ToolExecutionPolicyUnavailableError();
  }
}

export function toolExecutionPolicyDenial(
  policy: ToolExecutionPolicy | undefined,
  rawToolName: string,
): { reason: 'replay_denied_tool' | 'read_only_tool_policy'; toolName: string } | null {
  if (!policy) return null;
  const toolName = normalizeToolExecutionName(rawToolName);
  const normalized = normalizeToolExecutionPolicy(policy);
  // read_only denies every tool. replayDeniedToolNames only preserves the stronger audit reason
  // for tools whose prior execution makes replay specifically unsafe.
  return normalized.replayDeniedToolNames.includes(toolName)
    ? { reason: 'replay_denied_tool', toolName }
    : { reason: 'read_only_tool_policy', toolName };
}
