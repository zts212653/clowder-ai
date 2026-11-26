import { type AccountConfig, accountQuotaOwnerMatches, builtinAccountFamilyForRef } from '@cat-cafe/shared';
import { readAccountStoreSnapshot } from '../config/account-store-snapshot.js';
import { agyLoginCommand, inspectAgyLogin } from '../config/agy-account.js';
import type { AgyKeychainIdentityInspector } from '../config/agy-quota-identity.js';
import { type AgyAccountQuotaObservationView, readAgyQuotaView } from '../config/agy-quota-store.js';
import { readClaudeQuotaView } from '../config/claude-quota-store.js';
import { claudeTokenStatus } from '../config/claude-token-account.js';
import { codexManagedStatus } from '../config/codex-account-identity.js';
import { readKimiQuotaView } from '../config/kimi-quota-store.js';
import { readNativeCodexQuota } from '../config/native-codex-quota.js';
import { nativeCodexAccountView } from './accounts-native-view.js';
import { projectQuotaRenewal } from './accounts-quota-feedback.js';
// clowder-ai#340: Derive client identity from well-known account IDs, not stored protocol.
/** Synthesize a ProviderProfileView-compatible object from AccountConfig (purely non-blocking; AGY quota view is pre-resolved by accountToViewAsync). */
export function accountToView(
  id: string,
  account: AccountConfig,
  apiKeyPresent: boolean,
  projectRoot?: string,
  nativeDefault = false,
  options?: {
    agyQuotaView?: { agyQuotaReady: boolean; agyQuota?: AgyAccountQuotaObservationView };
  },
) {
  const isBuiltin = account.authType === 'oauth' && !!builtinAccountFamilyForRef(id);
  const builtinClient = builtinAccountFamilyForRef(id);
  const clientId = account.clientId ?? (isBuiltin ? builtinClient : undefined);
  const codexView = account.codex ? { ...account.codex, status: codexManagedStatus(account.codex) } : undefined;
  const codexStatus = codexView?.status;
  const nativeView: Partial<ReturnType<typeof nativeCodexAccountView>> =
    projectRoot && clientId === 'openai' && account.authType === 'oauth' && !account.codex
      ? nativeCodexAccountView(projectRoot, id)
      : {};
  const observed =
    nativeDefault && id === 'codex' && projectRoot && nativeView.nativeLogin
      ? readNativeCodexQuota(projectRoot, nativeView.nativeLogin.home, nativeView.nativeLogin.identity)
      : account.quota;
  const identity = account.codex?.identity ?? nativeView.nativeLogin?.identity;
  const ready = account.codex ? codexStatus === 'ready' : nativeView.codexLoginStatus === 'ready';
  const claudeQuota =
    projectRoot && clientId === 'anthropic' && account.authType === 'oauth'
      ? readClaudeQuotaView(projectRoot, id)
      : undefined;
  const kimiView =
    projectRoot && clientId === 'kimi' && account.authType === 'oauth' ? readKimiQuotaView(projectRoot, id) : undefined;
  const agyQuotaView = options?.agyQuotaView;
  const quota =
    (account.codex || nativeDefault) &&
    (observed?.status === 'ok' || observed?.lastSuccess) &&
    (!ready || !accountQuotaOwnerMatches(observed, id, identity))
      ? {
          ...observed,
          status: 'unavailable' as const,
          items: [],
          lastSuccess: undefined,
          renewedCredentialVersion: undefined,
          failure: { kind: 'signin_required' as const },
          error: ready ? '额度身份未确认，请重新查询此账号' : '请先处理此账号的官方登录',
        }
      : observed;
  return {
    id,
    name: account.displayName ?? id,
    displayName: account.displayName ?? id,
    ...nativeView,
    ...(!isBuiltin ? { displayName: account.displayName ?? id } : {}),
    authType: account.authType,
    ...(claudeQuota ? { claudeQuota } : {}),
    ...(kimiView
      ? {
          kimiLoginReady: kimiView.kimiLoginReady,
          ...(kimiView.kimiQuota ? { kimiQuota: kimiView.kimiQuota } : {}),
        }
      : {}),
    ...(agyQuotaView
      ? {
          agyQuotaReady: agyQuotaView.agyQuotaReady,
          ...(agyQuotaView.agyQuota ? { agyQuota: agyQuotaView.agyQuota } : {}),
        }
      : {}),
    builtin: isBuiltin,
    ...(quota
      ? {
          quota: projectQuotaRenewal(
            quota,
            codexStatus === 'ready'
              ? account.codex?.credentialHome
              : !account.codex
                ? nativeView.nativeLogin?.home
                : undefined,
          ),
        }
      : {}),
    kind: isBuiltin ? 'builtin' : account.authType,
    ...(account.googleCloud ? { googleCloud: account.googleCloud } : {}),
    ...(account.agy
      ? {
          agy: account.agy,
          agyLoginStatus: inspectAgyLogin(account.agy.credentialHome),
          agyLoginCommand: agyLoginCommand(account.agy.credentialHome),
        }
      : {}),
    ...(account.claude
      ? {
          claude: account.claude,
          claudeTokenStatus: projectRoot
            ? claudeTokenStatus(readAccountStoreSnapshot(projectRoot).resolve(id).credential)
            : 'missing',
        }
      : {}),
    ...(codexView ? { codex: codexView } : {}),
    ...(clientId ? { clientId } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    models: account.models ? [...account.models] : [],
    ...(account.modelAliases && Object.keys(account.modelAliases).length > 0
      ? { modelAliases: { ...account.modelAliases } }
      : {}),
    hasApiKey: account.claude ? false : apiKeyPresent,
    mode: account.authType === 'api_key' ? ('api_key' as const) : ('subscription' as const),
    ...(account.envVars && Object.keys(account.envVars).length > 0 ? { envVars: { ...account.envVars } } : {}),
    createdAt: '',
    updatedAt: '',
  };
}

export async function accountToViewAsync(
  id: string,
  account: AccountConfig,
  apiKeyPresent: boolean,
  projectRoot?: string,
  nativeDefault = false,
  options?: { agyKeychainIdentityInspector?: AgyKeychainIdentityInspector },
) {
  const isBuiltin = account.authType === 'oauth' && !!builtinAccountFamilyForRef(id);
  const builtinClient = builtinAccountFamilyForRef(id);
  const clientId = account.clientId ?? (isBuiltin ? builtinClient : undefined);
  const agyQuotaView =
    projectRoot && clientId === 'google' && account.authType === 'oauth' && !account.googleCloud
      ? await readAgyQuotaView(projectRoot, id, { keychainIdentityInspector: options?.agyKeychainIdentityInspector })
      : undefined;
  return accountToView(id, account, apiKeyPresent, projectRoot, nativeDefault, { agyQuotaView });
}

/** Derive a slug-like ID from display name, avoiding collisions with existing accounts. */
export function deriveAccountId(displayName: string, existingIds: Set<string>, customApiKey: boolean): string {
  let seed =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `account-${Date.now()}`;
  if (customApiKey && builtinAccountFamilyForRef(seed)) seed = `custom-${seed}`;
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}
