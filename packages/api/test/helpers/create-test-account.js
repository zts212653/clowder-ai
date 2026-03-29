/**
 * F136 Phase 4d — Test helper replacing old createProviderProfile / activateProviderProfile.
 *
 * Drop-in shim: writes accounts to cat-catalog.json + credentials.json
 * (the new canonical stores) and returns a profile-like object so existing
 * test assertions on `profile.id` continue to work.
 *
 * Key difference from the old provider-profiles.js helper: accounts now live
 * inside cat-catalog.json (same file as breeds). When no catalog exists yet,
 * this helper bootstraps one from the project template so that the runtime
 * catalog is valid (has breeds ≥ 1, roster, reviewPolicy).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function deriveAccountId(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `account-${Date.now()}`
  );
}

const PROTOCOL_MAP = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  dare: 'openai',
  opencode: 'anthropic',
};

/**
 * Ensure a valid cat-catalog.json exists. If none exists, bootstrap from the
 * project template so that breeds/roster/reviewPolicy are properly populated.
 * This mirrors what the runtime does and avoids creating a minimal catalog
 * that would prevent bootstrapCatCatalog from running later.
 */
async function ensureCatalog(projectRoot) {
  const catCafeDir = resolve(projectRoot, '.cat-cafe');
  const catalogPath = resolve(catCafeDir, 'cat-catalog.json');
  mkdirSync(catCafeDir, { recursive: true });
  if (!existsSync(catalogPath)) {
    const templatePath = process.env.CAT_TEMPLATE_PATH || resolve(projectRoot, 'cat-template.json');
    if (existsSync(templatePath)) {
      try {
        const { bootstrapCatCatalog } = await import('../../dist/config/cat-catalog-store.js');
        bootstrapCatCatalog(projectRoot, templatePath);
      } catch {
        /* template may be invalid (e.g. '{}' in isolation tests) — fall through to minimal catalog */
      }
    }
    // If still missing after bootstrap attempt (no template), create minimal valid catalog
    if (!existsSync(catalogPath)) {
      writeFileSync(
        catalogPath,
        JSON.stringify(
          {
            version: 2,
            breeds: [
              {
                id: 'stub',
                catId: 'stub',
                name: 'stub',
                displayName: 'stub',
                avatar: '/stub.png',
                color: { primary: '#000', secondary: '#fff' },
                mentionPatterns: ['@stub'],
                roleDescription: 'stub',
                defaultVariantId: 'stub-v',
                variants: [
                  {
                    id: 'stub-v',
                    provider: 'anthropic',
                    defaultModel: 'stub',
                    mcpSupport: false,
                    cli: { command: 'echo', outputFormat: 'stream-json' },
                  },
                ],
              },
            ],
            accounts: {},
            roster: { stub: { family: 'stub', roles: ['test'], lead: false, available: false, evaluation: 'none' } },
            reviewPolicy: {},
          },
          null,
          2,
        ),
        'utf-8',
      );
    }
  }
  return catalogPath;
}

function readCatalog(catalogPath) {
  return JSON.parse(readFileSync(catalogPath, 'utf-8'));
}

function writeCatalog(catalogPath, catalog) {
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8');
}

function ensureCredentials(globalRoot) {
  const root = globalRoot || projectRootFallback;
  const catCafeDir = resolve(root, '.cat-cafe');
  const credPath = resolve(catCafeDir, 'credentials.json');
  mkdirSync(catCafeDir, { recursive: true });
  if (!existsSync(credPath)) {
    writeFileSync(credPath, '{}', 'utf-8');
  }
  return credPath;
}

let projectRootFallback = '';

/**
 * Drop-in replacement for the old createProviderProfile.
 *
 * @param {string} projectRoot - project root path
 * @param {object} opts
 * @param {string} [opts.provider] - 'anthropic' | 'openai' | 'google' | 'dare' | 'opencode'
 * @param {string} opts.name - display name (used to derive ID)
 * @param {string} [opts.mode] - 'api_key' | 'builtin'
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.apiKey]
 * @param {string[]} [opts.models]
 * @param {boolean} [opts.setActive] - ignored (compat)
 * @returns {{ id: string, kind: string, authType: string, protocol: string, builtin: boolean, displayName: string }}
 */
export async function createProviderProfile(projectRoot, opts) {
  projectRootFallback = projectRoot;
  const id = deriveAccountId(opts.name || opts.displayName || opts.provider || 'custom');
  const protocol = opts.protocol || PROTOCOL_MAP[opts.provider] || 'openai';
  const authType = opts.authType || (opts.mode === 'api_key' ? 'api_key' : 'oauth');
  const isBuiltin = authType === 'oauth';

  // Write account to catalog (bootstrap first if needed)
  const catalogPath = await ensureCatalog(projectRoot);
  const catalog = readCatalog(catalogPath);
  if (!catalog.accounts) catalog.accounts = {};
  catalog.accounts[id] = {
    authType,
    protocol,
    ...(opts.displayName || opts.name ? { displayName: opts.displayName || opts.name } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(opts.models?.length ? { models: opts.models } : {}),
  };
  writeCatalog(catalogPath, catalog);

  // Write credential if API key provided
  if (opts.apiKey) {
    const globalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT || projectRoot;
    const credPath = ensureCredentials(globalRoot);
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    creds[id] = { apiKey: opts.apiKey };
    writeFileSync(credPath, `${JSON.stringify(creds, null, 2)}\n`, 'utf-8');
  }

  return {
    id,
    kind: isBuiltin ? 'builtin' : 'api_key',
    authType,
    protocol,
    builtin: isBuiltin,
    displayName: opts.name,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.models?.length ? { models: [...opts.models] } : {}),
    client: isBuiltin ? opts.provider : undefined,
  };
}

/**
 * No-op replacement for the old activateProviderProfile.
 * The new accounts system doesn't have an "active" concept per-provider.
 */
export async function activateProviderProfile(_projectRoot, _provider, _profileId) {
  // No-op — activation is handled by variant accountRef binding.
}

/**
 * No-op replacement for the old deleteProviderProfile.
 */
export async function deleteProviderProfile(projectRoot, profileId, _activeProfileId) {
  const catalogPath = resolve(projectRoot, '.cat-cafe', 'cat-catalog.json');
  if (!existsSync(catalogPath)) return;
  const catalog = readCatalog(catalogPath);
  if (catalog.accounts?.[profileId]) {
    delete catalog.accounts[profileId];
    writeCatalog(catalogPath, catalog);
  }
}

/**
 * No-op replacement for the old updateProviderProfile.
 */
export async function updateProviderProfile(projectRoot, profileId, _activeProfileId, updates) {
  const catalogPath = resolve(projectRoot, '.cat-cafe', 'cat-catalog.json');
  if (!existsSync(catalogPath)) return { error: 'not_found' };
  const catalog = readCatalog(catalogPath);
  const account = catalog.accounts?.[profileId];
  if (!account) return { error: 'not_found' };
  if (updates.name) account.displayName = updates.name;
  if (updates.baseUrl !== undefined) account.baseUrl = updates.baseUrl;
  if (updates.models) account.models = updates.models;
  writeCatalog(catalogPath, catalog);
  return { id: profileId, ...account };
}
