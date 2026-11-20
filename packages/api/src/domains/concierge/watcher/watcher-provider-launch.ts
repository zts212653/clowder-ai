import { catRegistry, protocolForClient, type SessionRecord, type TurnExecutionRecord } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from '../../../config/account-resolver.js';
import {
  type ExecutionAccountSelection,
  type FrozenExecutionBinding,
  freezeExecutionAccountBinding,
} from '../../cats/services/agents/invocation/execution-account-binding.js';
import {
  freezeExecutionWorkspace,
  requiresAgyThreadWorkspace,
} from '../../cats/services/agents/invocation/execution-workspace.js';
import { extractUserEnvTemplates, resolveEnvMap } from '../../cats/services/agents/providers/env-map.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../../cats/services/types.js';
import { watcherPanelToolPolicy } from './panel/watcher-panel-policy.js';

/** Freeze the ordinary provider owners' account, workspace and native MCP inputs for one observer turn. */
export async function watcherProviderLaunch(
  threads: IThreadStore,
  catId: SessionRecord['catId'],
  source: TurnExecutionRecord,
  scopeEnv: Record<string, string>,
  signal: AbortSignal,
  accountSelection?: ExecutionAccountSelection,
  service?: AgentService,
) {
  const catConfig = catRegistry.tryGet(catId)?.config;
  const workspace = await freezeExecutionWorkspace({
    threadStore: threads,
    threadId: source.threadId,
    userId: source.userId,
    provider: catConfig?.clientId,
    requiresAgyWorkspace: service ? requiresAgyThreadWorkspace(service) : false,
    signal,
  });
  let nativeAccount: RuntimeProviderProfile | null | undefined;
  if (service?.resolveScopedNativeAccount) {
    if (!workspace.workingDirectory) throw new Error('watcher_native_workspace_unavailable');
    nativeAccount = await service.resolveScopedNativeAccount({
      workingDirectory: workspace.workingDirectory,
      accountRef: accountSelection?.accountRef,
    });
  }
  const binding = await freezeExecutionAccountBinding({ catId, catConfig, workspace, accountSelection, nativeAccount });
  if (binding.executionAccount) service?.assertScopedMemberAccount?.(binding.executionAccount);
  const callbackEnv = watcherProviderEnvironment(binding, scopeEnv);
  const providerOptions = await service?.captureInvocationOptions?.({
    workingDirectory: workspace.workingDirectory,
    toolExecutionPolicy: watcherPanelToolPolicy(),
    accountEnv: binding.accountEnv,
    accountRef: binding.effectiveAccountRef,
    signal,
  });
  return { workspace, binding, callbackEnv, providerOptions };
}

/** Account credentials are mapped by the selected provider, never by watcher role. */
function watcherProviderEnvironment(
  binding: FrozenExecutionBinding,
  scopeEnv: Record<string, string>,
): Record<string, string> {
  const { catConfig, resolvedAccount: account } = binding;
  const protocol = catConfig ? protocolForClient(catConfig.clientId) : null;
  const providerEnv =
    account?.authType === 'api_key' && protocol
      ? resolveEnvMap(
          protocol,
          undefined,
          { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: catConfig?.defaultModel },
          extractUserEnvTemplates(account.envVars ?? {}),
        )
      : {};
  const env = { ...scopeEnv, ...providerEnv };
  if (catConfig?.clientId === 'openai' && account)
    env.CODEX_AUTH_MODE = account.syntheticNative ? 'auto' : account.authType;
  if (catConfig?.clientId !== 'anthropic') return env;
  env.CAT_CAFE_ANTHROPIC_PROFILE_MODE = account?.authType === 'api_key' ? 'api_key' : 'subscription';
  if (account?.authType !== 'api_key') return env;
  if (account.apiKey) env.CAT_CAFE_ANTHROPIC_API_KEY = account.apiKey;
  if (account.baseUrl) env.CAT_CAFE_ANTHROPIC_BASE_URL = account.baseUrl;
  if (catConfig.defaultModel) env.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE = catConfig.defaultModel;
  return env;
}
