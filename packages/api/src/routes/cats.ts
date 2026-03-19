/**
 * Cats API Routes
 * GET /api/cats - 获取所有猫猫信息
 * GET /api/cats/:id/status - 获取猫猫状态
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatConfig, type CatProvider, type ContextBudget, catRegistry, type RosterEntry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { readProviderProfiles } from '../config/provider-profiles.js';
import { createRuntimeCat, deleteRuntimeCat, updateRuntimeCat } from '../config/runtime-cat-catalog.js';
import { deleteRuntimeOverride } from '../config/session-strategy-overrides.js';

const DEFAULT_TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../cat-template.json');

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

const baseCatSchema = z.object({
  catId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  nickname: z.string().optional(),
  avatar: z.string().min(1),
  color: colorSchema,
  mentionPatterns: z.array(z.string().min(1)).min(1),
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
  commandArgs: z.array(z.string().min(1)).min(1).optional(),
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
  const templatePath = process.env.CAT_TEMPLATE_PATH ?? DEFAULT_TEMPLATE_PATH;
  return dirname(templatePath);
}

type CatSource = 'seed' | 'runtime';

interface CatResponseMetadata {
  roster: RosterEntry | null;
  source: CatSource;
}

function buildCatResponseMetadataResolver() {
  const templatePath = process.env.CAT_TEMPLATE_PATH ?? DEFAULT_TEMPLATE_PATH;
  let seedCatIds = new Set<string>();
  try {
    seedCatIds = new Set(Object.keys(toAllCatConfigs(loadCatConfig(templatePath))));
  } catch {
    seedCatIds = new Set();
  }

  let roster: Record<string, RosterEntry> = {};
  try {
    roster = getRoster(loadCatConfig());
  } catch {
    roster = {};
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

function protocolForClient(client: CatProvider): 'anthropic' | 'openai' | 'google' | null {
  switch (client) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'google':
      return 'google';
    case 'dare':
      return 'openai';
    case 'opencode':
      return 'anthropic';
    case 'antigravity':
    case 'a2a':
    default:
      return null;
  }
}

async function validateProviderBindingOrThrow(params: {
  projectRoot: string;
  client: CatProvider;
  defaultModel: string;
  providerProfileId?: string;
}) {
  const trimmedProfileId = params.providerProfileId?.trim();
  const protocol = protocolForClient(params.client);
  if (protocol == null) {
    if (trimmedProfileId) {
      throw new Error('antigravity client does not support providerProfileId');
    }
    return;
  }
  if (!trimmedProfileId) {
    if (params.client === 'dare' || params.client === 'opencode') {
      throw new Error(`client "${params.client}" requires a provider profile`);
    }
    return;
  }

  const profiles = await readProviderProfiles(params.projectRoot);
  const profile = profiles.providers.find((item) => item.id === trimmedProfileId);
  if (!profile) {
    throw new Error(`provider profile "${trimmedProfileId}" not found`);
  }
  const protocolCompatible = profile.protocol === protocol;
  const clientAllowsAnyApiKey = params.client === 'anthropic' || params.client === 'openai' || params.client === 'google';
  const bindingAllowed = protocolCompatible || (clientAllowsAnyApiKey && profile.authType === 'api_key');
  if (!bindingAllowed) {
    throw new Error(
      `provider profile "${trimmedProfileId}" protocol "${profile.protocol}" is incompatible with client "${params.client}"`,
    );
  }
  if (profile.models.length > 0 && !profile.models.includes(params.defaultModel)) {
    throw new Error(`model "${params.defaultModel}" is not available in provider profile "${trimmedProfileId}"`);
  }
}

function toCatResponse(cat: CatConfig & { contextBudget?: ContextBudget }, metadata: CatResponseMetadata) {
  return {
    id: cat.id,
    name: cat.name,
    displayName: cat.displayName,
    nickname: cat.nickname,
    color: cat.color,
    mentionPatterns: cat.mentionPatterns,
    breedId: cat.breedId,
    providerProfileId: cat.providerProfileId,
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

function getResolvedCats() {
  try {
    const resolved = toAllCatConfigs(loadCatConfig());
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
    const resolveMetadata = buildCatResponseMetadataResolver();
    return {
      cats: Object.values(getResolvedCats()).map((cat) => toCatResponse(cat, resolveMetadata(cat.id))),
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
    try {
      await validateProviderBindingOrThrow({
        projectRoot,
        client: body.client,
        defaultModel: body.defaultModel,
        providerProfileId: body.providerProfileId,
      });
      if (body.client === 'antigravity') {
        createRuntimeCat(projectRoot, {
          catId: body.catId,
          name: body.name,
          displayName: body.displayName,
          nickname: body.nickname,
          avatar: body.avatar,
          color: body.color,
          mentionPatterns: body.mentionPatterns,
          providerProfileId: body.providerProfileId,
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
          avatar: body.avatar,
          color: body.color,
          mentionPatterns: body.mentionPatterns,
          providerProfileId: body.providerProfileId,
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
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }

    const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
    const cat = resolved[body.catId];
    const metadata = buildCatResponseMetadataResolver();
    reply.status(201);
    return { cat: toCatResponse(cat, metadata(cat.id)), updatedBy: operator };
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
    const currentCat = getResolvedCats()[request.params.id] ?? catRegistry.tryGet(request.params.id)?.config;
    if (!currentCat) {
      reply.status(404);
      return { error: `Cat "${request.params.id}" not found` };
    }
    const effectiveClient = body.client ?? currentCat.provider;
    const effectiveDefaultModel = body.defaultModel ?? currentCat.defaultModel;
    const effectiveProviderProfileId =
      body.providerProfileId !== undefined ? (body.providerProfileId ?? undefined) : currentCat.providerProfileId;

    try {
      await validateProviderBindingOrThrow({
        projectRoot,
        client: effectiveClient,
        defaultModel: effectiveDefaultModel,
        providerProfileId: effectiveProviderProfileId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }

    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    try {
      updateRuntimeCat(projectRoot, request.params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.mentionPatterns !== undefined ? { mentionPatterns: body.mentionPatterns } : {}),
        ...(body.providerProfileId !== undefined ? { providerProfileId: body.providerProfileId } : {}),
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
        ...(body.commandArgs !== undefined
          ? {
              cli: {
                ...defaultCliForClient('antigravity'),
                defaultArgs: body.commandArgs,
              },
              commandArgs: body.commandArgs,
            }
          : {}),
        ...(body.cli !== undefined ? { cli: body.cli } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
      });

      const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
      const cat = resolved[request.params.id];
      const metadata = buildCatResponseMetadataResolver();
      return { cat: toCatResponse(cat, metadata(cat.id)), updatedBy: operator };
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
    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    try {
      deleteRuntimeCat(projectRoot, request.params.id);
      await deleteRuntimeOverride(request.params.id);
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
    const cat = getResolvedCats()[id] ?? catRegistry.tryGet(id)?.config;

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
