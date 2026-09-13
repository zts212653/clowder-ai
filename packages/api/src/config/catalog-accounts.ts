/**
 * clowder-ai#340 — Accounts read/write layer
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
import { type AccountConfig, builtinAccountFamilyForRef } from '@cat-cafe/shared';
import {
  canonicalizeAccount,
  canonicalJson,
  parseLegacyProviderProfiles,
  parseLegacyProviderSecrets,
} from './account-store-format.js';
import { assertAccountWritable, readAccountCatalogSnapshot } from './account-store-snapshot.js';
import { resolveAccountStoreTopology, resolveAccountWriteRoot } from './account-store-topology.js';
import { assertSafeTestConfigRead, assertSafeTestConfigRoot } from './test-config-write-guard.js';

const CONFIG_SUBDIR = '.cat-cafe';
const ACCOUNTS_FILENAME = 'accounts.json';
const INSTALLER_ACCOUNT_REFS = new Set([
  'installer-anthropic',
  'installer-openai',
  'installer-google',
  'installer-kimi',
  'installer-opencode',
  'installer-managed',
]);

function resolveGlobalRoot(projectRoot?: string): string {
  return resolveAccountWriteRoot(projectRoot);
}

function assertSafeCatalogWrite(projectRoot: string | undefined, source: string): void {
  assertSafeTestConfigRoot(resolveGlobalRoot(projectRoot), source);
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
  const empty = () => Object.create(null) as Record<string, AccountConfig>;
  assertSafeTestConfigRead(resolveGlobalRoot(projectRoot), 'catalog-accounts.readAllGlobal');
  const accountsPath = resolveAccountsPath(projectRoot);
  if (!existsSync(accountsPath)) return empty();
  const raw = readFileSync(accountsPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty();
    // Re-key into a null-prototype map so refs like "toString" / "__proto__" stay data.
    const accounts = empty();
    for (const [ref, account] of Object.entries(parsed as Record<string, AccountConfig>)) {
      Object.defineProperty(accounts, ref, {
        value: account,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return accounts;
  } catch {
    // Fix P1-3: corrupt file → backup + warn, not silent swallow
    const backupPath = `${accountsPath}.bak`;
    try {
      assertSafeCatalogWrite(projectRoot, 'catalog-accounts.readAllGlobal.backup');
      copyFileSync(accountsPath, backupPath);
    } catch {
      /* best-effort backup */
    }
    console.error(`[catalog-accounts] corrupt ${accountsPath} — backed up to .bak, treating as empty`);
    return empty();
  }
}

