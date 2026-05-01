#!/usr/bin/env node

/**
 * F340: Auth config installer — writes directly to accounts + credentials.
 *
 * Storage: {projectRoot}/.cat-cafe/accounts.json + credentials.json (project-local by default).
 * Override: CAT_CAFE_GLOBAL_CONFIG_ROOT env → uses that root instead.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F340: protocol removed — builtins derive protocol from well-known ID at runtime.
const BUILTIN_ACCOUNT_SPECS = [
  {
    id: 'claude',
    displayName: 'Claude',
    client: 'anthropic',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101'],
  },
  { id: 'codex', displayName: 'Codex', client: 'openai', models: ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.3-codex-spark'] },
  { id: 'gemini', displayName: 'Gemini', client: 'google', models: ['gemini-3.1-pro-preview', 'gemini-2.5-pro'] },
  { id: 'kimi', displayName: 'Kimi', client: 'kimi', models: ['kimi-code/kimi-for-coding'] },
  { id: 'dare', displayName: 'Dare', client: 'dare', models: ['z-ai/glm-4.7'] },
  { id: 'opencode', displayName: 'OpenCode', client: 'opencode', models: ['claude-opus-4-6', 'claude-sonnet-4-5'] },
];

const CONFIG_SUBDIR = '.cat-cafe';
const TEST_SANDBOX_ENV = 'CAT_CAFE_TEST_SANDBOX';
const TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV = 'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT';
const BUILTIN_ACCOUNT_REFS = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi',
  'dare',
  'opencode',
  'anthropic',
  'openai',
  'google',
  'builtin_anthropic',
  'builtin_openai',
  'builtin_google',
  'builtin_kimi',
  'builtin_dare',
  'builtin_opencode',
]);
const INSTALLER_ACCOUNT_REFS = new Set([
  'installer-anthropic',
  'installer-openai',
  'installer-google',
  'installer-kimi',
  'installer-dare',
  'installer-opencode',
  'installer-managed',
]);
// NOTE: duplicated in packages/api/src/config/test-config-write-guard.ts because this
// standalone script cannot import the TS helper directly. Keep the two guards in sync.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Set by CLI entry point — determines where accounts/credentials are stored
// when CAT_CAFE_GLOBAL_CONFIG_ROOT is not set (matches runtime behavior).
let _activeProjectDir = '';

function usage() {
  console.error(`Usage:
  node scripts/install-auth-config.mjs env-apply --env-file FILE [--set KEY=VALUE]... [--delete KEY]...
  node scripts/install-auth-config.mjs client-auth set --project-dir DIR --client CLIENT --mode oauth|api_key [--display-name NAME] [--api-key KEY] [--base-url URL]
    API key can also be passed via _INSTALLER_API_KEY env var (preferred for security).
  node scripts/install-auth-config.mjs client-auth remove --project-dir DIR --client CLIENT [--force true]
  node scripts/install-auth-config.mjs claude-profile set --project-dir DIR [--api-key KEY] [--base-url URL] [--model MODEL]
  node scripts/install-auth-config.mjs claude-profile remove --project-dir DIR [--force true]`);
  process.exit(1);
}

function parseArgs(argv) {
  const positionals = [];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) usage();
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(next);
    index += 1;
  }
  return { positionals, values };
}

function getRequired(values, key) {
  const value = values.get(key)?.[0];
  if (!value) usage();
  return value;
}

function getOptional(values, key, fallback = '') {
  return values.get(key)?.[0] ?? fallback;
}

// ── Env file helpers (unchanged) ──

function envQuote(value) {
  const stringValue = String(value).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  if (!stringValue.includes("'")) return `'${stringValue}'`;
  return `"${stringValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function applyEnvChanges(envFile, setPairs, deleteKeys) {
  const existing = existsSync(envFile)
    ? readFileSync(envFile, 'utf8')
        .split(/\r?\n/)
        .filter((line, index, lines) => !(index === lines.length - 1 && line === ''))
    : [];
  const setMap = new Map();
  for (const pair of setPairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) usage();
    setMap.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const deleteSet = new Set(deleteKeys);
  const filtered = existing.filter((line) => {
    const separator = line.indexOf('=');
    if (separator === -1) return true;
    const key = line.slice(0, separator);
    return !deleteSet.has(key) && !setMap.has(key);
  });
  for (const [key, value] of setMap.entries()) filtered.push(`${key}=${envQuote(value)}`);
  writeFileSync(envFile, filtered.length > 0 ? `${filtered.join('\n')}\n` : '', 'utf8');
}

// ── Global file helpers ──

function resolveGlobalRoot() {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  if (envRoot) return path.resolve(envRoot);
  if (_activeProjectDir) return path.resolve(_activeProjectDir);
  return homedir();
}

function assertSafeTestConfigRoot(targetRoot, source) {
  if (process.env[TEST_SANDBOX_ENV] !== '1') return;
  if (process.env[TEST_SANDBOX_ALLOW_UNSAFE_ROOT_ENV] === '1') return;

  const resolvedTarget = path.resolve(targetRoot);
  const resolvedHome = path.resolve(process.env.CAT_CAFE_TEST_REAL_HOME || homedir());
  const unsafeTargets = [];
  if (resolvedTarget === REPO_ROOT) unsafeTargets.push(`repo root (${REPO_ROOT})`);
  if (resolvedTarget === resolvedHome) unsafeTargets.push(`HOME (${resolvedHome})`);
  if (unsafeTargets.length === 0) return;

  throw new Error(
    `[test sandbox] Refusing ${source} write/migration against ${unsafeTargets.join(' / ')}. ` +
      'Use a temp project root or explicit CAT_CAFE_GLOBAL_CONFIG_ROOT for isolation.',
  );
}

function globalDir() {
  return path.join(resolveGlobalRoot(), CONFIG_SUBDIR);
}

function writeFileAtomic(filePath, content, mode) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, 'utf-8');
  try {
    renameSync(tempPath, filePath);
    if (mode) chmodSync(filePath, mode);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readAccounts() {
  const file = path.join(globalDir(), 'accounts.json');
  const raw = readJson(file, {}); // throws on corrupt → fail fast
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
}

function writeAccounts(accounts) {
  mkdirSync(globalDir(), { recursive: true });
  writeFileAtomic(path.join(globalDir(), 'accounts.json'), `${JSON.stringify(accounts, null, 2)}\n`);
}

function readCredentials() {
  const file = path.join(globalDir(), 'credentials.json');
  const raw = readJson(file, {});
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
}

function writeCredentials(creds) {
  mkdirSync(globalDir(), { recursive: true });
  writeFileAtomic(path.join(globalDir(), 'credentials.json'), `${JSON.stringify(creds, null, 2)}\n`, 0o600);
}

// ── Normalization helpers ──

function normalizeClient(rawClient) {
  const trimmed = rawClient?.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'anthropic' || trimmed === 'claude') return 'anthropic';
  if (trimmed === 'openai' || trimmed === 'codex') return 'openai';
  if (trimmed === 'google' || trimmed === 'gemini') return 'google';
  if (trimmed === 'kimi' || trimmed === 'moonshot') return 'kimi';
  if (trimmed === 'dare') return 'dare';
  if (trimmed === 'opencode') return 'opencode';
  return null;
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = baseUrl?.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : undefined;
}

function normalizeDisplayName(displayName) {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeModelValue(value) {
  const trimmed = String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .replace(/(?:\[[0-9;]*m)+$/g, '')
    .trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeModels(models) {
  if (!Array.isArray(models)) return undefined;
  const normalized = Array.from(new Set(models.map(normalizeModelValue).filter((value) => value && value.length > 0)));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeModels(models) {
  const normalized = sanitizeModels(models);
  return normalized ? [...normalized].sort() : undefined;
}

function canonicalizeAccount(account) {
  return {
    authType: account.authType,
    ...(normalizeBaseUrl(account.baseUrl) ? { baseUrl: normalizeBaseUrl(account.baseUrl) } : {}),
    ...(normalizeDisplayName(account.displayName) ? { displayName: normalizeDisplayName(account.displayName) } : {}),
    ...(normalizeModels(account.models) ? { models: normalizeModels(account.models) } : {}),
  };
}

function describeAccountConflict(existing, incoming) {
  const current = canonicalizeAccount(existing);
  const next = canonicalizeAccount(incoming);
  const diffs = [];

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

function accountsEquivalent(existing, incoming) {
  return describeAccountConflict(existing, incoming).length === 0;
}

function normalizeLegacyAuthType(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === 'api_key') return 'api_key';
  if (normalized === 'oauth' || normalized === 'subscription') return 'oauth';
  return undefined;
}

function inferLegacyAuthType(profile) {
  return (
    normalizeLegacyAuthType(profile?.authType) ??
    normalizeLegacyAuthType(profile?.mode) ??
    normalizeLegacyAuthType(profile?.kind) ??
    'oauth'
  );
}

function flattenLegacyProfilesEntry(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.profiles)) {
    return value.profiles.filter((profile) => profile && typeof profile === 'object');
  }
  return [value];
}

function flattenLegacyProfiles(meta) {
  const rawProviders = meta?.providers ?? meta?.profiles;
  if (Array.isArray(rawProviders)) return rawProviders;
  if (!rawProviders || typeof rawProviders !== 'object') return [];
  return Object.values(rawProviders).flatMap(flattenLegacyProfilesEntry);
}

function flattenLegacyProfileSecrets(secretsMeta) {
  if (secretsMeta?.profiles && typeof secretsMeta.profiles === 'object') return secretsMeta.profiles;
  const profileSecrets = {};
  if (secretsMeta?.providers && typeof secretsMeta.providers === 'object') {
    for (const clientSecrets of Object.values(secretsMeta.providers)) {
      if (clientSecrets && typeof clientSecrets === 'object') Object.assign(profileSecrets, clientSecrets);
    }
  }
  return profileSecrets;
}

function builtinAccountIdForClient(client) {
  const spec = BUILTIN_ACCOUNT_SPECS.find((s) => s.client === client);
  if (!spec) throw new Error(`Unsupported client "${client}"`);
  return spec.id;
}

function collectAccountRefs(value, refs) {
  if (Array.isArray(value)) {
    for (const item of value) collectAccountRefs(item, refs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'accountRef' || key === 'providerProfileId') && typeof nested === 'string' && nested.trim()) {
      refs.add(nested.trim());
    } else collectAccountRefs(nested, refs);
  }
}

function collectRootCatalogAccountKeys(value, refs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const accounts = value.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return;
  for (const ref of Object.keys(accounts)) {
    const normalized = ref.trim();
    if (normalized) refs.add(normalized);
  }
}

function readProjectAccountRefs(projectDir) {
  const refs = new Set();
  if (!projectDir) return refs;
  const catalogFile = path.join(projectDir, CONFIG_SUBDIR, 'cat-catalog.json');
  if (!existsSync(catalogFile)) return refs;
  try {
    const catalog = readJson(catalogFile, {});
    collectAccountRefs(catalog, refs);
    collectRootCatalogAccountKeys(catalog, refs);
  } catch {
    return refs;
  }
  return refs;
}

function isInstallerAccountRef(ref) {
  return INSTALLER_ACCOUNT_REFS.has(ref);
}

// Cross-root homedir legacy import is an upgrade rescue path, not global account sync.
// Keep installer/builtin compatibility and project-bound custom accounts, but do not
// copy old experimental profiles into every project-local runtime.
function shouldImportCrossRootHomedirAccount(ref, referencedRefs) {
  return BUILTIN_ACCOUNT_REFS.has(ref) || isInstallerAccountRef(ref) || referencedRefs.has(ref);
}

// ── Legacy migration (v2/v3 provider-profiles → accounts+credentials) ──

function migrateLegacyProfiles(projectDir, opts = {}) {
  const profileDir = projectDir ? path.join(projectDir, CONFIG_SUBDIR) : globalDir();
  const metaFile = path.join(profileDir, 'provider-profiles.json');
  if (!existsSync(metaFile)) return;
  const meta = readJson(metaFile, null); // throws on corrupt — intentional (fail fast)
  const providers = flattenLegacyProfiles(meta);
  if (providers.length === 0) return;

  const accounts = readAccounts();
  const legacyAccounts = {};
  const mergedIds = new Set();
  for (const p of providers) {
    const id = String(p.id ?? '').trim();
    if (!id) continue;
    // F340: protocol not migrated — derived at runtime from well-known account IDs.
    const normalizedAccount = {
      authType: inferLegacyAuthType(p),
      ...(normalizeDisplayName(typeof p.displayName === 'string' ? p.displayName : undefined)
        ? { displayName: normalizeDisplayName(String(p.displayName)) }
        : {}),
      ...(normalizeBaseUrl(typeof p.baseUrl === 'string' ? p.baseUrl : undefined)
        ? { baseUrl: normalizeBaseUrl(String(p.baseUrl)) }
        : {}),
      ...(normalizeModels(Array.isArray(p.models) ? p.models.map(String) : undefined)
        ? { models: normalizeModels(p.models.map(String)) }
        : {}),
    };
    if (opts.shouldImportAccount && !opts.shouldImportAccount(id, normalizedAccount)) continue;
    legacyAccounts[id] = normalizedAccount;
    if (id in accounts) continue;
    accounts[id] = normalizedAccount;
    mergedIds.add(id);
  }
  writeAccounts(accounts);

  // Migrate secrets — import for newly merged IDs, and also for retry-safe
  // replays where the account already exists with the same canonical fields.
  const secretsFile = path.join(profileDir, 'provider-profiles.secrets.local.json');
  if (existsSync(secretsFile)) {
    const secretsMeta = readJsonSafe(secretsFile, {});
    const profileSecrets = flattenLegacyProfileSecrets(secretsMeta);
    const creds = readCredentials();
    for (const [id, secret] of Object.entries(profileSecrets)) {
      if (id in creds || !secret?.apiKey) continue;
      if (mergedIds.has(id)) {
        creds[id] = { apiKey: String(secret.apiKey) };
        continue;
      }
      const existingAccount = accounts[id];
      const legacyAccount = legacyAccounts[id];
      if (existingAccount && legacyAccount && accountsEquivalent(existingAccount, legacyAccount)) {
        creds[id] = { apiKey: String(secret.apiKey) };
      }
    }
    writeCredentials(creds);
  }
}

/** Run all legacy migration sources: projectDir, globalRoot, and homedir (if different). */
function migrateAllLegacySources(projectDir) {
  if (projectDir) migrateLegacyProfiles(projectDir);
  migrateLegacyProfiles(null); // reads from globalDir() = resolveGlobalRoot()
  // Also try homedir: pre-F340 installer without --project-dir wrote there.
  const home = homedir();
  if (path.resolve(resolveGlobalRoot()) !== path.resolve(home)) {
    try {
      const referencedRefs = readProjectAccountRefs(projectDir);
      migrateLegacyProfiles(home, {
        shouldImportAccount: (ref) => shouldImportCrossRootHomedirAccount(ref, referencedRefs),
      });
    } catch {
      // Best-effort: don't block operation if homedir legacy files are corrupt.
    }
  }
}

