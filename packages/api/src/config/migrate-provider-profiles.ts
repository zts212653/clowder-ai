/**
 * F136 Phase 4a — Migrate provider-profiles.json → accounts + credentials
 *
 * HC-3: One-time migration. Does NOT delete old files (留一版本兼容窗口).
 * Writes marker file to prevent re-migration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccountConfig, AccountProtocol, CredentialEntry } from '@cat-cafe/shared';
import { readCatCatalog, writeCatCatalog } from './cat-catalog-store.js';
import { writeCredential } from './credentials.js';

// Inline legacy types needed for migration (originally from provider-profiles.types.ts)
interface ProviderProfileMeta {
  id: string;
  displayName: string;
  kind: 'builtin' | 'api_key';
  authType: 'oauth' | 'api_key';
  builtin: boolean;
  client?: string;
  protocol?: AccountProtocol;
  baseUrl?: string;
  models?: string[];
  createdAt: string;
  updatedAt: string;
}
interface ProviderProfilesMetaFile {
  version: 3;
  activeProfileId: string | null;
  providers: ProviderProfileMeta[];
  bootstrapBindings: Record<string, unknown>;
}
interface ProviderProfilesSecretsFile {
  version: 3;
  profiles: Record<string, { apiKey?: string }>;
}

const CAT_CAFE_DIR = '.cat-cafe';
const META_FILENAME = 'provider-profiles.json';
const SECRETS_FILENAME = 'provider-profiles.secrets.local.json';
export interface MigrationResult {
  migrated: boolean;
  reason?: 'no-source' | 'already-migrated' | 'no-catalog';
  accountsMigrated?: number;
  credentialsMigrated?: number;
}

function resolveGlobalRoot(): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  return homedir();
}

function resolveGlobalPath(filename: string): string {
  return resolve(resolveGlobalRoot(), CAT_CAFE_DIR, filename);
}

/**
 * LL-043: Check if legacy provider-profiles.json represents a real migration source.
 * - File missing → false (nothing to migrate)
 * - File exists but unparseable → true (corrupt = legacy source present, invariant should fire)
 * - File exists, parses OK, zero providers → false (empty = nothing was ever configured)
 * - File exists, parses OK, has providers → true (should have been migrated)
 */
export function hasLegacyProviderProfiles(): boolean {
  if (!existsSync(resolveGlobalPath(META_FILENAME))) return false;
  const meta = readOldMeta(); // returns null on parse failure
  if (meta === null) return true; // corrupt file = legacy source present
  return (meta.providers?.length ?? 0) > 0;
}

/**
 * Per-project migration detection: check if ALL old profile IDs already exist
 * in the project's catalog accounts. Stateless — no global marker file.
 */
function isProjectMigrated(profiles: ProviderProfileMeta[], existingAccounts: Record<string, unknown>): boolean {
  if (profiles.length === 0) return true;
  return profiles.every((p) => p.id in existingAccounts);
}

function readOldMeta(): ProviderProfilesMetaFile | null {
  const path = resolveGlobalPath(META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ProviderProfilesMetaFile;
  } catch {
    return null;
  }
}

function readOldSecrets(): Record<string, { apiKey?: string }> {
  const path = resolveGlobalPath(SECRETS_FILENAME);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as ProviderProfilesSecretsFile;
    return data.profiles ?? {};
  } catch {
    return {};
  }
}

function toAccountProtocol(protocol: string | undefined): AccountProtocol {
  if (protocol === 'anthropic' || protocol === 'openai' || protocol === 'google') return protocol;
  return 'openai'; // safe default for custom API-key accounts
}

function profileToAccountConfig(profile: ProviderProfileMeta): AccountConfig {
  return {
    authType: profile.authType ?? 'api_key',
    protocol: toAccountProtocol(profile.protocol),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(profile.models && profile.models.length > 0 ? { models: profile.models } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
  };
}

export function migrateProviderProfilesToAccounts(projectRoot: string): MigrationResult {
  const oldMeta = readOldMeta();
  if (!oldMeta) {
    return { migrated: false, reason: 'no-source' };
  }

  const catalog = readCatCatalog(projectRoot);
  if (!catalog) {
    return { migrated: false, reason: 'no-catalog' };
  }

  const v2 = catalog as import('@cat-cafe/shared').CatCafeConfigV2;
  const profiles = oldMeta.providers ?? [];

  // Per-project detection: skip only if THIS project already has all old accounts
  if (isProjectMigrated(profiles, v2.accounts ?? {})) {
    return { migrated: false, reason: 'already-migrated' };
  }

  const oldSecrets = readOldSecrets();
  const accounts: Record<string, AccountConfig> = {};
  let credCount = 0;

  for (const profile of profiles) {
    // Skip profiles already present in this project's catalog
    if (v2.accounts?.[profile.id]) continue;

    accounts[profile.id] = profileToAccountConfig(profile);

    // Migrate secrets → credentials.json
    const secret = oldSecrets[profile.id];
    if (secret?.apiKey) {
      const entry: CredentialEntry = { apiKey: secret.apiKey };
      writeCredential(profile.id, entry);
      credCount++;
    }
  }

  // Write accounts into catalog (HC-2: cat-catalog.json is runtime write source)
  const mergedAccounts = { ...(v2.accounts ?? {}), ...accounts };
  writeCatCatalog(projectRoot, { ...v2, accounts: mergedAccounts });

  return {
    migrated: true,
    accountsMigrated: Object.keys(accounts).length,
    credentialsMigrated: credCount,
  };
}
