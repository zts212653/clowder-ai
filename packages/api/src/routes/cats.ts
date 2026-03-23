/**
 * Cats API Routes
 * GET /api/cats - 获取所有猫猫信息
 * GET /api/cats/:id/status - 获取猫猫状态
 */

import { resolve } from 'node:path';
import { type CatConfig, type CatProvider, type ContextBudget, catRegistry, type RosterEntry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isSeedCat, resolveBoundAccountRefForCat } from '../config/cat-account-binding.js';
import { bootstrapCatCatalog, resolveCatCatalogPath } from '../config/cat-catalog-store.js';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { resolveProjectTemplatePath } from '../config/project-template-path.js';
import {
  resolveBuiltinClientForProvider,
  validateModelFormatForProvider,
  validateRuntimeProviderBinding,
} from '../config/provider-binding-compat.js';
import {
  resolveRuntimeProviderProfileById,
  resolveRuntimeProviderProfileForClient,
} from '../config/provider-profiles.js';
import { createRuntimeCat, deleteRuntimeCat, updateRuntimeCat } from '../config/runtime-cat-catalog.js';
import { deleteRuntimeOverride, getRuntimeOverride, setRuntimeOverride } from '../config/session-strategy-overrides.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';

const colorSchema = z.object({
  primary: z.string().min(1),
  secondary: z.string().min(1),
});

const contextBudgetSchema = z.object({
  maxPromptTokens: z.number().int().positive(),
  maxContextTokens: z.number().int().positive(),
  maxMessages: z.number().int().positive(),
  maxContentLengthPerMsg: z.number().int().positive(),
});

const cliSchema = z.object({
  command: z.string().min(1),
  outputFormat: z.string().min(1),
  defaultArgs: z.array(z.string().min(1)).optional(),
});

const clientSchema = z.enum(['anthropic', 'openai', 'google', 'dare', 'antigravity', 'opencode']);
const catIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'catId must use lowercase letters, numbers, "_" or "-" and start with a letter');

const baseCatSchema = z.object({
  catId: catIdSchema,
  name: z.string().min(1),
  displayName: z.string().min(1),
  nickname: z.string().optional(),
  avatar: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().min(1).optional(),
  ),
  color: colorSchema,
  mentionPatterns: z.array(z.string().min(1)).min(1),
  accountRef: z.string().min(1).optional(),
  providerProfileId: z.string().min(1).optional(),
  contextBudget: contextBudgetSchema.optional(),
  roleDescription: z.string().min(1),
  personality: z.string().optional(),
  teamStrengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  strengths: z.array(z.string().min(1)).optional(),
  sessionChain: z.boolean().optional(),
});

const createNormalCatSchema = baseCatSchema.extend({
  client: clientSchema.exclude(['antigravity']),
  defaultModel: z.string().min(1),
  mcpSupport: z.boolean().optional(),
  cli: cliSchema.optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
});

const createAntigravityCatSchema = baseCatSchema.extend({
  client: z.literal('antigravity'),
  defaultModel: z.string().min(1),
  commandArgs: z.array(z.string().min(1)).min(1).optional(),
});

const createCatSchema = z.discriminatedUnion('client', [createNormalCatSchema, createAntigravityCatSchema]);

const updateCatSchema = z.object({
  name: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  nickname: z.string().optional(),
  avatar: z.string().min(1).optional(),
  color: colorSchema.optional(),
  mentionPatterns: z.array(z.string().min(1)).min(1).optional(),
  accountRef: z.string().min(1).nullable().optional(),
  providerProfileId: z.string().min(1).nullable().optional(),
  contextBudget: contextBudgetSchema.nullable().optional(),
  roleDescription: z.string().min(1).optional(),
  personality: z.string().optional(),
  teamStrengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  strengths: z.array(z.string().min(1)).optional(),
  sessionChain: z.boolean().optional(),
  available: z.boolean().optional(),
  client: clientSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  mcpSupport: z.boolean().optional(),
  cli: cliSchema.optional(),
  commandArgs: z.array(z.string().min(1)).optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
});

function resolveOperator(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((value) => typeof value === 'string' && value.trim().length > 0);
    if (typeof first === 'string') return first.trim();
  }
  return null;
}

function resolveProjectRoot(): string {
  return resolveActiveProjectRoot();
}

type CatSource = 'seed' | 'runtime';

