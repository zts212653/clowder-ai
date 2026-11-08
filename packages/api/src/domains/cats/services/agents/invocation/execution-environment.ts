import type { CatConfig } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from '../../../../../config/account-resolver.js';
import { resolveMemberEnvironment } from '../../../../../config/member-environment.js';
import { prepareAcpProcessEnv } from '../providers/acp/acp-spawn-env.js';
import { hasSupportedEnvTemplate } from '../providers/env-map.js';

/** One invocation-local projection; the catalog and selected account remain the authorities. */
export function captureExecutionEnvironment(
  config: CatConfig | undefined,
  account: RuntimeProviderProfile | null,
  model?: string,
): Record<string, string> {
  const memberEnv = resolveMemberEnvironment(config?.env);
  if (
    Object.keys(memberEnv).length &&
    (config?.clientId === 'a2a' || config?.clientId === 'catagent' || config?.provider === 'openai-chatgpt-pro')
  )
    throw new Error('member environment overrides require a local process carrier');
  if (Object.keys(memberEnv).length && (config?.agyProfile?.enabled === true || config?.clientId === 'antigravity'))
    throw new Error('member environment overrides are unsupported by the isolated AGY carrier');
  return {
    ...(config?.env
      ? prepareAcpProcessEnv({
          clientId: config.clientId,
          provider: config.provider,
          baseModel: model ?? config.defaultModel,
          account,
          memberEnvironment: config.env,
        })
      : memberEnv),
    // Preserve F171's legacy account literals. Canonical account templates are
    // resolved by the adapter, while ordinary member references are captured above.
    ...Object.fromEntries(
      Object.entries(account?.envVars ?? {}).filter(
        ([key, value]) =>
          /^[A-Z_][A-Za-z0-9_]*$/.test(key) && !key.startsWith('CAT_CAFE_') && !hasSupportedEnvTemplate(value),
      ),
    ),
  };
}
