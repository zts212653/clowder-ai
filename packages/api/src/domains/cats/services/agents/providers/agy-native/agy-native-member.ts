import type { ExecutionAccountSnapshot } from '@cat-cafe/shared';
import type { AgentServiceOptions } from '../../../types.js';
import { captureScopedMemberLaunch } from '../../invocation/scoped-member-launch.js';
import { normalizeToolExecutionPolicy } from '../../invocation/tool-execution-policy.js';

/** The native carrier reuses OAuth; an API gateway is not an executable member choice. */
export function assertAgyMemberAccount(account: ExecutionAccountSnapshot): void {
  if (account.authType !== 'oauth') throw new Error('agy_scoped_native_account_unavailable');
}

/** Keep the selected native OAuth profile; narrow this invocation to its issued member server. */
export function captureAgyMemberOptions(input?: AgentServiceOptions): AgentServiceOptions | undefined {
  if (!input?.pluginNativeLaunch) {
    if (input?.toolExecutionPolicy?.mode === 'plugin_native') throw new Error('agy_native_launch_required');
    return undefined;
  }
  if (
    !input.executionAccount ||
    !input.toolExecutionPolicy ||
    !input.signal ||
    input.spawnCliOverride ||
    input.agentCarrierSessionFactory ||
    input.requiredTools?.length ||
    input.cliConfigArgs?.length ||
    Object.keys(input.accountEnv ?? {}).length
  )
    throw new Error('agy_scoped_native_launch_unavailable');
  assertAgyMemberAccount(input.executionAccount);
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
  if (!launch || !/^[A-Za-z0-9_.-]+$/.test(launch.server.name)) throw new Error('agy_native_server_invalid');
  return {
    ...input,
    pluginNativeLaunch: launch,
    toolExecutionPolicy: normalizeToolExecutionPolicy(input.toolExecutionPolicy),
    callbackEnv: Object.freeze({ ...input.callbackEnv }),
    executionAccount: Object.freeze(structuredClone(input.executionAccount)),
    sessionId: undefined,
    cliSessionId: undefined,
    nativeSessionBinding: undefined,
    requireExactResume: false,
    resumeFallbackSystemPrompt: undefined,
    compactionLaunchPlan: undefined,
    activeRunDispatch: undefined,
  };
}