interface CatResponseMetadata {
  roster: RosterEntry | null;
  source: CatSource;
}

function buildCatResponseMetadataResolver(projectRoot: string) {
  const templatePath = resolveProjectTemplatePath(projectRoot);
  let seedCatIds = new Set<string>();
  try {
    seedCatIds = new Set(Object.keys(toAllCatConfigs(loadCatConfig(templatePath))));
  } catch {
    seedCatIds = new Set();
  }

  let roster: Record<string, RosterEntry> = {};
  try {
    bootstrapCatCatalog(projectRoot, templatePath);
    roster = getRoster(loadCatConfig(resolveCatCatalogPath(projectRoot)));
  } catch {
    try {
      roster = getRoster(loadCatConfig(templatePath));
    } catch {
      roster = {};
    }
  }

  return (catId: string): CatResponseMetadata => ({
    roster: roster[catId] ?? null,
    source: seedCatIds.has(catId) ? 'seed' : 'runtime',
  });
}

function defaultCliForClient(client: CatProvider): { command: string; outputFormat: string } {
  switch (client) {
    case 'anthropic':
      return { command: 'claude', outputFormat: 'stream-json' };
    case 'openai':
      return { command: 'codex', outputFormat: 'json' };
    case 'google':
      return { command: 'gemini', outputFormat: 'stream-json' };
    case 'dare':
      return { command: 'dare', outputFormat: 'json' };
    case 'opencode':
      return { command: 'opencode', outputFormat: 'json' };
    case 'antigravity':
      return { command: 'antigravity', outputFormat: 'json' };
    case 'a2a':
      return { command: 'a2a', outputFormat: 'json' };
    default:
      return { command: client, outputFormat: 'json' };
  }
}

function resolveAccountRef(body: {
  accountRef?: string | null;
  providerProfileId?: string | null;
}): string | undefined | null {
  if (body.providerProfileId !== undefined) return body.providerProfileId;
  if (body.accountRef !== undefined) return body.accountRef;
  return undefined;
}

function buildEffectiveAccountRefResolver(projectRoot: string) {
  const inheritedBindingCache = new Map<string, Promise<string | undefined>>();

  return async (cat: CatConfig & { contextBudget?: ContextBudget }): Promise<string | undefined> => {
    const explicitAccountRef = resolveBoundAccountRefForCat(projectRoot, cat.id, cat);
    if (explicitAccountRef !== undefined) return explicitAccountRef;
    if (!isSeedCat(projectRoot, cat.id)) return cat.accountRef;

    const builtinClient = resolveBuiltinClientForProvider(cat.provider);
    if (!builtinClient) return cat.accountRef;

    let runtimeProfilePromise = inheritedBindingCache.get(builtinClient);
    if (!runtimeProfilePromise) {
      runtimeProfilePromise = resolveRuntimeProviderProfileForClient(projectRoot, builtinClient).then(
        (profile) => profile?.id,
      );
      inheritedBindingCache.set(builtinClient, runtimeProfilePromise);
    }
    return (await runtimeProfilePromise) ?? cat.accountRef;
  };
}

async function validateAccountBindingOrThrow(
  projectRoot: string,
  client: CatProvider,
  accountRef?: string | null,
  defaultModel?: string | null,
): Promise<void> {
  const trimmedAccountRef = accountRef?.trim();
  if (client === 'antigravity' && trimmedAccountRef) {
    throw new Error('antigravity client does not support accountRef');
  }
  if (client !== 'antigravity' && !trimmedAccountRef) {
    throw new Error(`client "${client}" requires a provider binding`);
  }
  if (!trimmedAccountRef) return;
  const runtimeProfile = await resolveRuntimeProviderProfileById(projectRoot, trimmedAccountRef);
  if (!runtimeProfile) {
    throw new Error(`provider "${trimmedAccountRef}" not found`);
  }
  const compatibilityError = validateRuntimeProviderBinding(client, runtimeProfile, defaultModel);
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }
  const modelFormatError = validateModelFormatForProvider(client, defaultModel);
  if (modelFormatError) {
    throw new Error(modelFormatError);
  }
}

