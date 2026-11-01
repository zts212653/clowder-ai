import type { AgentServiceOptions } from '../../types.js';
import { captureScopedMemberLaunch } from '../invocation/scoped-member-launch.js';
import { normalizeToolExecutionPolicy } from '../invocation/tool-execution-policy.js';

/** Keep the existing selected account/authentication path; only the bounded
 * invocation's context, tools and configuration are narrowed. */
export function captureClaudeMemberOptions(input?: AgentServiceOptions): AgentServiceOptions | undefined {
  if (!input?.pluginNativeLaunch) {
    if (input?.toolExecutionPolicy?.mode === 'plugin_native') throw new Error('claude_native_launch_required');
    return undefined;
  }
  if (
    !input.executionAccount ||
    !input.toolExecutionPolicy ||
    !input.signal ||
    input.spawnCliOverride ||
    input.agentCarrierSessionFactory ||
    input.requiredTools?.length
  )
    throw new Error('claude_scoped_native_launch_unavailable');
  const launch = captureScopedMemberLaunch(
    {
      scopedMemberLaunch: input.pluginNativeLaunch,
      toolExecutionPolicy: input.toolExecutionPolicy,
      systemPrompt: input.systemPrompt,
      contentBlocks: input.contentBlocks,
      liveCompanion: input.liveCompanion,
    },
    input.workingDirectory,
  );
  if (!launch || !/^[A-Za-z0-9_.-]+$/.test(launch.server.name)) throw new Error('claude_native_server_invalid');
  return {
    ...input,
    pluginNativeLaunch: launch,
    toolExecutionPolicy: normalizeToolExecutionPolicy(input.toolExecutionPolicy),
    accountEnv: Object.freeze({ ...input.accountEnv }),
    callbackEnv: Object.freeze({ ...input.callbackEnv }),
    executionAccount: Object.freeze(structuredClone(input.executionAccount)),
    sessionId: undefined,
    cliSessionId: undefined,
    nativeSessionBinding: undefined,
    cliConfigArgs: undefined,
    resumeFallbackSystemPrompt: undefined,
    compactionLaunchPlan: undefined,
    claudeCompactionHooks: undefined,
    activeRunDispatch: undefined,
  };
}

export function claudeMemberToolPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}__*`;
}

export const CLAUDE_MEMBER_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  autoMemoryEnabled: false,
  claudeMdExcludes: ['**'],
  enabledPlugins: {},
});

export function applyClaudeMemberEnvironment(env: Record<string, string | null>): void {
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.ENABLE_TOOL_SEARCH = 'false';
  env.MCP_CONNECTION_NONBLOCKING = '0';
  // A parent process's troubleshooting mode must not remove our explicit MCP
  // or silently replace the selected OAuth account with API-only bare auth.
  env.CLAUDE_CODE_SAFE_MODE = null;
  env.CLAUDE_CODE_SIMPLE = null;
}
