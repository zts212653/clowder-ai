import { catRegistry, type SessionRecord, type TurnExecutionRecord } from '@cat-cafe/shared';
import { freezeExecutionAccountBinding } from '../../cats/services/agents/invocation/execution-account-binding.js';
import { freezeExecutionWorkspace } from '../../cats/services/agents/invocation/execution-workspace.js';
import { extractUserEnvTemplates, resolveEnvMap } from '../../cats/services/agents/providers/env-map.js';
import type { ISessionChainStore } from '../../cats/services/stores/ports/SessionChainStore.js';
import { awaitStoreRead } from '../../cats/services/stores/ports/StoreReadOptions.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
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

/** Account/workspace ownership is frozen by the original provider owners. */
export async function watcherProviderLaunch(
  threads: IThreadStore,
  catId: SessionRecord['catId'],
  source: TurnExecutionRecord,
  scopeEnv: Record<string, string>,
  signal: AbortSignal,
) {
  const workspace = await freezeExecutionWorkspace({
    threadStore: threads,
    threadId: source.threadId,
    userId: source.userId,
    provider: 'openai',
    signal,
  });
  const binding = freezeExecutionAccountBinding({
    catId: catId,
    catConfig: catRegistry.tryGet(catId)?.config,
    workspace,
  });
  const account = binding.resolvedAccount;
  const providerEnv =
    account?.authType === 'api_key'
      ? resolveEnvMap(
          'openai',
          undefined,
          { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: binding.catConfig?.defaultModel },
          extractUserEnvTemplates(account.envVars ?? {}),
        )
      : {};
  const callbackEnv = { ...scopeEnv, ...providerEnv, ...(account ? { CODEX_AUTH_MODE: account.authType } : {}) };
  return { workspace, binding, callbackEnv };
}

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