// ── Commands ──

function setClientAuth(client, mode, options) {
  assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.setClientAuth');
  const accountRef =
    options.profileId || (mode === 'api_key' ? `installer-${client}` : builtinAccountIdForClient(client));
  const accounts = readAccounts();

  if (mode === 'oauth') {
    const spec = BUILTIN_ACCOUNT_SPECS.find((s) => s.client === client);
    // F340: protocol not persisted on new accounts — derived from well-known ID at runtime.
    accounts[accountRef] = {
      authType: 'oauth',
      displayName: spec?.displayName ?? accountRef,
      models: sanitizeModels(spec?.models) ?? [],
    };
    // Warn about stale installer account that the resolver will prefer (has API key).
    // We intentionally do NOT auto-delete it here: installer accounts are global,
    // and we cannot safely enumerate all projects to check for bindings.
    const installerRef = `installer-${client}`;
    if (installerRef !== accountRef && accounts[installerRef]) {
      console.error(
        `[install-auth-config] warning: ${installerRef} still exists with API key — ` +
          `resolver may prefer it over OAuth. To clean it up manually once no other project depends on it, run:\n` +
          `  node scripts/install-auth-config.mjs client-auth remove --project-dir <your-project-dir> --client ${client} --force true`,
      );
    }
  } else {
    const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl);
    const normalizedModels = normalizeModels(options.models);
    accounts[accountRef] = {
      authType: 'api_key',
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
      ...(normalizedModels ? { models: normalizedModels } : {}),
    };
    const creds = readCredentials();
    creds[accountRef] = { apiKey: options.apiKey };
    writeCredentials(creds);
  }

  writeAccounts(accounts);
}

