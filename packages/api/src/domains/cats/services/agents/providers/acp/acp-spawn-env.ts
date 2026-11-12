import { resolveMemberEnvironment } from '../../../../../../config/member-environment.js';
import { BUILTIN_ENV_MAPS, extractUserEnvTemplates, hasSupportedEnvTemplate, resolveEnvMap } from '../env-map.js';

export interface AcpProcessEnvAccount {
  id: string;
  authType: 'oauth' | 'api_key';
  apiKey?: string;
  baseUrl?: string;
  envVars?: Record<string, string>;
}

export interface PrepareAcpProcessEnvOptions {
  clientId: string;
  provider?: string | null;
  baseModel?: string;
  account?: AcpProcessEnvAccount | null;
  memberEnvironment?: Readonly<Record<string, string>>;
}

export type TryPrepareAcpProcessEnvResult =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; error: Error };

export function prepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): Record<string, string> | undefined {
  const account = options.account ?? null;
  const resolved: Record<string, string> = resolveMemberEnvironment(options.memberEnvironment);
  const accountOwnedKeys = new Set([
    ...Object.keys(BUILTIN_ENV_MAPS[options.clientId] ?? {}),
    ...Object.keys(options.clientId !== 'acp' ? (BUILTIN_ENV_MAPS[options.provider ?? ''] ?? {}) : {}),
    ...Object.keys(account?.envVars ?? {}),
    ...(options.clientId === 'kimi' ? ['KIMI_MODEL_API_KEY', 'KIMI_MODEL_BASE_URL'] : []),
  ]);
  if (account?.authType === 'oauth' && Object.keys(resolved).some((key) => accountOwnedKeys.has(key)))
    throw new Error('member env cannot change selected OAuth credentials or endpoint; configure the account instead');
  // An omitted account base URL means the adapter's default destination, never
  // permission for a member override to receive this account's credentials.
  if (account) for (const key of accountOwnedKeys) delete resolved[key];

  if (account?.authType === 'api_key') {
    if (!account.apiKey) {
      throw new Error(
        `account "${account.id}" is configured as api_key but has no API key set — ` +
          'add the key in Hub > account settings',
      );
    }
    const userEnvTemplates = account.envVars ? extractUserEnvTemplates(account.envVars) : undefined;
    // F161 AC-A5 / KD-1: generic ACP (clientId='acp') is a transport, not a provider identity.
    // It never selects a BUILTIN_ENV_MAPS[provider] template — env comes only from the account's
    // envVars templates. Ignore any provider on generic ACP (stale / pack-catalog / direct-API).
    const envMapProvider = options.clientId === 'acp' ? undefined : (options.provider ?? undefined);
    Object.assign(
      resolved,
      resolveEnvMap(
        options.clientId,
        envMapProvider,
        { apiKey: account.apiKey, baseUrl: account.baseUrl, baseModel: options.baseModel },
        userEnvTemplates,
      ),
    );
  }

  const validEnvKey = /^[A-Z_][A-Za-z0-9_]*$/;
  if (account?.envVars) {
    for (const [key, value] of Object.entries(account.envVars)) {
      if (!validEnvKey.test(key) || key.startsWith('CAT_CAFE_')) continue;
      if (hasSupportedEnvTemplate(value)) continue;
      resolved[key] = value;
    }
  }

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function tryPrepareAcpProcessEnv(options: PrepareAcpProcessEnvOptions): TryPrepareAcpProcessEnvResult {
  try {
    return { ok: true, env: prepareAcpProcessEnv(options) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
