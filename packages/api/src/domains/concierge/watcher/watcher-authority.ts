import type { SessionRecord, TurnExecutionRecord } from '@cat-cafe/shared';
import type { ISessionChainStore } from '../../cats/services/stores/ports/SessionChainStore.js';
import { awaitStoreRead } from '../../cats/services/stores/ports/StoreReadOptions.js';
import type { WatcherInvocationOwners, WatcherRunState } from './watcher-invocation-contract.js';
import { watcherSourceExecution, watcherSourceParent } from './watcher-source-result.js';
import { watcherToolSurface } from './watcher-surface.js';

/** A resumed wake retains the same callback principal, source and durable tool tickets. */
export async function watcherInvocationAuthority(
  owners: WatcherInvocationOwners,
  run: WatcherRunState,
  source: TurnExecutionRecord,
  messageIds: string[],
  recoveryOnly = false,
) {
  const scopeEnv: Record<string, string> = {
    CAT_CAFE_API_URL: owners.apiUrl,
    CAT_CAFE_USER_ID: source.userId,
    CAT_CAFE_CAT_ID: run.session.catId,
    CAT_CAFE_THREAD_ID: source.threadId,
    CAT_CAFE_MCP_TRANSPORT: 'stdio',
    ALLOWED_WORKSPACE_DIRS: process.env.ALLOWED_WORKSPACE_DIRS ?? process.cwd(),
    ...(process.env.CAT_CAFE_DATA_DIR ? { CAT_CAFE_DATA_DIR: process.env.CAT_CAFE_DATA_DIR } : {}),
  };
  const surface = watcherToolSurface(scopeEnv);
  const parentInvocationId = watcherSourceParent(run.session.catId, source.invocationId);
  const admitted = await watcherSourceExecution(owners.executions, run.session, source);
  const sourceAuth = await owners.registry.peekRecord(source.invocationId);
  const resumeAuthId = run.state.attempt?.invocationId ?? run.state.wakeInvocationId ?? admitted?.invocationId;
  const previousAuth = resumeAuthId ? await owners.registry.peekRecord(resumeAuthId) : null;
  if (
    resumeAuthId &&
    (!previousAuth ||
      (!recoveryOnly && previousAuth.state !== 'active') ||
      previousAuth.toolExecutionPolicy?.mode !== 'watcher' ||
      previousAuth.userId !== source.userId ||
      previousAuth.threadId !== source.threadId ||
      previousAuth.catId !== run.session.catId)
  )
    throw new Error('watcher_original_auth_unavailable');
  const auth =
    previousAuth ??
    (await owners.registry.create(
      source.userId,
      run.session.catId,
      source.threadId,
      parentInvocationId,
      undefined,
      surface.policy,
      source.causal?.triggerMessageId,
      sourceAuth?.ownerAuthProvenance ?? 'unknown',
    ));
  scopeEnv.CAT_CAFE_INVOCATION_ID = auth.invocationId;
  scopeEnv.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  const configuredSurface = watcherToolSurface(scopeEnv);
  const execution = previousAuth
    ? undefined
    : await owners.executions.createRunning({
        invocationId: auth.invocationId,
        parentInvocationId,
        userId: source.userId,
        threadId: source.threadId,
        catId: run.session.catId,
        executionKind: 'watcher',
        outputFence: 'open',
        startedAt: Date.now(),
        providerLifecycleTracked: true,
        causal: {
          watcherSourceInvocationId: source.invocationId,
          ...(source.causal?.triggerMessageId ? { triggerMessageId: source.causal.triggerMessageId } : {}),
          ...(messageIds.length ? { coveredMessageIds: messageIds } : {}),
        },
      });
  if (execution && execution.outcome !== 'created') throw new Error('watcher_execution_not_admitted');
  return { scopeEnv, configuredSurface, parentInvocationId, auth };
}

export { watcherProviderLaunch } from './watcher-provider-launch.js';

/** Only the watcher role's exact session and an owner-settled ordinary source may enter this invocation. */
export async function loadWatcherInvocationSession(
  sessions: ISessionChainStore,
  sessionId: string,
  source: TurnExecutionRecord,
  signal?: AbortSignal,
): Promise<SessionRecord> {
  const current = await awaitStoreRead(Promise.resolve(sessions.get(sessionId)), { signal });
  if (
    !current ||
    current.sessionPurpose !== 'watcher' ||
    current.userId !== source.userId ||
    current.threadId !== source.threadId ||
    source.executionKind !== 'ordinary' ||
    source.status === 'running' ||
    !source.responseSettlement ||
    !source.settledSequence
  )
    throw new Error('watcher_source_not_settled_ordinary');
  return current;
}
