import { parseWatcherSessionState, type SessionRecord } from '@cat-cafe/shared';
import { watcherInvocationAuthority, watcherProviderLaunch } from '../watcher-authority.js';
import { recoverWatcherAttempt } from '../watcher-checkpoint.js';
import type { WatcherInvocationInput, WatcherInvocationOwners } from '../watcher-invocation-contract.js';
import { settleWatcherStartupFailure } from '../watcher-startup-failure.js';
import { publishWatcherRetirement, settleWatcherRetirementHost } from './watcher-retirement-owner.js';
import { watcherRetirementPort } from './watcher-retirement-port.js';
import { watcherRetirementClient } from './watcher-retirement-proof.js';
import {
  ensureWatcherRetirement,
  reserveWatcherRetirement,
  SURFACE_CHANGED,
  saveWatcherRetirement,
} from './watcher-retirement-state.js';

/** No new wake principal, tool bridge or model recovery. The original execution remains the only failure owner. */
export async function runWatcherRetirement(
  owners: WatcherInvocationOwners,
  input: WatcherInvocationInput,
  initial: SessionRecord,
): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  let session = await ensureWatcherRetirement(owners, initial);
  const operation = session.watcherRetirement;
  if (!operation) throw new Error('watcher_retirement_missing');
  if (operation.phase === 'retired') return;
  const execution = await owners.executions.get(operation.wakeInvocationId);
  if (
    !execution ||
    execution.executionKind !== 'watcher' ||
    execution.userId !== session.userId ||
    execution.threadId !== session.threadId ||
    execution.catId !== session.catId ||
    execution.causal?.watcherSourceInvocationId !== input.source.invocationId ||
    operation.sourceInvocationId !== input.source.invocationId ||
    operation.sourceSequence !== input.source.settledSequence ||
    operation.oldSchemaHash !== session.watcherState?.toolSchemaHash ||
    operation.nativeCliSessionId !== session.cliSessionId
  )
    throw new Error('watcher_retirement_binding_mismatch');
  const { scopeEnv, configuredSurface, parentInvocationId, auth } = await watcherInvocationAuthority(
    owners,
    {
      session,
      state: parseWatcherSessionState(session.watcherState),
      prefixTokens: 0,
      committed: false,
    },
    input.source,
    [],
    true,
  );
  if (auth.invocationId !== operation.wakeInvocationId) throw new Error('watcher_retirement_auth_changed');

  if (!session.cliSessionId && !session.nativeSessionBinding) {
    // Existing owner proof: no bound native could have crossed beforeTurn. Absence of providerStarted alone is insufficient.
    const settled = await settleWatcherStartupFailure(owners, session, input.source, SURFACE_CHANGED);
    const currentExecution = await owners.executions.get(operation.wakeInvocationId);
    if (
      !settled &&
      (!currentExecution || currentExecution.status === 'running' || !currentExecution.responseSettlement)
    )
      throw new Error('watcher_retirement_unbound_proof_missing');
    await publishWatcherRetirement(owners, session.id, operation, signal);
    return;
  }
  const reserved = await reserveWatcherRetirement(owners, session, owners.now?.() ?? Date.now());
  if (!reserved) return;
  session = reserved;
  if (!input.service.boundedWatcherSessionCapability?.().supported) throw new Error('WATCHER_SESSION_UNSUPPORTED');
  const controller = watcherRetirementPort(signal, async ({ threadId, client }) => {
    signal.throwIfAborted();
    const current = await owners.sessions.get(session.id);
    if (
      !current ||
      current.status !== 'active' ||
      current.cliSessionId !== threadId ||
      threadId !== operation.nativeCliSessionId ||
      current.watcherRetirement?.id !== operation.id ||
      JSON.stringify(current.nativeSessionBinding) !== JSON.stringify(initial.nativeSessionBinding)
    )
      throw new Error('watcher_retirement_binding_mismatch');
    session = current;
    const proof = watcherRetirementClient(
      client,
      {
        ...operation,
        ...(session.watcherState?.attempt?.nativeTurnId
          ? { nativeTurnId: session.watcherState.attempt.nativeTurnId }
          : {}),
      },
      signal,
    );
    await proof.read();
    let state = parseWatcherSessionState(session.watcherState);
    if (state.attempt) {
      state = await recoverWatcherAttempt(owners, session, state, proof.client, false, undefined, SURFACE_CHANGED);
      if (state.attempt?.phase !== 'finalize_pending' && state.attempt)
        throw new Error('watcher_retirement_attempt_unresolved');
    }
    await settleWatcherRetirementHost(owners, session.id, operation, signal);
    // Re-prove under this exact live native owner even after a crash left a saved idle phase.
    await proof.assertEmpty();
    await publishWatcherRetirement(owners, session.id, operation, signal);
    return false;
  });
  try {
    const { workspace, binding, callbackEnv } = await watcherProviderLaunch(
      owners.threads,
      session.catId,
      input.source,
      scopeEnv,
      signal,
    );
    for await (const message of input.service.invoke('', {
      invocationId: operation.wakeInvocationId,
      hostSessionId: session.id,
      sessionId: session.cliSessionId,
      requireExactResume: true,
      nativeSessionBinding: session.nativeSessionBinding,
      workingDirectory: workspace.workingDirectory,
      callbackEnv,
      ...(binding.codexAccountLaunch ? { codexAccountLaunch: binding.codexAccountLaunch } : {}),
      ...(binding.executionAccount ? { executionAccount: binding.executionAccount } : {}),
      signal,
      toolExecutionPolicy: configuredSurface.policy,
      requiredTools: [],
      auditContext: {
        invocationId: operation.wakeInvocationId,
        executionId: parentInvocationId,
        threadId: session.threadId,
        userId: session.userId,
        catId: session.catId,
      },
      beforeProviderLaunch: async () => {
        throw new Error('watcher_retirement_model_forbidden');
      },
      boundedWatcher: controller.port,
    })) {
      if (message.type === 'session_init' && message.sessionId !== session.cliSessionId)
        throw new Error('watcher_native_session_replaced');
      if (message.type === 'error')
        throw new Error(message.error ?? message.content ?? 'watcher_retirement_native_failed');
    }
  } catch (error) {
    try {
      const latest = await owners.sessions.get(session.id);
      if (latest?.watcherRetirement && latest.watcherRetirement.phase !== 'retired')
        await saveWatcherRetirement(owners, latest, {
          ...latest.watcherRetirement,
          lastFailure: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
    } catch {
      /* Diagnosis persistence cannot replace the original native/control error. */
    }
    throw error;
  } finally {
    await controller.close().catch(() => undefined);
  }
}
