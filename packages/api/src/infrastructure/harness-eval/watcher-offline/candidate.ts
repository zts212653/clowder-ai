import { catRegistry } from '@cat-cafe/shared';
import { validateRuntimeProviderBinding } from '../../../config/account-resolver.js';
import { usesNativeToolConfiguration } from '../../../config/cat-account-binding.js';
import { getCatModel } from '../../../config/cat-models.js';
import { resolveCatRuntimeAccount } from '../../../config/cat-runtime-account.js';
import { hasSupportedEnvTemplate } from '../../../domains/cats/services/agents/providers/env-map.js';
import type { AgentServiceOptions } from '../../../domains/cats/services/types.js';
import { resolveCurationProvider } from '../../../domains/memory/curation-provider.js';

export interface WatcherCandidate {
  catId: string;
  provider: 'openai' | 'anthropic';
  model: string;
  accountIdentity: string;
  /** Launch secrets remain internal; never serialize this object into a run receipt. */
  options: AgentServiceOptions;
}

export function resolveWatcherCandidate(projectRoot: string, catId: string): WatcherCandidate {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config) throw new Error('watcher_candidate_unavailable');
  if (config.clientId === 'openai') {
    const { model, accountIdentity, options } = resolveCurationProvider(projectRoot, catId);
    if (!model) throw new Error('watcher_model_must_be_explicit');
    return { catId, provider: 'openai', model, accountIdentity, options };
  }
  if (config.clientId !== 'anthropic') throw new Error('unsupported_watcher_provider');
  const model = getCatModel(catId);
  if (!model) throw new Error('watcher_model_must_be_explicit');
  const account = resolveCatRuntimeAccount(projectRoot, catId, 'anthropic', config);
  if (!account && !usesNativeToolConfiguration(config)) throw new Error('watcher_account_unavailable');
  if (account) {
    const error = validateRuntimeProviderBinding('anthropic', account, model);
    if (error) throw new Error(error);
  }
  const callbackEnv: Record<string, string> = { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: model };
  if (account && (!usesNativeToolConfiguration(config) || !account.syntheticNative)) {
    callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE = account.authType === 'oauth' ? 'subscription' : 'api_key';
    if (account.authType === 'api_key') {
      if (!account.apiKey) throw new Error('watcher_account_credential_unavailable');
      callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY = account.apiKey;
      if (account.baseUrl) callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL = account.baseUrl;
    }
  }
  const options: AgentServiceOptions = {
    callbackEnv,
    ...(account?.claude ? { claudeTokenAccount: true } : {}),
    ...(account
      ? {
          accountEnv: Object.fromEntries(
            Object.entries(account.envVars ?? {}).filter(
              ([key, value]) =>
                /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_') && !hasSupportedEnvTemplate(value),
            ),
          ),
        }
      : {}),
  };
  return { catId, provider: 'anthropic', model, accountIdentity: account?.id ?? 'native_tool', options };
}
