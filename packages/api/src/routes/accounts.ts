/**
 * Accounts API Routes — F136 Phase 4d → F340 renamed
 *
 * Reads/writes via global ~/.cat-cafe/accounts.json + credentials.json.
 */
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, win32 } from 'node:path';
import type { AccountConfig } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveCatCatalogPath } from '../config/cat-catalog-store.js';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { deleteCatalogAccount, readCatalogAccounts, writeCatalogAccount } from '../config/catalog-accounts.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { deleteCredential, hasCredential, writeCredential } from '../config/credentials.js';
import { resolveProjectTemplatePath } from '../config/project-template-path.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

// F340: Derive client identity from well-known account IDs, not stored protocol.
const BUILTIN_CLIENT_FOR_ID: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  kimi: 'kimi',
  dare: 'dare',
  opencode: 'opencode',
  builtin_anthropic: 'anthropic',
  builtin_openai: 'openai',
  builtin_google: 'google',
  builtin_kimi: 'kimi',
  builtin_dare: 'dare',
  builtin_opencode: 'opencode',
};

/** Synthesize a ProviderProfileView-compatible object from AccountConfig (backward compat for Hub UI). */
function accountToView(id: string, account: AccountConfig, apiKeyPresent: boolean) {
  const isBuiltin = account.authType === 'oauth';
  const builtinClient = BUILTIN_CLIENT_FOR_ID[id] ?? id;
  return {
    id,
    name: account.displayName ?? id,
    displayName: account.displayName ?? id,
    kind: isBuiltin ? 'builtin' : ('api_key' as const),
    authType: account.authType,
    builtin: isBuiltin,
    ...(isBuiltin ? { clientId: builtinClient } : {}),
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    models: account.models ? [...account.models] : [],
    hasApiKey: apiKeyPresent,
    mode: isBuiltin ? ('subscription' as const) : ('api_key' as const),
    createdAt: '',
    updatedAt: '',
  };
}

/** Derive a slug-like ID from display name, avoiding collisions with existing accounts. */
function deriveAccountId(displayName: string, existingIds: Set<string>): string {
  const seed =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `account-${Date.now()}`;
  if (!existingIds.has(seed)) return seed;
  let counter = 2;
  while (existingIds.has(`${seed}-${counter}`)) counter += 1;
  return `${seed}-${counter}`;
}

function resolveGlobalConfigRoot(projectRoot?: string): string {
  const envRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  if (envRoot) return resolve(envRoot);
  if (projectRoot) return resolve(projectRoot);
  return resolve(homedir());
}

function isProjectScopedGlobalStore(projectRoot: string): boolean {
  return resolve(projectRoot) === resolveGlobalConfigRoot(projectRoot);
}

/** Scan both runtime catalog and template for variant→account bindings. Returns Error on parse failure. */
function findBoundCatIds(projectRoot: string, accountRef: string): string[] | Error {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  const templatePath = resolveProjectTemplatePath(projectRoot);
  const sources: Array<{ path: string; exists: boolean }> = [
    { path: catalogPath, exists: existsSync(catalogPath) },
    { path: templatePath, exists: existsSync(templatePath) },
  ];
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

const MONOREPO_ROOT = findMonorepoRoot();

const authTypeEnum = z.enum(['oauth', 'api_key']);
const modeEnum = z.enum(['subscription', 'api_key']);

const projectQuerySchema = z.object({
  projectPath: z.string().optional(),
});

const createBodySchema = z
  .object({
    projectPath: z.string().optional(),
    provider: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    mode: modeEnum.optional(),
    authType: authTypeEnum.optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    modelOverride: z.string().optional(),
    models: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .transform((v) => v.replace(/\/+$/, ''))
          .pipe(z.string().min(1)),
      )
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.name && !value.displayName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['displayName'],
        message: 'displayName or name is required',
      });
    }
  });