async function toCatResponse(
  cat: CatConfig & { contextBudget?: ContextBudget },
  metadata: CatResponseMetadata,
  resolveEffectiveAccountRef: (cat: CatConfig & { contextBudget?: ContextBudget }) => Promise<string | undefined>,
) {
  return {
    id: cat.id,
    name: cat.name,
    displayName: cat.displayName,
    nickname: cat.nickname,
    color: cat.color,
    mentionPatterns: cat.mentionPatterns,
    breedId: cat.breedId,
    accountRef: await resolveEffectiveAccountRef(cat),
    provider: cat.provider,
    defaultModel: cat.defaultModel,
    contextBudget: cat.contextBudget,
    avatar: cat.avatar,
    roleDescription: cat.roleDescription,
    personality: cat.personality,
    teamStrengths: cat.teamStrengths,
    caution: cat.caution,
    strengths: cat.strengths,
    sessionChain: cat.sessionChain,
    commandArgs: cat.commandArgs,
    cliConfigArgs: cat.cliConfigArgs,
    variantLabel: cat.variantLabel ?? undefined,
    isDefaultVariant: cat.isDefaultVariant ?? undefined,
    breedDisplayName: cat.breedDisplayName ?? undefined,
    mcpSupport: cat.mcpSupport,
    roster: metadata.roster
      ? {
          family: metadata.roster.family,
          roles: [...metadata.roster.roles],
          lead: metadata.roster.lead,
          available: metadata.roster.available,
          evaluation: metadata.roster.evaluation,
        }
      : null,
    source: metadata.source,
  };
}

async function reconcileCatRegistry(
  projectRoot: string,
  managedIdsBefore: ReadonlySet<string>,
  onCatalogChanged?: (cats: Record<string, CatConfig>) => Promise<void> | void,
) {
  const runtimeCats = toAllCatConfigs(loadCatConfig(resolve(projectRoot, '.cat-cafe', 'cat-catalog.json')));
  const extraCats = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeCats)) {
    catRegistry.register(id, config);
  }
  for (const [id, config] of Object.entries(extraCats)) {
    if (!runtimeCats[id] && !managedIdsBefore.has(id)) catRegistry.register(id, config);
  }
  const allCats = catRegistry.getAllConfigs();
  await onCatalogChanged?.(allCats);
  return allCats;
}

function getManagedCatalogIds(projectRoot: string): Set<string> {
  try {
    return new Set(Object.keys(toAllCatConfigs(loadCatConfig(resolve(projectRoot, '.cat-cafe', 'cat-catalog.json')))));
  } catch {
    return new Set();
  }
}

function getResolvedCats(projectRoot: string) {
  try {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    bootstrapCatCatalog(projectRoot, templatePath);
    const resolved = toAllCatConfigs(loadCatConfig(resolveCatCatalogPath(projectRoot)));
    for (const [id, config] of Object.entries(catRegistry.getAllConfigs())) {
      if (!resolved[id]) resolved[id] = config;
    }
    return resolved;
  } catch {
    return catRegistry.getAllConfigs();
  }
}

interface CatsRoutesOptions {
  onCatalogChanged?: (cats: Record<string, CatConfig>) => Promise<void> | void;
}

