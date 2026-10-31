/**
 * Accounts API Routes — F136 Phase 4d → clowder-ai#340 renamed
 *
 * Reads/writes via global ~/.cat-cafe/accounts.json + credentials.json.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { inspectAccountCatalog, readAccountStoreSnapshot } from '../config/account-store-snapshot.js';
import { resolveCatCatalogPath } from '../config/cat-catalog-store.js';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { deleteCatalogAccount, writeCatalogAccount } from '../config/catalog-accounts.js';
import type { CodexLoginDriver } from '../config/codex-login-driver.js';

import { CodexLoginManager } from '../config/codex-login-manager.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../config/codex-managed-layout.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { deleteCredential, hasCredential, writeCredential } from '../config/credentials.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerCodexBindingRoutes } from './accounts-codex-binding.js';
import { registerCodexLoginRoutes } from './accounts-codex-login.js';
import { registerCodexQuotaRoutes } from './accounts-codex-quota.js';
import { inspectNativeAccountDefaults } from './accounts-native-view.js';
import { resolveAccountProjectRoot } from './accounts-project-root.js';
import { createBodySchema, deleteBodySchema, projectQuerySchema, updateBodySchema } from './accounts-schemas.js';
import { accountToView, deriveAccountId } from './accounts-view.js';

function resolveGlobalConfigRoot(projectRoot?: string): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  if (projectRoot) return resolve(projectRoot);
  return resolve(homedir());
}

function isProjectScopedGlobalStore(projectRoot: string): boolean {
  return resolve(projectRoot) === resolveGlobalConfigRoot(projectRoot);
}

/** Scan the runtime catalog for variant→account bindings. Returns Error on parse failure. */
function findBoundCatIds(projectRoot: string, accountRef: string): string[] | Error {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  const sources: Array<{ path: string; exists: boolean }> = [{ path: catalogPath, exists: existsSync(catalogPath) }];
  const bound = new Set<string>();
  for (const src of sources) {
    if (!src.exists) continue;
    try {
      const allCats = toAllCatConfigs(loadCatConfig(src.path));
      for (const [id, cat] of Object.entries(allCats)) {
        if (cat.accountRef === accountRef) bound.add(id);
      }
    } catch {
      return new Error(`config at ${src.path} failed to parse`);
    }
  }
  return [...bound];
}