const updateBodySchema = z.object({
  projectPath: z.string().optional(),
  provider: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  mode: modeEnum.optional(),
  authType: authTypeEnum.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelOverride: z.string().nullable().optional(),
  models: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .transform((v) => v.replace(/\/+$/, ''))
        .pipe(z.string().min(1)),
    )
    .optional(),
});

const deleteBodySchema = z.object({
  projectPath: z.string().optional(),
  force: z.boolean().optional(),
});

async function resolveProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return resolveActiveProjectRoot();
  const validated = await validateProjectPath(projectPath);
  if (validated) return validated;

  // Workspace project switcher can provide sibling repo paths (outside homedir/tmp allowlist).
  // Allow paths under current workspace root while keeping realpath boundary checks.
  const workspaceRoot = resolve(MONOREPO_ROOT, '..');
  try {
    const [resolvedTarget, resolvedWorkspaceRoot] = await Promise.all([
      realpath(resolve(projectPath)),
      realpath(workspaceRoot),
    ]);
    const rel = relative(resolvedWorkspaceRoot, resolvedTarget);
    if (win32.isAbsolute(rel) || rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) return null;
    const info = await stat(resolvedTarget);
    return info.isDirectory() ? resolvedTarget : null;
  } catch {
    return null;
  }
}

export const accountsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/accounts', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = projectQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const accounts = readCatalogAccounts(projectRoot);
    const providers = Object.entries(accounts).map(([id, account]) =>
      accountToView(id, account, hasCredential(id, projectRoot)),
    );
    return {
      projectPath: projectRoot,
      providers,
    };
  });

  app.post('/api/accounts', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const body = parsed.data;
    try {
      // F340: protocol not persisted on new accounts. Custom accounts use explicit
      // accountRef binding; system callers use well-known builtin IDs.
      const account: AccountConfig = {
        authType: (body.authType as 'oauth' | 'api_key') ?? 'api_key',
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        ...(body.models ? { models: body.models } : {}),
        ...((body.displayName ?? body.name) ? { displayName: body.displayName ?? body.name } : {}),
      };
      const existingAccounts = readCatalogAccounts(projectRoot);
      const profileId = deriveAccountId(
        body.displayName ?? body.name ?? body.provider ?? 'custom',
        new Set(Object.keys(existingAccounts)),
      );
      writeCatalogAccount(projectRoot, profileId, account);
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
        profile: accountToView(profileId, account, !!body.apiKey),
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
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = updateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      const existing = readCatalogAccounts(projectRoot)[params.profileId];
      if (!existing) {
        reply.status(404);
        return { error: `Account "${params.profileId}" not found` };
      }
      // F340: protocol not persisted — derived at runtime from well-known account IDs.
      const account: AccountConfig = {
        authType: (parsed.data.authType as 'oauth' | 'api_key') ?? existing.authType,
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
        displayName: parsed.data.displayName ?? parsed.data.name ?? existing.displayName ?? params.profileId,
      };
      writeCatalogAccount(projectRoot, params.profileId, account);
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
        profile: accountToView(params.profileId, account, hasCredential(params.profileId, projectRoot)),
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
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = deleteBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }
    const projectRoot = await resolveProjectRoot(parsed.data.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const params = request.params as { profileId: string };

    try {
      const accounts = readCatalogAccounts(projectRoot);
      const accountExists = Object.hasOwn(accounts, params.profileId);

      // F340: Check current project's catalog AND template for dangling references.
      // Template-only projects (pre-bootstrap) may still bind accountRefs in variants.
      if (!parsed.data.force && accountExists) {
        const boundCatIds = findBoundCatIds(projectRoot, params.profileId);
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
        if (!isProjectScopedGlobalStore(projectRoot)) {
          reply.status(409);
          return {
            error:
              `Account "${params.profileId}" lives in shared global store ${resolveGlobalConfigRoot(projectRoot)} ` +
              `and non-force deletion cannot verify bindings in other projects. Audit all project catalogs or pass { "force": true }.`,
          };
        }
      }

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