function writeAllGlobal(accounts: Record<string, AccountConfig>, projectRoot?: string): void {
  assertSafeCatalogWrite(projectRoot, 'catalog-accounts.writeAllGlobal');
  const accountsPath = resolveAccountsPath(projectRoot);
  mkdirSync(resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR), { recursive: true });
  writeFileAtomic(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`);
}

function describeAccountConflict(existing: AccountConfig, incoming: AccountConfig): string {
  const current = canonicalizeAccount(existing);
  const next = canonicalizeAccount(incoming);
  const diffs: string[] = [];

  if (current.authType !== next.authType) diffs.push(`authType ${current.authType} vs ${next.authType}`);
  if (current.clientId !== next.clientId) diffs.push('clientId differs');
  if (canonicalJson(current.envVars) !== canonicalJson(next.envVars)) diffs.push('envVars differ');
  if ((current.baseUrl ?? '(none)') !== (next.baseUrl ?? '(none)')) {
    diffs.push(`baseUrl ${current.baseUrl ?? '(none)'} vs ${next.baseUrl ?? '(none)'}`);
  }
  if ((current.displayName ?? '(none)') !== (next.displayName ?? '(none)')) {
    diffs.push(`displayName ${current.displayName ?? '(none)'} vs ${next.displayName ?? '(none)'}`);
  }
  if (canonicalJson(current.models ?? []) !== canonicalJson(next.models ?? [])) {
    diffs.push(`models ${JSON.stringify(current.models ?? [])} vs ${JSON.stringify(next.models ?? [])}`);
  }
  // canonicalJson sorts keys so padding/key-order-only alias differences stay equivalent.
  if (canonicalJson(current.modelAliases ?? {}) !== canonicalJson(next.modelAliases ?? {})) {
    diffs.push(
      `modelAliases ${JSON.stringify(current.modelAliases ?? {})} vs ${JSON.stringify(next.modelAliases ?? {})}`,
    );
  }

  return diffs.join('; ');
}

function accountsEquivalent(existing: AccountConfig, incoming: AccountConfig): boolean {
  return describeAccountConflict(existing, incoming).length === 0;
}

function collectAccountRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAccountRefs(item, refs);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'accountRef' || key === 'providerProfileId') && typeof nested === 'string' && nested.trim()) {
      refs.add(nested.trim());
    } else collectAccountRefs(nested, refs);
  }
}

function collectRootCatalogAccountKeys(value: unknown, refs: Set<string>): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const accounts = (value as Record<string, unknown>).accounts;
  if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) return;
  for (const ref of Object.keys(accounts)) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }
}

function readProjectAccountRefs(projectRoot: string): Set<string> {
  assertSafeTestConfigRead(projectRoot, 'catalog-accounts.readProjectAccountRefs.source');
  const refs = new Set<string>();
  const catalogPath = resolve(projectRoot, CONFIG_SUBDIR, 'cat-catalog.json');
  if (!existsSync(catalogPath)) return refs;
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    collectAccountRefs(catalog, refs);
    collectRootCatalogAccountKeys(catalog, refs);
  } catch {
    return refs;
  }
  return refs;
}

function isInstallerAccountRef(ref: string): boolean {
  return INSTALLER_ACCOUNT_REFS.has(ref);
}

// Cross-root homedir legacy import is an upgrade rescue path, not global account sync.
// Keep installer/builtin compatibility and project-bound custom accounts, but do not
// copy old experimental profiles into every project-local runtime.
function shouldImportCrossRootHomedirAccount(ref: string, referencedRefs: Set<string>): boolean {
  return builtinAccountFamilyForRef(ref) !== null || isInstallerAccountRef(ref) || referencedRefs.has(ref);
}

/** Merge source accounts into global, preserving existing keys. */
function mergeIntoGlobal(
  source: Record<string, AccountConfig>,
  projectRoot?: string,
  opts?: { skipConflicts?: boolean },
): { merged: string[]; skipped: string[] } {
  const global = readAllGlobal(projectRoot);
  const merged: string[] = [];
  const skipped: string[] = [];
  for (const [ref, account] of Object.entries(source)) {
    if (ref in global) {
      if (!accountsEquivalent(global[ref], account)) {
        if (opts?.skipConflicts) {
          console.error(
            `[catalog-accounts] conflict for "${ref}" — global wins: ${describeAccountConflict(global[ref], account)}`,
          );
          skipped.push(ref);
          continue;
        }
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
function migrateLegacyFrom(
  root: string,
  projectRoot?: string,
  opts?: { shouldImportAccount?: (ref: string, account: AccountConfig) => boolean },
): void {
  // Guard the migration source root before fingerprinting/opening any file.
  assertSafeTestConfigRead(root, 'catalog-accounts.migrateLegacyFrom.source');
  const metaPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.json');
  if (!existsSync(metaPath)) return;
  const parsed = parseLegacyProviderProfiles(JSON.parse(readFileSync(metaPath, 'utf-8')));
  // Do not use Object.fromEntries here: a ref named "__proto__" corrupts [[Prototype]].
  const accounts = Object.create(null) as Record<string, AccountConfig>;
  for (const [ref, account] of Object.entries(parsed)) {
    if (opts?.shouldImportAccount && !opts.shouldImportAccount(ref, account)) continue;
    Object.defineProperty(accounts, ref, {
      value: account,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (Object.keys(accounts).length === 0) return;
  const { merged } = mergeIntoGlobal(accounts, projectRoot, { skipConflicts: true });
  const mergedSet = new Set(merged);
  // Read global state after merge for retry-safe credential import
  const globalAfterMerge = readAllGlobal(projectRoot);

  const secretsPath = resolve(root, CONFIG_SUBDIR, 'provider-profiles.secrets.local.json');
  if (!existsSync(secretsPath)) return;
  const profileSecrets = parseLegacyProviderSecrets(JSON.parse(readFileSync(secretsPath, 'utf-8')));
  const globalRoot = resolveGlobalRoot(projectRoot);
  const credPath = resolve(globalRoot, CONFIG_SUBDIR, 'credentials.json');
  const existing = Object.create(null) as Record<string, { apiKey: string }>;
  if (existsSync(credPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [ref, entry] of Object.entries(parsed as Record<string, { apiKey: string }>)) {
          Object.defineProperty(existing, ref, {
            value: entry,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
    } catch {
      /* treat as empty */
    }
  }
  let credCount = 0;
  const writeCred = (id: string, apiKey: string) => {
    Object.defineProperty(existing, id, {
      value: { apiKey },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    credCount++;
  };
  for (const [id, secret] of Object.entries(profileSecrets)) {
    if (!(id in accounts) || Object.hasOwn(existing, id) || !secret?.apiKey) continue;
    if (mergedSet.has(id)) {
      // First run: account was just merged — safe to import its secret.
      writeCred(id, String(secret.apiKey));
    } else {
      // Retry path: account already existed in global (skipped by merge).
      // Only import if the global account's fields match what we'd migrate —
      // proves it came from a previous run of this same migration source,
      // not a collision with a different-origin account sharing the same ID.
      const g = globalAfterMerge[id];
      const l = accounts[id];
      if (g && accountsEquivalent(g, l)) {
        writeCred(id, String(secret.apiKey));
      }
    }
  }
  if (credCount > 0) {
    assertSafeCatalogWrite(projectRoot, 'catalog-accounts.migrateLegacyFrom.credentials');
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
    // Guard before existsSync/open so a cached earlier phase cannot bypass the reader.
    assertSafeTestConfigRead(projectRoot, 'catalog-accounts.migrateProjectAccountsToGlobal.source');
    const catalogPath = resolve(projectRoot, CONFIG_SUBDIR, 'cat-catalog.json');
    if (!existsSync(catalogPath)) return;
    const raw = readFileSync(catalogPath, 'utf-8');
    const catalog = JSON.parse(raw);
    const projectAccounts = catalog?.accounts;
    if (!projectAccounts || typeof projectAccounts !== 'object' || Object.keys(projectAccounts).length === 0) return;

    const { merged } = mergeIntoGlobal(projectAccounts as Record<string, AccountConfig>, projectRoot, {
      skipConflicts: true,
    });

    // clowder-ai#340: project catalog.accounts is intentionally left untouched.
    // Runtime only reads global accounts.json, so the project section is
    // inert — keeping it provides free rollback compatibility and avoids
    // unnecessary writes to the project catalog file.
    if (merged.length > 0) {
      console.error(`[catalog-accounts] project ${key}: ${merged.length} account(s) merged into global`);
    }
    migratedProjects.add(key);
  } catch (err) {
    // Never swallow test-sandbox refusals — they must fail the caller closed.
    if (err instanceof Error && err.message.includes('[test sandbox] Refusing')) throw err;
    // Best-effort: log and mark done to avoid retry loops on persistent
    // errors (corrupt catalog JSON, permission issues, etc.).
    console.error(`[catalog-accounts] project→global migration failed for ${key}:`, err);
    migratedProjects.add(key);
  }
}

// ── Homedir legacy migration (picks up secrets written by pre-clowder-ai#340 installer without --project-dir) ──

const migratedHomedirLegacy = new Set<string>();

function projectScopedMigrationKey(resolvedTarget: string, projectRoot?: string): string {
  return `${resolvedTarget}\0${projectRoot ? resolve(projectRoot) : ''}`;
}

function migrateHomedirLegacyProviderProfiles(projectRoot?: string): void {
  const globalRoot = resolveGlobalRoot(projectRoot);
  const resolvedTarget = resolve(globalRoot);
  const migrationKey = projectScopedMigrationKey(resolvedTarget, projectRoot);
  if (migratedHomedirLegacy.has(migrationKey)) return;
  const home = homedir();
  if (resolvedTarget === resolve(home)) {
    // Global root IS homedir — already covered by migrateLegacyProviderProfiles.
    migratedHomedirLegacy.add(migrationKey);
    return;
  }
  try {
    const referencedRefs = projectRoot ? readProjectAccountRefs(projectRoot) : new Set<string>();
    migrateLegacyFrom(home, projectRoot, {
      shouldImportAccount: (ref) => shouldImportCrossRootHomedirAccount(ref, referencedRefs),
    });
    migratedHomedirLegacy.add(migrationKey);
  } catch (err) {
    // Only swallow parse/read errors (corrupt homedir files). Re-throw account
    // conflicts and other migration errors so callers get a fail-fast signal.
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes('ENOENT'))) {
      console.error('[catalog-accounts] homedir legacy→global migration failed (corrupt source, skipped):', err);
      migratedHomedirLegacy.add(migrationKey);
    } else {
      throw err;
    }
  }
}

// ── Homedir credentials.json migration (pre-clowder-ai#340 credentials written directly to homedir) ──

const migratedHomedirCredentials = new Set<string>();

function migrateHomedirCredentials(projectRoot?: string): void {
  const globalRoot = resolveGlobalRoot(projectRoot);
  const resolvedTarget = resolve(globalRoot);
  const migrationKey = projectScopedMigrationKey(resolvedTarget, projectRoot);
  if (migratedHomedirCredentials.has(migrationKey)) return;
  const home = homedir();
  if (resolvedTarget === resolve(home)) {
    migratedHomedirCredentials.add(migrationKey);
    return;
  }
  // Guard both physical roots before the first open (P1-8 / P1-9).
  assertSafeTestConfigRead(home, 'catalog-accounts.migrateHomedirCredentials.source');
  assertSafeTestConfigRead(globalRoot, 'catalog-accounts.migrateHomedirCredentials.target');
  const homeCredPath = resolve(home, CONFIG_SUBDIR, 'credentials.json');
  if (!existsSync(homeCredPath)) {
    migratedHomedirCredentials.add(migrationKey);
    return;
  }
  try {
    const homeCreds = JSON.parse(readFileSync(homeCredPath, 'utf-8'));
    if (typeof homeCreds !== 'object' || homeCreds === null || Array.isArray(homeCreds)) {
      migratedHomedirCredentials.add(migrationKey);
      return;
    }
    const targetCredPath = resolve(globalRoot, CONFIG_SUBDIR, 'credentials.json');
    let targetCreds: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (existsSync(targetCredPath)) {
      try {
        const parsed = JSON.parse(readFileSync(targetCredPath, 'utf-8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [ref, entry] of Object.entries(parsed as Record<string, unknown>)) {
            Object.defineProperty(targetCreds, ref, {
              value: entry,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
        }
      } catch {
        targetCreds = Object.create(null) as Record<string, unknown>;
      }
    }
    let imported = 0;
    const referencedRefs = projectRoot ? readProjectAccountRefs(projectRoot) : new Set<string>();
    const targetAccounts = readAllGlobal(projectRoot);
    for (const [ref, entry] of Object.entries(homeCreds)) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        !Object.hasOwn(targetCreds, ref) &&
        (Object.hasOwn(targetAccounts, ref) || shouldImportCrossRootHomedirAccount(ref, referencedRefs))
      ) {
        Object.defineProperty(targetCreds, ref, {
          value: entry,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        imported++;
      }
    }
    if (imported > 0) {
      assertSafeCatalogWrite(projectRoot, 'catalog-accounts.migrateHomedirCredentials');
      mkdirSync(resolve(globalRoot, CONFIG_SUBDIR), { recursive: true });
      writeFileAtomic(targetCredPath, `${JSON.stringify(targetCreds, null, 2)}\n`, 0o600);
      console.error(
        `[catalog-accounts] homedir credentials.json: ${imported} credential(s) merged into ${resolvedTarget}`,
      );
    }
    migratedHomedirCredentials.add(migrationKey);
  } catch (err) {
    if (err instanceof SyntaxError || (err instanceof Error && err.message.includes('ENOENT'))) {
      console.error('[catalog-accounts] homedir credentials.json migration failed (corrupt source, skipped):', err);
      migratedHomedirCredentials.add(migrationKey);
    } else {
      throw err;
    }
  }
}

export function migrateCatalogAccounts(projectRoot: string): void {
  // Explicit format upgrades may touch the primary store, but never cut over runtime data.
  const topology = resolveAccountStoreTopology(projectRoot);
  if (topology.legacyRoot) projectRoot = topology.primaryRoot;
  // #506 source-owned intake: keep legacy homedir migrations for upgrades,
  // but allow new installs / opensource profile to opt out explicitly.
  const skipHomedirMigration = process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION === '1';
  if (!skipHomedirMigration) {
    // Keep the original "credentials first" ordering so skip-existing semantics
    // still prefer imported secrets before legacy profile migration runs.
    migrateHomedirCredentials(projectRoot);
  }
  migrateLegacyProviderProfiles(projectRoot);
  migrateProjectLegacyProviderProfiles(projectRoot);
  if (!skipHomedirMigration) {
    // Preserve the pre-intake ordering: homedir legacy profiles remain after
    // project-scoped legacy sources, only gated by the new skip flag.
    migrateHomedirLegacyProviderProfiles(projectRoot);
  }
  migrateProjectAccountsToGlobal(projectRoot);
}

/** Reset migration state (for tests). */
export function resetMigrationState(): void {
  legacyMigrationDone = false;
  migratedHomedirLegacy.clear();
  migratedHomedirCredentials.clear();
  migratedProjects.clear();
  migratedProjectLegacy.clear();
}

// ── Public API (signatures kept backward-compatible, projectRoot used for migration) ──

export function readCatalogAccounts(projectRoot: string): Record<string, AccountConfig> {
  // Ordinary reads are pure (upstream contract). Migration runs only from
  // accountStartupHook / writeCatalogAccount / explicit migrateCatalogAccounts.
  return readAccountCatalogSnapshot(projectRoot);
}

export function writeCatalogAccount(projectRoot: string, ref: string, account: AccountConfig): void {
  assertAccountWritable(projectRoot, ref);
  migrateCatalogAccounts(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  accounts[ref] = account;
  writeAllGlobal(accounts, projectRoot);
}

export function deleteCatalogAccount(projectRoot: string, ref: string): void {
  assertAccountWritable(projectRoot, ref);
  migrateCatalogAccounts(projectRoot);
  const accounts = readAllGlobal(projectRoot);
  if (!(ref in accounts)) return;
  delete accounts[ref];
  writeAllGlobal(accounts, projectRoot);
}

/** Check if legacy provider-profiles.json exists in any known location. */
export function hasLegacyProviderProfiles(projectRoot: string): boolean {
  // P1-11: an existence probe is still a read of that root; this reader runs no
  // migration first — it is always its own first open.
  assertSafeTestConfigRead(resolveGlobalRoot(projectRoot), 'catalog-accounts.hasLegacyProviderProfiles.store');
  if (existsSync(resolve(resolveGlobalRoot(projectRoot), CONFIG_SUBDIR, 'provider-profiles.json'))) return true;
  assertSafeTestConfigRead(projectRoot, 'catalog-accounts.hasLegacyProviderProfiles.project');
  return existsSync(resolve(projectRoot, CONFIG_SUBDIR, 'provider-profiles.json'));
}
