import { catRegistry } from '@cat-cafe/shared';
import { validateRuntimeProviderBinding } from '../../config/account-resolver.js';
import { usesNativeToolConfiguration } from '../../config/cat-account-binding.js';
import { getCatModel } from '../../config/cat-models.js';
import { resolveCatRuntimeAccount } from '../../config/cat-runtime-account.js';
import { resolveCodexAccountLaunch } from '../../config/codex-account-launch.js';
import { captureCodexLaunchPolicy } from '../../config/codex-cli.js';
import { CodexAgentService } from '../cats/services/agents/providers/CodexAgentService.js';
import {
  extractUserEnvTemplates,
  hasSupportedEnvTemplate,
  resolveEnvMap,
} from '../cats/services/agents/providers/env-map.js';
import { captureMemberExecutionPreferences } from '../cats/services/agents/providers/member-execution-preferences.js';
import type { AgentServiceOptions } from '../cats/services/types.js';

/** Same member account/model resolution as ordinary native invocations; no new account layer. */
export function resolveCurationProvider(projectRoot: string, catId: string) {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config || config.clientId !== 'openai') throw new Error(`Curator ${catId} needs an OpenAI native member`);
  const model = getCatModel(catId);
  const account = resolveCatRuntimeAccount(projectRoot, catId, 'openai', config);
  if (!account && !usesNativeToolConfiguration(config)) throw new Error(`Curator ${catId} account is unavailable`);
  const callbackEnv: Record<string, string> = {
    CAT_CAFE_OPENAI_MODEL_OVERRIDE: model,
  };
  const options: AgentServiceOptions = {
    codexLaunchPolicy: captureCodexLaunchPolicy(),
    callbackEnv,
    executionPreferences: captureMemberExecutionPreferences(catId, config, model),
  };
  if (account) {
    const incompatibility = validateRuntimeProviderBinding('openai', account, model);
    if (incompatibility) throw new Error(incompatibility);
    if (account.authType === 'api_key' && !account.apiKey) throw new Error('Curator account has no API key');
    callbackEnv.CODEX_AUTH_MODE = account.authType;
    if (account.authType === 'api_key')
      Object.assign(
        callbackEnv,
        resolveEnvMap(
          'openai',
          undefined,
          { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: model },
          extractUserEnvTemplates(account.envVars ?? {}),
        ),
      );
    options.accountEnv = Object.fromEntries(
      Object.entries(account.envVars ?? {}).filter(
        ([key, value]) =>
          /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_') && !hasSupportedEnvTemplate(value),
      ),
    );
    options.codexAccountLaunch = resolveCodexAccountLaunch(account, { cwd: projectRoot });
  }
  return {
    catConfig: config,
    catId,
    model,
    accountIdentity: options.codexAccountLaunch?.accountRevision ?? account?.id ?? 'native_tool',
    options,
    service: new CodexAgentService({ catId: config.id, model, carrierMode: 'exec_json' }),
  };
}
