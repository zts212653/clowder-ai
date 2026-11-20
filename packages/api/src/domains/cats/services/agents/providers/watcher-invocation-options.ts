import type { AgentServiceOptions, ToolExecutionPolicy } from '../../types.js';
import { normalizeToolExecutionPolicy } from '../invocation/tool-execution-policy.js';
import { watcherMcpToolAllowed } from './watcher-mcp-input.js';

/** Keep native session continuity while preventing late caller overrides of the tool boundary. */
export function captureWatcherOptions(input?: AgentServiceOptions): AgentServiceOptions | undefined {
  if (input?.toolExecutionPolicy?.mode !== 'watcher_panel') return undefined;
  const policy = normalizeToolExecutionPolicy(input.toolExecutionPolicy);
  if (
    policy.mode !== 'watcher_panel' ||
    !policy.allowedToolNames?.length ||
    input.pluginNativeLaunch ||
    input.liveCompanion ||
    input.requiredTools?.length
  )
    throw new Error('watcher_tool_surface_unavailable');
  return {
    ...input,
    toolExecutionPolicy: policy,
    callbackEnv: Object.freeze({
      ...input.callbackEnv,
      CAT_CAFE_MCP_TRANSPORT: 'stdio',
      CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(policy.allowedToolNames),
    }),
    accountEnv: Object.freeze({ ...input.accountEnv }),
    ...(input.executionAccount ? { executionAccount: Object.freeze(structuredClone(input.executionAccount)) } : {}),
    ...(input.executionPreferences ? { executionPreferences: Object.freeze({ ...input.executionPreferences }) } : {}),
    ...(input.frozenNativeMcpConfig ? { frozenNativeMcpConfig: structuredClone(input.frozenNativeMcpConfig) } : {}),
    cliConfigArgs: undefined,
    compactionLaunchPlan: undefined,
    claudeCompactionHooks: undefined,
    activeRunDispatch: undefined,
  };
}

/** SDK permission callbacks never ask a person to admit an unknown tool. */
export function claudeWatcherToolAllowed(name: string, policy: ToolExecutionPolicy): boolean {
  if (policy.mode !== 'watcher_panel') return false;
  return watcherMcpToolAllowed(name, policy.allowedToolNames ?? []);
}
