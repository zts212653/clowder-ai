import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import { authTerminalFromTurnExecution } from './CallbackAuthTurnExecutionProjection.js';
import type { AuthTerminalCommitInput } from './InvocationRegistry.js';
import type { InvocationDeps, InvocationParams } from './invoke-single-cat.js';
import { capturePublicInvocationAuth } from './public-invocation-auth-binding.js';
import { capturePublicInvocationExecution } from './public-invocation-execution.js';

/** Capture Host plugin identity before setup yields; unbound Task ports never enter ordinary execution. */
export function capturePublicInvocationRegistration(deps: InvocationDeps, params: InvocationParams): InvocationParams {
  if (params.publicInvocationBinding === undefined) return params;
  if (
    params.systemPrompt ||
    params.contextPromptFactory ||
    params.rebuildPromptAfterSessionSeal ||
    params.liveCompanion ||
    params.contentBlocks?.length ||
    params.memoryCueOpportunitySeeds?.length ||
    params.memoryCueLegacyFallbacks?.length
  ) {
    throw new Error('public_registration_owner_context_forbidden');
  }
  const execution = capturePublicInvocationExecution(params.publicInvocationExecution);
  const identity = capturePublicInvocationAuth({
    userId: params.userId,
    threadId: params.threadId,
    catId: params.catId,
    ownerAuthProvenance: params.ownerAuthProvenance,
    a2aTriggerMessageId: params.a2aTriggerMessageId,
    originTriggerMessageId: params.executionCausal?.triggerMessageId,
    toolExecutionPolicy: params.toolExecutionPolicy,
    publicInvocationBinding: params.publicInvocationBinding,
  });
  if (
    !deps.turnExecutionStore ||
    typeof deps.turnExecutionStore.createRunning !== 'function' ||
    typeof deps.turnExecutionStore.transitionTerminal !== 'function' ||
    typeof deps.turnExecutionStore.get !== 'function' ||
    typeof deps.registry.commitTerminal !== 'function'
  ) {
    throw new Error('Public child registration requires durable TurnExecution and callback terminalization');
  }
  return {
    ...params,
    publicInvocationExecution: execution,
    userId: identity.userId,
    threadId: identity.threadId,
    catId: identity.catId,
    ownerAuthProvenance: identity.ownerAuthProvenance,
    a2aTriggerMessageId: identity.a2aTriggerMessageId,
    publicInvocationBinding: identity.publicInvocationBinding,
    toolExecutionPolicy: identity.toolExecutionPolicy,
    executionCausal: snapshotPluginProtocolData(params.executionCausal) as InvocationParams['executionCausal'],
  };
}

/** Reuse canonical terminal truth; missing/failed lifecycle truth cannot leave usable credentials. */
export async function finalizePublicInvocationRegistration(deps: InvocationDeps, invocationId: string): Promise<void> {
  let terminal: AuthTerminalCommitInput = {
    invocationId,
    disposition: 'failed',
    endedAt: Date.now(),
    endReason: 'public_child_without_canonical_terminal',
  };
  try {
    const store = deps.turnExecutionStore;
    if (!store) throw new Error('Public child registration lost durable TurnExecution');
    const record = await store.get(invocationId);
    if (record && record.status !== 'running') terminal = authTerminalFromTurnExecution(record);
  } finally {
    // Even a read outage must attempt revocation. Persistence failures propagate
    // to the starter; it must not treat the child as successfully cleaned up.
    await deps.registry.commitTerminal(terminal);
  }
}
