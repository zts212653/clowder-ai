/** Shared pure format boundary for read-only account snapshots and explicit legacy migration. */
import type { AccountConfig, CredentialEntry } from '@cat-cafe/shared';
import { z } from 'zod';

export class AccountStoreVerdictError extends Error {}

export function malformedAccountStore(source: string): never {
  throw new AccountStoreVerdictError(`Invalid/malformed account store (${source}); repair it before use`);
}

const stringRecord = z.record(z.string());
const accountSchema = z
  .object({
    authType: z.enum(['oauth', 'api_key']),
    clientId: z.string().trim().min(1).optional(),
    baseUrl: z.string().optional(),
    displayName: z.string().optional(),
    models: z.array(z.string()).optional(),
    modelAliases: stringRecord.optional(),
    envVars: stringRecord.optional(),
  })
  .passthrough();
const credentialSchema = z
  .object({
    apiKey: z.string().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().finite().optional(),
  })
  .passthrough();

export function objectMap(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) malformedAccountStore(source);
  return value as Record<string, unknown>;
}

export function normalizeLegacyAuthType(value: unknown): AccountConfig['authType'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (['oauth', 'subscription', 'builtin'].includes(normalized)) return 'oauth';
  return undefined;
}

export function parseStoredAccount(value: unknown, source: string): AccountConfig {
  const raw = objectMap(value, source);
  const parsed = accountSchema.safeParse({ ...raw, authType: normalizeLegacyAuthType(raw.authType) });
  if (!parsed.success) malformedAccountStore(source);
  return parsed.data;
}

export function parseStoredCredential(value: unknown, source: string): CredentialEntry {
  const parsed = credentialSchema.safeParse(value);
  if (!parsed.success) malformedAccountStore(source);
  return parsed.data;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

export function canonicalizeAccount(account: AccountConfig) {
  const models = account.models ? [...new Set(account.models.map((model) => model.trim()).filter(Boolean))].sort() : [];
  const aliases = Object.fromEntries(
    Object.entries(account.modelAliases ?? {})
      .map(([alias, model]) => [alias.trim(), model.trim()])
      .filter(([alias, model]) => alias && model),
  );
  return {
    authType: normalizeLegacyAuthType(account.authType) ?? malformedAccountStore('account authType'),
    ...(account.clientId ? { clientId: account.clientId.trim() } : {}),
    ...(account.baseUrl?.trim() ? { baseUrl: account.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(account.displayName?.trim() ? { displayName: account.displayName.trim() } : {}),
    ...(models.length ? { models } : {}),
    ...(Object.keys(aliases).length ? { modelAliases: aliases } : {}),
    ...(Object.keys(account.envVars ?? {}).length ? { envVars: account.envVars } : {}),
  };
}

/** v1 nested provider families and v2/v3 flat providers/profiles share this decoder. */
export function parseLegacyProviderProfiles(value: unknown): Record<string, AccountConfig>;
export function parseLegacyProviderProfiles(
  value: unknown,
  deferEntryErrors: true,
): Record<string, AccountConfig | AccountStoreVerdictError>;
export function parseLegacyProviderProfiles(
  value: unknown,
  deferEntryErrors = false,
): Record<string, AccountConfig | AccountStoreVerdictError> {
  const meta = objectMap(value, 'provider-profiles.json');
  const raw = meta.providers === undefined ? meta.profiles : meta.providers;
  if (raw === undefined) return {};
  const entries = Array.isArray(raw)
    ? raw
    : Object.values(objectMap(raw, 'provider-profiles.json')).flatMap((entry) => {
        const group = objectMap(entry, 'provider-profiles.json');
        if (group.profiles === undefined) return [group];
        if (!Array.isArray(group.profiles)) malformedAccountStore('provider-profiles.json profiles');
        return group.profiles;
      });
  const accounts: Record<string, AccountConfig | AccountStoreVerdictError> = {};
  for (const entry of entries) {
    const profile = objectMap(entry, 'provider-profiles.json profile');
    if (typeof profile.id !== 'string' || !profile.id.trim()) malformedAccountStore('provider-profiles.json id');
    const auth = profile.authType ?? profile.mode ?? profile.kind ?? 'oauth';
    // Identifiable malformed entries can be listed as rejected without hiding other refs.
    const normalized = decodeLegacyEntry(
      () =>
        canonicalizeAccount(
          parseStoredAccount({ ...profile, authType: auth }, `provider-profiles.json account ${profile.id}`),
        ),
      deferEntryErrors,
    );
    Object.defineProperty(accounts, profile.id.trim(), { value: normalized, enumerable: true, configurable: true });
  }
  return accounts;
}

export function parseLegacyProviderSecrets(value: unknown): Record<string, CredentialEntry>;
export function parseLegacyProviderSecrets(
  value: unknown,
  deferEntryErrors: true,
): Record<string, CredentialEntry | AccountStoreVerdictError>;
export function parseLegacyProviderSecrets(
  value: unknown,
  deferEntryErrors = false,
): Record<string, CredentialEntry | AccountStoreVerdictError> {
  const meta = objectMap(value, 'provider-profiles.secrets.local.json');
  const entries =
    meta.profiles !== undefined
      ? Object.entries(objectMap(meta.profiles, 'provider-profiles.secrets.local.json profiles'))
      : Object.values(
          objectMap(
            meta.providers === undefined ? {} : meta.providers,
            'provider-profiles.secrets.local.json providers',
          ),
        ).flatMap((group) => Object.entries(objectMap(group, 'provider-profiles.secrets.local.json family')));
  return Object.fromEntries(
    entries.map(([ref, secret]) => [
      ref,
      decodeLegacyEntry(
        () => parseStoredCredential(secret, `provider-profiles.secrets.local.json credential ${ref}`),
        deferEntryErrors,
      ),
    ]),
  );
}

function decodeLegacyEntry<T>(decode: () => T, deferErrors: boolean): T | AccountStoreVerdictError {
  try {
    return decode();
  } catch (error) {
    if (!deferErrors || !(error instanceof AccountStoreVerdictError)) throw error;
    return error;
  }
}