export const catsRoutes: FastifyPluginAsync<CatsRoutesOptions> = async (app, opts) => {
  // GET /api/cats - 获取所有猫猫配置
  app.get('/api/cats', async () => {
    const projectRoot = resolveProjectRoot();
    const resolveMetadata = buildCatResponseMetadataResolver(projectRoot);
    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver(projectRoot);
    return {
      cats: await Promise.all(
        Object.values(getResolvedCats(projectRoot)).map((cat) =>
          toCatResponse(cat, resolveMetadata(cat.id), resolveEffectiveAccountRef),
        ),
      ),
    };
  });

  app.post('/api/cats', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = createCatSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const projectRoot = resolveProjectRoot();
    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    const body = parsed.data;

    // Validate alias uniqueness across all existing members
    if (body.mentionPatterns?.length) {
      const allConfigs = catRegistry.getAllConfigs();
      for (const pattern of body.mentionPatterns) {
        const normalized = pattern.toLowerCase();
        for (const [existingId, existingConfig] of Object.entries(allConfigs)) {
          if (existingConfig.mentionPatterns.some((p: string) => p.toLowerCase() === normalized)) {
            reply.status(400);
            return { error: `别名 "${pattern}" 已被成员 "${existingId}" 使用` };
          }
        }
      }
    }

    const accountRef = resolveAccountRef(body);
    try {
      await validateAccountBindingOrThrow(projectRoot, body.client, accountRef, body.defaultModel);
      const resolvedAvatar = body.avatar ?? '/avatars/default.png';
      if (body.client === 'antigravity') {
        createRuntimeCat(projectRoot, {
          catId: body.catId,
          name: body.name,
          displayName: body.displayName,
          nickname: body.nickname,
          avatar: resolvedAvatar,
          color: body.color,
          mentionPatterns: body.mentionPatterns,
          ...(accountRef !== undefined ? { accountRef: accountRef ?? undefined } : {}),
          contextBudget: body.contextBudget,
          roleDescription: body.roleDescription,
          personality: body.personality,
          teamStrengths: body.teamStrengths,
          caution: body.caution,
          strengths: body.strengths,
          sessionChain: body.sessionChain,
          provider: 'antigravity',
          defaultModel: body.defaultModel,
          mcpSupport: false,
          cli: {
            ...defaultCliForClient('antigravity'),
            ...(body.commandArgs ? { defaultArgs: body.commandArgs } : {}),
          },
          commandArgs: body.commandArgs,
        });
      } else {
        createRuntimeCat(projectRoot, {
          catId: body.catId,
          name: body.name,
          displayName: body.displayName,
          nickname: body.nickname,
          avatar: resolvedAvatar,
          color: body.color,
          mentionPatterns: body.mentionPatterns,
          ...(accountRef !== undefined ? { accountRef: accountRef ?? undefined } : {}),
          contextBudget: body.contextBudget,
          roleDescription: body.roleDescription,
          personality: body.personality,
          teamStrengths: body.teamStrengths,
          caution: body.caution,
          strengths: body.strengths,
          sessionChain: body.sessionChain,
          provider: body.client,
          defaultModel: body.defaultModel,
          mcpSupport:
            body.mcpSupport ??
            (body.client === 'anthropic' ||
              body.client === 'openai' ||
              body.client === 'google' ||
              body.client === 'opencode'),
          cli: body.cli ?? defaultCliForClient(body.client),
          ...(body.cliConfigArgs ? { cliConfigArgs: body.cliConfigArgs } : {}),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }

    const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
    const cat = resolved[body.catId];
    const metadata = buildCatResponseMetadataResolver(projectRoot);
    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver(projectRoot);
    reply.status(201);
    return { cat: await toCatResponse(cat, metadata(cat.id), resolveEffectiveAccountRef), updatedBy: operator };
  });

  app.patch<{ Params: { id: string } }>('/api/cats/:id', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = updateCatSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const body = parsed.data;
    const projectRoot = resolveProjectRoot();

    // Validate alias uniqueness when mentionPatterns are being updated
    if (body.mentionPatterns?.length) {
      const allConfigs = catRegistry.getAllConfigs();
      for (const pattern of body.mentionPatterns) {
        const normalized = pattern.toLowerCase();
        for (const [existingId, existingConfig] of Object.entries(allConfigs)) {
          if (existingId === request.params.id) continue; // skip self
          if (existingConfig.mentionPatterns.some((p: string) => p.toLowerCase() === normalized)) {
            reply.status(400);
            return { error: `别名 "${pattern}" 已被成员 "${existingId}" 使用` };
          }
        }
      }
    }

    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver(projectRoot);
    const currentCat = getResolvedCats(projectRoot)[request.params.id] ?? catRegistry.tryGet(request.params.id)?.config;
    if (!currentCat) {
      reply.status(404);
      return { error: `Cat "${request.params.id}" not found` };
    }
    const effectiveClient = body.client ?? currentCat.provider;
    const nextAccountRef = resolveAccountRef(body);
    const currentEffectiveAccountRef = await resolveEffectiveAccountRef(currentCat);
    const effectiveAccountRef =
      nextAccountRef !== undefined ? (nextAccountRef ?? undefined) : currentEffectiveAccountRef;
    const effectiveDefaultModel = body.defaultModel !== undefined ? body.defaultModel : currentCat.defaultModel;
    const providerConfigTouched =
      body.client !== undefined || body.defaultModel !== undefined || nextAccountRef !== undefined;

    if (providerConfigTouched) {
      try {
        await validateAccountBindingOrThrow(projectRoot, effectiveClient, effectiveAccountRef, effectiveDefaultModel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.status(400);
        return { error: message };
      }
    }

    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    try {
      const hasCommandArgsPatch = body.commandArgs !== undefined;
      const nextCommandArgs = body.commandArgs ?? [];
      const antigravityCliPatch =
        body.client === 'antigravity' || (currentCat.provider === 'antigravity' && hasCommandArgsPatch)
          ? {
              cli: {
                ...defaultCliForClient('antigravity'),
                ...(hasCommandArgsPatch && nextCommandArgs.length > 0 ? { defaultArgs: nextCommandArgs } : {}),
              },
            }
          : {};
      updateRuntimeCat(projectRoot, request.params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.mentionPatterns !== undefined ? { mentionPatterns: body.mentionPatterns } : {}),
        ...(nextAccountRef !== undefined ? { accountRef: nextAccountRef } : {}),
        ...(body.contextBudget !== undefined ? { contextBudget: body.contextBudget } : {}),
        ...(body.roleDescription !== undefined ? { roleDescription: body.roleDescription } : {}),
        ...(body.personality !== undefined ? { personality: body.personality } : {}),
        ...(body.teamStrengths !== undefined ? { teamStrengths: body.teamStrengths } : {}),
        ...(body.caution !== undefined ? { caution: body.caution } : {}),
        ...(body.strengths !== undefined ? { strengths: body.strengths } : {}),
        ...(body.sessionChain !== undefined ? { sessionChain: body.sessionChain } : {}),
        ...(body.client !== undefined ? { provider: body.client } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.mcpSupport !== undefined ? { mcpSupport: body.mcpSupport } : {}),
        ...(hasCommandArgsPatch
          ? {
              ...antigravityCliPatch,
              commandArgs: body.commandArgs,
            }
          : {}),
        ...(!hasCommandArgsPatch ? antigravityCliPatch : {}),
        ...(body.cli !== undefined ? { cli: body.cli } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
        ...(body.cliConfigArgs !== undefined ? { cliConfigArgs: body.cliConfigArgs } : {}),
      });
      const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
      const cat = resolved[request.params.id];
      const metadata = buildCatResponseMetadataResolver(projectRoot);
      return { cat: await toCatResponse(cat, metadata(cat.id), resolveEffectiveAccountRef), updatedBy: operator };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        reply.status(404);
      } else {
        reply.status(400);
      }
      return { error: message };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/cats/:id', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const projectRoot = resolveProjectRoot();
    const currentCat = getResolvedCats(projectRoot)[request.params.id] ?? catRegistry.tryGet(request.params.id)?.config;
    if (!currentCat) {
      reply.status(404);
      return { error: `Cat "${request.params.id}" not found` };
    }
    const metadata = buildCatResponseMetadataResolver(projectRoot);
    if (metadata(request.params.id).source === 'seed') {
      reply.status(409);
      return { error: 'cannot delete seed cat' };
    }
    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    const overrideBackup = getRuntimeOverride(request.params.id);
    try {
      await deleteRuntimeOverride(request.params.id);
      try {
        deleteRuntimeCat(projectRoot, request.params.id);
      } catch (err) {
        if (overrideBackup) {
          await setRuntimeOverride(request.params.id, overrideBackup);
        }
        throw err;
      }
      await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
      return { deleted: true, id: request.params.id, updatedBy: operator };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) {
        reply.status(404);
      } else if (/cannot delete seed cat/i.test(message)) {
        reply.status(409);
      } else {
        reply.status(400);
      }
      return { error: message };
    }
  });

  // GET /api/cats/:id/status - 获取猫猫状态
  app.get<{ Params: { id: string } }>('/api/cats/:id/status', async (request, reply) => {
    const { id } = request.params;
    const projectRoot = resolveProjectRoot();
    const cat = getResolvedCats(projectRoot)[id] ?? catRegistry.tryGet(id)?.config;

    if (!cat) {
      reply.status(404);
      return { error: 'Cat not found' };
    }

    // Cat status is currently tracked via WebSocket events (ThinkingIndicator/ParallelStatusBar).
    // This endpoint returns placeholder data; Redis-backed polling status is a future enhancement.
    // See: InvocationTracker for per-thread tracking, not per-cat.
    return {
      id: cat.id,
      displayName: cat.displayName,
      status: 'idle',
      lastActive: Date.now(),
    };
  });
};
