import type { AgentServiceOptions, ToolExecutionPolicy } from '../../types.js';
import type { InvocationDeps } from './invoke-single-cat.js';
import { normalizeToolExecutionPolicy } from './tool-execution-policy.js';

/** Host-only launch port. Native providers supply the scoped identity themselves. */
export function captureScopedMemberLaunch(
  input: {
    readonly scopedMemberLaunch?: AgentServiceOptions['pluginNativeLaunch'];
    readonly toolExecutionPolicy?: ToolExecutionPolicy;
    readonly systemPrompt?: string;
    readonly contentBlocks?: AgentServiceOptions['contentBlocks'];
    readonly liveCompanion?: AgentServiceOptions['liveCompanion'];
    readonly contextPromptFactory?: unknown;
    readonly rebuildPromptAfterSessionSeal?: unknown;
    readonly contextSourceIngress?: unknown;
    readonly memoryCueOpportunitySeeds?: unknown;
    readonly memoryCueLegacyFallbacks?: unknown;
    readonly asrPersonMemoryScenes?: unknown;
    readonly entityNudgePresentation?: unknown;
    readonly entityNudgeCuePresentation?: unknown;
  },
  workingDirectory: string | undefined,
): AgentServiceOptions['pluginNativeLaunch'] {
  const launch = input.scopedMemberLaunch;
  if (launch === undefined) return undefined;
  if (
    launch.sandbox?.kind !== 'scoped-member' ||
    typeof launch.assertCurrent !== 'function' ||
    input.toolExecutionPolicy?.mode !== 'plugin_native' ||
    !input.toolExecutionPolicy.memberSession ||
    input.systemPrompt !== undefined ||
    input.contentBlocks?.length ||
    input.liveCompanion ||
    input.contextPromptFactory ||
    input.rebuildPromptAfterSessionSeal ||
    input.contextSourceIngress !== undefined ||
    input.memoryCueOpportunitySeeds !== undefined ||
    input.memoryCueLegacyFallbacks !== undefined ||
    input.asrPersonMemoryScenes !== undefined ||
    input.entityNudgePresentation !== undefined ||
    input.entityNudgeCuePresentation !== undefined ||
    !workingDirectory ||
    launch.sandbox.workspaceRoot !== workingDirectory
  )
    throw new Error('scoped_member_launch_unavailable');
  normalizeToolExecutionPolicy(input.toolExecutionPolicy);
  return Object.freeze({
    server: Object.freeze(structuredClone(launch.server)),
    sandbox: Object.freeze({ ...launch.sandbox }),
    assertCurrent: launch.assertCurrent.bind(launch),
  });
}

/** Retain canonical execution/audit stores; home context and automatic follow-up
 * sources do not participate in a bounded member invocation. */
export function scopedMemberInvocationDeps(deps: InvocationDeps): InvocationDeps {
  return {
    registry: deps.registry,
    sessionManager: deps.sessionManager,
    threadStore: deps.threadStore,
    apiUrl: deps.apiUrl,
    ...(deps.turnExecutionStore ? { turnExecutionStore: deps.turnExecutionStore } : {}),
    ...(deps.messageStore ? { messageStore: deps.messageStore } : {}),
    ...(deps.sessionChainStore ? { sessionChainStore: deps.sessionChainStore } : {}),
    ...(deps.runtimeSessionStore ? { runtimeSessionStore: deps.runtimeSessionStore } : {}),
    ...(deps.transcriptWriter ? { transcriptWriter: deps.transcriptWriter } : {}),
    ...(deps.runtimeInteractionPort ? { runtimeInteractionPort: deps.runtimeInteractionPort } : {}),
    ...(deps.freshnessStateStore ? { freshnessStateStore: deps.freshnessStateStore } : {}),
    ...(deps.contextEpochOwner ? { contextEpochOwner: deps.contextEpochOwner } : {}),
  };
}