export const accountsRoutes: FastifyPluginAsync<{
  loginDriver?: CodexLoginDriver;
  quotaFetcher?: typeof fetch;
}> = async (app, options) => {
  const loginManager = new CodexLoginManager(options.loginDriver);
  registerCodexLoginRoutes(app, loginManager);
  registerCodexBindingRoutes(app);
  registerCodexQuotaRoutes(app, options.quotaFetcher);
  app.addHook('onClose', async () => {
    await loginManager.close();
  });
  app.get('/api/accounts', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const parsed = projectQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }
    const projectRoot = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    try {
      const snapshot = inspectAccountCatalog(projectRoot);
      const providers = Object.entries(snapshot.entries).map(([id, entry]) =>
        accountToView(
          id,
          entry.account.codex ? loginManager.read(projectRoot, id) : entry.account,
          entry.credential !== undefined,
          projectRoot,
        ),
      );
      const nativeDefaults = inspectNativeAccountDefaults(projectRoot);
      for (const [id, account] of nativeDefaults.defaults) {
        if (!snapshot.entries[id] && !snapshot.unavailableAccounts.some((row) => row.accountRef === id))
          providers.push(accountToView(id, account, false, projectRoot));
      }
      return {
        projectPath: projectRoot,
        providers,
        unavailableAccounts: snapshot.unavailableAccounts,
        ...(nativeDefaults.error ? { nativeDefaultsError: nativeDefaults.error } : {}),
      };
    } catch (error) {
      reply.status(400);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/accounts', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const body = parsed.data;
    try {
      // clowder-ai#340: protocol not persisted on new accounts. Custom accounts use explicit
      // accountRef binding; system callers use well-known builtin IDs.
      let account: AccountConfig = {
        authType: (body.authType as 'oauth' | 'api_key') ?? 'api_key',
        ...(body.clientId ? { clientId: body.clientId } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.models ? { models: body.models } : {}),
        ...(body.modelAliases && Object.keys(body.modelAliases).length > 0 ? { modelAliases: body.modelAliases } : {}),
        ...((body.displayName ?? body.name) ? { displayName: body.displayName ?? body.name } : {}),
        ...(body.envVars && Object.keys(body.envVars).length > 0 ? { envVars: body.envVars } : {}),
      };
      const managedClaude = body.claudeToken !== undefined;
      if (managedClaude) account = { ...account, claude: { kind: 'long_lived_token' } };
      const managed = account.authType === 'oauth' && account.clientId === 'openai';
      const profileId = managedClaude
        ? `claude-${randomUUID()}`
        : managed
          ? `codex-${randomUUID()}`
          : deriveAccountId(
              body.displayName ?? body.name ?? body.provider ?? 'custom',
              new Set(readAccountStoreSnapshot(projectRoot).refs),
              account.authType === 'api_key',
            );
      if (managed)
        account = {
          ...account,
          displayName: account.displayName || 'Codex 账号',
          codex: describeCodexManagedLayout(projectRoot, profileId),
        };
      writeCatalogAccount(projectRoot, profileId, account);
      if (account.codex) {
        account = { ...account, codex: prepareCodexManagedLayout(account.codex, projectRoot) };
        writeCatalogAccount(projectRoot, profileId, account);
      }
      if (body.claudeToken) writeCredential(profileId, { accessToken: body.claudeToken }, projectRoot);
      if (body.apiKey) writeCredential(profileId, { apiKey: body.apiKey }, projectRoot);
      configEventBus.emitChange({
        source: 'accounts',
        scope: 'key',
        changedKeys: [profileId],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
      return {
        projectPath: projectRoot,
        profile: accountToView(profileId, account, !!body.apiKey, projectRoot),
      };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.patch('/api/accounts/:profileId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      const existing = readAccountStoreSnapshot(projectRoot).resolve(params.profileId).account;
      if (!existing) {
        reply.status(404);
        return { error: `Account "${params.profileId}" not found` };
      }
      if (
        existing.codex &&
        ((parsed.data.authType && parsed.data.authType !== 'oauth') ||
          (parsed.data.clientId && parsed.data.clientId !== 'openai') ||
          'baseUrl' in parsed.data ||
          'apiKey' in parsed.data ||
          'envVars' in parsed.data)
      )
        throw new Error('codex_managed_account_fields_owned');
      if (
        existing.claude &&
        ((parsed.data.authType && parsed.data.authType !== 'oauth') ||
          (parsed.data.clientId && parsed.data.clientId !== 'anthropic') ||
          'apiKey' in parsed.data ||
          'baseUrl' in parsed.data ||
          'envVars' in parsed.data)
      )
        throw new Error('claude_token_account_fields_owned');
      if (parsed.data.claudeToken && !existing.claude) throw new Error('claude_token_account_required');
      // clowder-ai#340: protocol not persisted — derived at runtime from well-known account IDs.
      const account: AccountConfig = {
        ...(existing.claude ? { claude: existing.claude } : {}),
        ...(existing.codex ? { codex: existing.codex } : {}),
        ...(existing.quota ? { quota: existing.quota } : {}),
        authType: (parsed.data.authType as 'oauth' | 'api_key') ?? existing.authType,
        ...(parsed.data.clientId
          ? { clientId: parsed.data.clientId }
          : existing.clientId
            ? { clientId: existing.clientId }
            : {}),
        ...(parsed.data.baseUrl != null
          ? { baseUrl: parsed.data.baseUrl || undefined }
          : existing.baseUrl
            ? { baseUrl: existing.baseUrl }
            : {}),
        ...(parsed.data.models != null
          ? { models: parsed.data.models }
          : existing.models
            ? { models: [...existing.models] }
            : {}),
        ...('modelAliases' in parsed.data
          ? parsed.data.modelAliases && Object.keys(parsed.data.modelAliases).length > 0
            ? { modelAliases: parsed.data.modelAliases }
            : {}
          : existing.modelAliases && Object.keys(existing.modelAliases).length > 0
            ? { modelAliases: { ...existing.modelAliases } }
            : {}),
        ...('envVars' in parsed.data
          ? parsed.data.envVars && Object.keys(parsed.data.envVars).length > 0
            ? { envVars: parsed.data.envVars }
            : {}
          : existing.envVars && Object.keys(existing.envVars).length > 0
            ? { envVars: { ...existing.envVars } }
            : {}),
        displayName:
          'displayName' in parsed.data || 'name' in parsed.data
            ? parsed.data.displayName || parsed.data.name || (existing.codex ? 'Codex 账号' : params.profileId)
            : (existing.displayName ?? params.profileId),
      };
      writeCatalogAccount(projectRoot, params.profileId, account);
      if (parsed.data.claudeToken)
        writeCredential(params.profileId, { accessToken: parsed.data.claudeToken }, projectRoot);
      if (parsed.data.apiKey != null) {
        if (parsed.data.apiKey) {
          writeCredential(params.profileId, { apiKey: parsed.data.apiKey }, projectRoot);
        } else {
          // Empty string or explicit null → clear credential
          deleteCredential(params.profileId, projectRoot);
        }
      }
      configEventBus.emitChange({
        source: 'accounts',
        scope: 'key',
        changedKeys: [params.profileId],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
      return {
        projectPath: projectRoot,
        profile: accountToView(params.profileId, account, hasCredential(params.profileId, projectRoot), projectRoot),
      };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete('/api/accounts/:profileId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const parsed = deleteBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveAccountProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      const accountExists = readAccountStoreSnapshot(projectRoot).resolve(params.profileId).account !== undefined;

      // Check the runtime catalog for dangling references. Template is bootstrap-only
      // and is not part of runtime binding truth after catalog creation.
      if (!parsed.data.force && accountExists) {
        const boundCatIds = findBoundCatIds(resolveActiveProjectRoot(), params.profileId);
        if (boundCatIds instanceof Error) {
          reply.status(500);
          return {
            error: `Cannot verify account references — ${boundCatIds.message}. Pass { "force": true } to override.`,
          };
        }
        if (boundCatIds.length > 0) {
          reply.status(409);
          return {
            error: `Account "${params.profileId}" is still referenced by: ${boundCatIds.join(', ')}. Remove bindings first or pass { "force": true }.`,
            boundCatIds,
          };
        }
        const catalogPath = resolveCatCatalogPath(resolveActiveProjectRoot());
        if (
          existsSync(catalogPath) &&
          Object.values(loadCatConfig(catalogPath).selectedAccountRefs ?? {}).includes(params.profileId)
        )
          return reply.code(409).send({ error: '这个号是工具正在用的账号，请先换成另一个号再删除登记' });
        if (!isProjectScopedGlobalStore(projectRoot)) {
          reply.status(409);
          return {
            error:
              `Account "${params.profileId}" lives in shared global store ${resolveGlobalConfigRoot(projectRoot)} ` +
              `and non-force deletion cannot verify bindings in other projects. Audit all project catalogs or pass { "force": true }.`,
          };
        }
      }

      const existing = readAccountStoreSnapshot(projectRoot).resolve(params.profileId).account;
      if (
        existing?.codex?.attempt &&
        ['preparing', 'waiting', 'queued', 'review'].includes(existing.codex.attempt.state)
      )
        loginManager.cancel(projectRoot, params.profileId, existing.codex.attempt.id);
      deleteCatalogAccount(projectRoot, params.profileId);
      deleteCredential(params.profileId, projectRoot);
      configEventBus.emitChange({
        source: 'accounts',
        scope: 'key',
        changedKeys: [params.profileId],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
};
