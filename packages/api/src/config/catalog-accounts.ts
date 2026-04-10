/**
 * F340 — Accounts read/write layer
 *
 * Storage: {projectRoot}/.cat-cafe/accounts.json (project-local by default).
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env → uses that root instead.
 *
 * Migrations (once per process per source):
 *   1. Legacy provider-profiles.json → accounts.json
 *   2. Project cat-catalog.json.accounts → accounts.json
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';

const CONFIG_SUBDIR = '.cat-cafe';
const ACCOUNTS_FILENAME = 'accounts.json';

function resolveGlobalRoot(projectRoot?: string): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return resolve(envRoot);
  if (projectRoot) return resolve(projectRoot);
  return homedir();
}

export function resolveAccountsPath(projectRoot?: string): string {
  return resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR, ACCOUNTS_FILENAME);
}

function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: mode ?? 0o644 });
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

function readAllGlobal(projectRoot?: string): Record<string, AccountConfig> {
  const accountsPath = resolveAccountsPath(projectRoot);
  if (!existsSync(accountsPath)) return {};
  const raw = readFileSync(accountsPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, AccountConfig>;
  } catch {
    // Fix P1-3: corrupt file → backup + warn, not silent swallow
    const backupPath = `${accountsPath}.bak`;
    try {
      copyFileSync(accountsPath, backupPath);
    } catch {
      /* best-effort backup */
    }
    console.error(`[catalog-accounts] corrupt ${accountsPath} — backed up to .bak, treating as empty`);
    return {};
  }
}

