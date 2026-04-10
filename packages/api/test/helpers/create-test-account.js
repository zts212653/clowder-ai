/**
 * F340 — Test helper: writes accounts to global ~/.cat-cafe/accounts.json
 * + credentials.json (the canonical stores) and returns a profile-like
 * object so existing test assertions on `profile.id` continue to work.
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
                    clientId: 'anthropic',
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

  // Ensure catalog exists (for breeds/roster, not for accounts)
  await ensureCatalog(projectRoot);

  // F340: Write account to global ~/.cat-cafe/accounts.json
  const globalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT || projectRoot;
  const globalCatCafeDir = resolve(globalRoot, '.cat-cafe');
  mkdirSync(globalCatCafeDir, { recursive: true });
  const accountsPath = resolve(globalCatCafeDir, 'accounts.json');
  const accounts = existsSync(accountsPath) ? JSON.parse(readFileSync(accountsPath, 'utf-8')) : {};
  // F340: protocol not persisted — derived at runtime from well-known account IDs.
  accounts[id] = {
    authType,
    ...(opts.displayName || opts.name ? { displayName: opts.displayName || opts.name } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl.trim().replace(/\/+$/, '') } : {}),
    ...(opts.models?.length ? { models: opts.models } : {}),
  };
  writeFileSync(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf-8');

  // Write credential if API key provided
  if (opts.apiKey) {
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
    clientId: isBuiltin ? opts.provider : undefined,
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
  const globalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT || projectRoot;
  const accountsPath = resolve(globalRoot, '.cat-cafe', 'accounts.json');
  if (!existsSync(accountsPath)) return;
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf-8'));
  if (accounts[profileId]) {
    delete accounts[profileId];
    writeFileSync(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf-8');
  }
}

/**
 * No-op replacement for the old updateProviderProfile.
 */
export async function updateProviderProfile(projectRoot, profileId, _activeProfileId, updates) {
  const globalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT || projectRoot;
  const accountsPath = resolve(globalRoot, '.cat-cafe', 'accounts.json');
  if (!existsSync(accountsPath)) return { error: 'not_found' };
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf-8'));
  const account = accounts[profileId];
  if (!account) return { error: 'not_found' };
  if (updates.name) account.displayName = updates.name;
  if (updates.baseUrl !== undefined) account.baseUrl = updates.baseUrl;
  if (updates.models) account.models = updates.models;
  writeFileSync(accountsPath, `${JSON.stringify(accounts, null, 2)}\n`, 'utf-8');
  return { id: profileId, ...account };
}