/** Scan a catalog file for variants bound to the given accountRef. */
function findBoundCats(catalogFile, profileId) {
  if (!existsSync(catalogFile)) return [];
  let catalog;
  try {
    catalog = readJson(catalogFile, null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot verify whether ${profileId} is still referenced; failed to parse ${catalogFile}: ${message}`,
    );
  }
  return (catalog?.breeds ?? [])
    .flatMap((breed) =>
      (breed?.variants ?? [])
        .filter((v) => v?.accountRef?.trim?.() === profileId)
        .map((v) => v?.catId?.trim?.() || breed?.catId?.trim?.() || breed?.id?.trim?.() || profileId),
    )
    .filter((v) => typeof v === 'string' && v.length > 0);
}

function removeClientAuth(client, profileId, projectDir, { force = false } = {}) {
  assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.removeClientAuth');
  // Step 1: Check the passed project for bindings — block if still in use.
  if (projectDir) {
    const bound = findBoundCats(path.join(projectDir, CONFIG_SUBDIR, 'cat-catalog.json'), profileId);
    if (bound.length > 0) {
      throw new Error(`Cannot remove ${profileId}; still referenced by runtime cats: ${bound.join(', ')}`);
    }
  }

  // Step 2: If the account doesn't exist, removal is already a no-op.
  const accounts = readAccounts();
  const creds = readCredentials();
  if (!(profileId in accounts) && !(profileId in creds)) return;

  // Step 3: Without --force, refuse to modify global state. Accounts and
  // credentials are shared across all projects; we cannot enumerate all
  // projects to verify no external references exist. See gpt52 R5–R8.
  if (!force) {
    throw new Error(
      `${profileId}: accounts and credentials are global (shared across projects). ` +
        `Pass --force to confirm deletion of global account + credentials for ${profileId}.`,
    );
  }

  // Step 4: --force: delete credentials + account metadata.
  if (profileId in creds) {
    delete creds[profileId];
    writeCredentials(creds);
  }

  if (profileId in accounts) {
    delete accounts[profileId];
    writeAccounts(accounts);
  }
}

// ── CLI entry point ──

try {
  const { positionals, values } = parseArgs(process.argv.slice(2));

  if (positionals[0] === 'env-apply') {
    applyEnvChanges(getRequired(values, 'env-file'), values.get('set') ?? [], values.get('delete') ?? []);
    process.exit(0);
  }

  if (positionals[0] === 'client-auth' && positionals[1] === 'set') {
    const client = normalizeClient(getRequired(values, 'client'));
    if (!client) {
      console.error('Error: unsupported client');
      process.exit(1);
    }
    // Migrate legacy files before applying
    const projDir = getOptional(values, 'project-dir', '');
    _activeProjectDir = projDir;
    assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.client-auth.set');
    migrateAllLegacySources(projDir);
    const mode = getRequired(values, 'mode');
    if (mode === 'oauth') {
      setClientAuth(client, 'oauth', {});
      process.exit(0);
    }
    if (mode !== 'api_key') usage();
    const apiKey = getOptional(values, 'api-key', '') || process.env._INSTALLER_API_KEY || '';
    if (!apiKey) {
      console.error('Error: API key required via --api-key or _INSTALLER_API_KEY env var');
      process.exit(1);
    }
    const displayName = getOptional(values, 'display-name', `Installer ${client} API Key`);
    const modelArg = getOptional(values, 'model', '');
    setClientAuth(client, 'api_key', {
      displayName,
      apiKey,
      baseUrl: getOptional(values, 'base-url', ''),
      ...(modelArg ? { models: [modelArg] } : {}),
    });
    process.exit(0);
  }

  if (positionals[0] === 'client-auth' && positionals[1] === 'remove') {
    const client = normalizeClient(getRequired(values, 'client'));
    if (!client) {
      console.error('Error: unsupported client');
      process.exit(1);
    }
    const projectDir = getRequired(values, 'project-dir');
    _activeProjectDir = projectDir;
    assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.client-auth.remove');
    // Migrate legacy files before removal so accounts/credentials are in global store
    migrateAllLegacySources(projectDir);
    const force = values.get('force')?.[0] === 'true';
    removeClientAuth(client, `installer-${client}`, projectDir, { force });
    process.exit(0);
  }

  if (positionals[0] === 'claude-profile' && positionals[1] === 'set') {
    const projectDir = getOptional(values, 'project-dir', '');
    _activeProjectDir = projectDir;
    assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.claude-profile.set');
    // Migrate legacy files before applying new setting
    migrateAllLegacySources(projectDir);
    const apiKey = getOptional(values, 'api-key', '') || process.env._INSTALLER_API_KEY || '';
    if (!apiKey) {
      console.error('Error: API key required via --api-key or _INSTALLER_API_KEY env var');
      process.exit(1);
    }
    const modelArg = getOptional(values, 'model', '').trim();
    setClientAuth('anthropic', 'api_key', {
      profileId: 'installer-managed',
      displayName: 'Installer API Key',
      apiKey,
      baseUrl: getOptional(values, 'base-url', 'https://api.anthropic.com'),
      ...(modelArg ? { models: [modelArg] } : {}),
    });
    process.exit(0);
  }

  if (positionals[0] === 'claude-profile' && positionals[1] === 'remove') {
    const projectDir = getRequired(values, 'project-dir');
    _activeProjectDir = projectDir;
    assertSafeTestConfigRoot(resolveGlobalRoot(), 'install-auth-config.claude-profile.remove');
    migrateAllLegacySources(projectDir);
    const forceRemove = values.get('force')?.[0] === 'true';
    removeClientAuth('anthropic', 'installer-managed', projectDir, { force: forceRemove });
    process.exit(0);
  }

  usage();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