function writeAllGlobal(accounts: Record<string, AccountConfig>, projectRoot?: string): void {
  const accountsPath = resolveAccountsPath(projectRoot);
  mkdirSync(resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR), { recursive: true });
  writeFileAtomic(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`);
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function normalizeDisplayName(displayName: string | undefined): string | undefined {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeModels(models: readonly string[] | undefined): string[] | undefined {
  if (!Array.isArray(models)) return undefined;
  const normalized = Array.from(
    new Set(models.map((value) => String(value).trim()).filter((value) => value.length > 0)),
  );
  return normalized.length > 0 ? normalized.sort() : undefined;
}

function canonicalizeAccount(account: AccountConfig): {
  authType: 'oauth' | 'api_key';
  baseUrl?: string;
  displayName?: string;
  models?: string[];
} {
  return {
    authType: account.authType,
    ...(normalizeBaseUrl(account.baseUrl) ? { baseUrl: normalizeBaseUrl(account.baseUrl) } : {}),
    ...(normalizeDisplayName(account.displayName) ? { displayName: normalizeDisplayName(account.displayName) } : {}),
    ...(normalizeModels(account.models) ? { models: normalizeModels(account.models) } : {}),
  };
}

function describeAccountConflict(existing: AccountConfig, incoming: AccountConfig): string {
  const current = canonicalizeAccount(existing);
  const next = canonicalizeAccount(incoming);
  const diffs: string[] = [];

  if (current.authType !== next.authType) diffs.push(`authType ${current.authType} vs ${next.authType}`);
  if ((current.baseUrl ?? '(none)') !== (next.baseUrl ?? '(none)')) {
    diffs.push(`baseUrl ${current.baseUrl ?? '(none)'} vs ${next.baseUrl ?? '(none)'}`);
  }
  if ((current.displayName ?? '(none)') !== (next.displayName ?? '(none)')) {
    diffs.push(`displayName ${current.displayName ?? '(none)'} vs ${next.displayName ?? '(none)'}`);
  }
  if (JSON.stringify(current.models ?? []) !== JSON.stringify(next.models ?? [])) {
    diffs.push(`models ${JSON.stringify(current.models ?? [])} vs ${JSON.stringify(next.models ?? [])}`);
  }

  return diffs.join('; ');
}

function accountsEquivalent(existing: AccountConfig, incoming: AccountConfig): boolean {
  return describeAccountConflict(existing, incoming).length === 0;
}

function normalizeLegacyAuthType(value: unknown): AccountConfig['authType'] | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (normalized === 'oauth' || normalized === 'subscription' || normalized === 'builtin') return 'oauth';
  return undefined;
}

function inferLegacyAuthType(profile: Record<string, unknown>): AccountConfig['authType'] {
  return (
    normalizeLegacyAuthType(profile.authType) ??
    normalizeLegacyAuthType(profile.mode) ??
    normalizeLegacyAuthType(profile.kind) ??
    'oauth'
  );
}

/** Merge source accounts into global, preserving existing keys. */
function mergeIntoGlobal(
  source: Record<string, AccountConfig>,
  projectRoot?: string,
): { merged: string[]; skipped: string[] } {
  const global = readAllGlobal(projectRoot);
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const [ref, account] of Object.entries(source)) {
    if (ref in global) {
      if (!accountsEquivalent(global[ref], account)) {
        throw new Error(`Account conflict for "${ref}": ${describeAccountConflict(global[ref], account)}`);
      }
      skipped.push(ref);
    } else {
      global[ref] = account;
      merged.push(ref);
    }
  }
  if (merged.length > 0) writeAllGlobal(global, projectRoot);
  return { merged, skipped };
}

// ── Legacy provider-profiles.json → accounts.json migration ──

/** Migrate legacy provider-profiles.json + secrets from a given root into global accounts. */
function migrateLegacyFrom(root: string, projectRoot?: string): void {
  const metaPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.json');
  if (!existsSync(metaPath)) return;
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  // v2/v3: flat array of profiles.  v1: nested { providers: { <client>: { profiles: [...] } } }.
  const rawProviders = meta?.providers ?? meta?.profiles;
  let providers: Array<Record<string, unknown>>;
  if (Array.isArray(rawProviders)) {
    providers = rawProviders;
  } else if (rawProviders != null && typeof rawProviders === 'object') {
    providers = [];
    for (const [, val] of Object.entries(rawProviders as Record<string, unknown>)) {
      if (typeof val !== 'object' || val === null) continue;
      const obj = val as Record<string, unknown>;
      if (Array.isArray(obj.profiles)) {
        // v1 nested: { anthropic: { profiles: [{ id, ... }, ...] } }
        for (const p of obj.profiles) {
          if (typeof p === 'object' && p !== null) providers.push(p as Record<string, unknown>);
        }
      } else {
        // Simple object: treat as single provider entry
        providers.push(obj);
      }
    }
  } else {
    providers = [];
  }
  if (providers.length === 0) return;

  const accounts: Record<string, AccountConfig> = {};
  for (const p of providers) {
    const id = String(p.id ?? '').trim();
    if (!id) continue;
    const displayName = normalizeDisplayName(typeof p.displayName === 'string' ? p.displayName : undefined);
    const baseUrl = normalizeBaseUrl(typeof p.baseUrl === 'string' ? p.baseUrl : undefined);
    const models = normalizeModels(Array.isArray(p.models) ? p.models.map(String) : undefined);
    // F340: protocol not migrated — derived at runtime from well-known account IDs.
    accounts[id] = {
      authType: inferLegacyAuthType(p),
      ...(displayName ? { displayName } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(models ? { models } : {}),
    };
  }
  const { merged } = mergeIntoGlobal(accounts, projectRoot);
  const mergedSet = new Set(merged);
  // Read global state after merge for retry-safe credential import
  const globalAfterMerge = readAllGlobal(projectRoot);

  const secretsPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.secrets.local.json');
  if (!existsSync(secretsPath)) return;
  const secretsMeta = JSON.parse(readFileSync(secretsPath, 'utf-8'));
  // v2/v3: flat { profiles: { <id>: { apiKey } } }.
  // v1: nested { providers: { <client>: { <id>: { apiKey } } } }.
  let profileSecrets: Record<string, Record<string, unknown>> = {};
  if (secretsMeta?.profiles && typeof secretsMeta.profiles === 'object') {
    profileSecrets = secretsMeta.profiles;
  } else if (secretsMeta?.providers && typeof secretsMeta.providers === 'object') {
    for (const clientSecrets of Object.values(secretsMeta.providers as Record<string, unknown>)) {
      if (typeof clientSecrets === 'object' && clientSecrets !== null) {
        Object.assign(profileSecrets, clientSecrets as Record<string, Record<string, unknown>>);
      }
    }
  }
  const globalRoot = resolveGlobalRoot(projectRoot);
  const credPath = resolve(globalRoot, CONFIG_SUBDIR, 'credentials.json');
  const existing = existsSync(credPath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(credPath, 'utf-8'));
        } catch {
          return {};
        }
      })()
    : {};
  let credCount = 0;
  for (const [id, secret] of Object.entries(profileSecrets)) {
    if (!(id in accounts) || id in existing || !secret?.apiKey) continue;
    if (mergedSet.has(id)) {
      // First run: account was just merged — safe to import its secret.
      existing[id] = { apiKey: String(secret.apiKey) };
      credCount++;
    } else {
      // Retry path: account already existed in global (skipped by merge).
      // Only import if the global account's fields match what we'd migrate —
      // proves it came from a previous run of this same migration source,
      // not a collision with a different-origin account sharing the same ID.
      const g = globalAfterMerge[id];
      const l = accounts[id];
      if (g && accountsEquivalent(g, l)) {
        existing[id] = { apiKey: String(secret.apiKey) };
        credCount++;
      }
    }
  }
  if (credCount > 0) {
    mkdirSync(resolve(globalRoot, CONFIG_SUBDIR), { recursive: true });
    writeFileAtomic(credPath, `${JSON.stringify(existing, null, 2)}\n`, 0o600);
  }
}

let legacyMigrationDone = false;

function migrateLegacyProviderProfiles(projectRoot?: string): void {
  if (legacyMigrationDone) return;
  try {
    migrateLegacyFrom(resolveGlobalRoot(projectRoot), projectRoot);
    legacyMigrationDone = true;
  } catch (err) {
    console.error('[catalog-accounts] legacy→global migration failed:', err);
    throw err;
  }
}

const migratedProjectLegacy = new Set<string>();

function migrateProjectLegacyProviderProfiles(projectRoot: string): void {
  const key = resolve(projectRoot);
  if (migratedProjectLegacy.has(key)) return;
  try {
    migrateLegacyFrom(key, projectRoot);
    migratedProjectLegacy.add(key);
  } catch (err) {
    console.error(`[catalog-accounts] project legacy→global migration failed for ${key}:`, err);
    throw err;
  }
}

// ── Project catalog.accounts → global accounts.json migration ──

const migratedProjects = new Set<string>();

function migrateProjectAccountsToGlobal(projectRoot: string): void {
  const key = resolve(projectRoot);
  if (migratedProjects.has(key)) return;
  try {
    const catalogPath = resolve(projectRoot, CONFIG_SUBDIR, 'cat-catalog.json');
    if (!existsSync(catalogPath)) return;
    const raw = readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(raw);
    const projectAccounts = catalog?.accounts;
    if (!projectAccounts || typeof projectAccounts !== 'object' || Object.keys(projectAccounts).length === 0) return;

    const { merged } = mergeIntoGlobal(projectAccounts as Record<string, AccountConfig>, projectRoot);

    // F340: project catalog.accounts is intentionally left untouched.
    // Runtime only reads global accounts.json, so the project section is
    // inert — keeping it provides free rollback compatibility and avoids
    // unnecessary writes to the project catalog file.
    if (merged.length > 0) {
      console.error(`[catalog-accounts] project ${key}: ${merged.length} account(s) merged into global`);
    }
    migratedProjects.add(key);
  } catch (err) {
    // Migration is best-effort — don't mark done so next call retries.
    // But log the error so failures aren't invisible.
    console.error(`[catalog-accounts] project→global migration failed for ${key}:`, err);
    throw err;
  }
}

function ensureMigrated(projectRoot: string): void {
  migrateLegacyProviderProfiles(projectRoot);
  migrateProjectLegacyProviderProfiles(projectRoot);
  migrateProjectAccountsToGlobal(projectRoot);
}

/** Reset migration state (for tests). */
export function resetMigrationState(): void {
  legacyMigrationDone = false;
  migratedProjects.clear();
  migratedProjectLegacy.clear();
}

// ── Public API (signatures kept backward-compatible, projectRoot used for migration) ──

export function readCatalogAccounts(projectRoot: string): Record<string, AccountConfig> {
  ensureMigrated(projectRoot);
  return readAllGlobal(projectRoot);
}

export function writeCatalogAccount(projectRoot: string, ref: string, account: AccountConfig): void {
  ensureMigrated(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  accounts[ref] = account;
  writeAllGlobal(accounts, projectRoot);
}

export function deleteCatalogAccount(projectRoot: string, ref: string): void {
  ensureMigrated(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  if (!(ref in accounts)) return;
  delete accounts[ref];
  writeAllGlobal(accounts, projectRoot);
}

/** Check if legacy provider-profiles.json exists in any known location. */
export function hasLegacyProviderProfiles(projectRoot: string): boolean {
  if (existsSync(resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR, 'provider-profiles.json'))) return true;
  return existsSync(resolve(projectRoot, CONFIG_SUBDIR, 'provider-profiles.json'));
}
