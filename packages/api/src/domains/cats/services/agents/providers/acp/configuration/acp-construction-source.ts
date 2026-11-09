import type { CatConfig } from '@cat-cafe/shared';
import {
  type RuntimeProviderProfile,
  validateRuntimeProviderBinding,
} from '../../../../../../../config/account-resolver.js';
import type { AcpVariantConfig } from '../../../../../../../config/cat-config-loader.js';
import { prepareAcpProcessEnv } from '../acp-spawn-env.js';

/** Object key order cannot turn equivalent effective inputs into different pool generations. */
export function acpConstructionJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
      : entry,
  );
}

/** Audit/display metadata does not define process compatibility. Only inputs actually consumed at launch do. */
export function acpAccountConstructionSource(
  config: CatConfig,
  model: string | undefined,
  source: { accountRef?: string; account: RuntimeProviderProfile | null },
) {
  const account = source.account;
  return {
    accountRef: source.accountRef ?? null,
    account: account
      ? {
          id: account.id,
          authType: account.authType,
          validation: validateRuntimeProviderBinding(config.clientId, account, model),
          env:
            prepareAcpProcessEnv({ clientId: config.clientId, provider: config.provider, baseModel: model, account }) ??
            null,
          ...(config.clientId === 'opencode' ? { models: account.models, modelAliases: account.modelAliases } : {}),
        }
      : null,
  };
}

/** Whitelist is session-scoped and is captured afresh; the remaining fields select the service/pool. */
export function acpLaunchConstructionSource(config?: AcpVariantConfig) {
  if (!config) return null;
  const { mcpWhitelist: _sessionWhitelist, ...construction } = config;
  return construction;
}
