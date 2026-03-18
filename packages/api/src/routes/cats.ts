/**
 * Cats API Routes
 * GET /api/cats - 获取所有猫猫信息
 * GET /api/cats/:id/status - 获取猫猫状态
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CatConfig, type ContextBudget, catRegistry, type CatProvider } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { createRuntimeCat, deleteRuntimeCat, updateRuntimeCat } from '../config/runtime-cat-catalog.js';

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
  avatar: z.string().min(1),
  color: colorSchema,
  mentionPatterns: z.array(z.string().min(1)).min(1),
  providerProfileId: z.string().min(1).optional(),
  contextBudget: contextBudgetSchema.optional(),
  roleDescription: z.string().min(1),
  personality: z.string().optional(),
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
  avatar: z.string().min(1).optional(),
  color: colorSchema.optional(),
  mentionPatterns: z.array(z.string().min(1)).min(1).optional(),
  providerProfileId: z.string().min(1).optional(),
  contextBudget: contextBudgetSchema.optional(),
  roleDescription: z.string().min(1).optional(),
  personality: z.string().optional(),
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

function defaultCliForClient(client: CatProvider) {
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
  }
}

function toCatResponse(cat: CatConfig & { contextBudget?: ContextBudget }) {
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
    commandArgs: cat.commandArgs,
    variantLabel: cat.variantLabel ?? undefined,
    isDefaultVariant: cat.isDefaultVariant ?? undefined,
    breedDisplayName: cat.breedDisplayName ?? undefined,
    mcpSupport: cat.mcpSupport,
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
    return {
      cats: Object.values(getResolvedCats()).map(toCatResponse),
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
    if (body.client === 'antigravity') {
      createRuntimeCat(projectRoot, {
        catId: body.catId,
        name: body.name,
        displayName: body.displayName,
        avatar: body.avatar,
        color: body.color,
        mentionPatterns: body.mentionPatterns,
        providerProfileId: body.providerProfileId,
        contextBudget: body.contextBudget,
        roleDescription: body.roleDescription,
        personality: body.personality,
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
        avatar: body.avatar,
        color: body.color,
        mentionPatterns: body.mentionPatterns,
        providerProfileId: body.providerProfileId,
        contextBudget: body.contextBudget,
        roleDescription: body.roleDescription,
        personality: body.personality,
        provider: body.client,
        defaultModel: body.defaultModel,
        mcpSupport: body.mcpSupport ?? body.client === 'anthropic',
        cli: body.cli ?? defaultCliForClient(body.client),
      });
    }

    const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
    const cat = resolved[body.catId];
    reply.status(201);
    return { cat: toCatResponse(cat), updatedBy: operator };
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
    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    updateRuntimeCat(projectRoot, request.params.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
      ...(body.mentionPatterns !== undefined ? { mentionPatterns: body.mentionPatterns } : {}),
      ...(body.providerProfileId !== undefined ? { providerProfileId: body.providerProfileId } : {}),
      ...(body.contextBudget !== undefined ? { contextBudget: body.contextBudget } : {}),
      ...(body.roleDescription !== undefined ? { roleDescription: body.roleDescription } : {}),
      ...(body.personality !== undefined ? { personality: body.personality } : {}),
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
    });

    const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
    const cat = resolved[request.params.id];
    return { cat: toCatResponse(cat), updatedBy: operator };
  });

  app.delete<{ Params: { id: string } }>('/api/cats/:id', async (request, reply) => {
    const operator = resolveOperator(request.headers['x-cat-cafe-user']);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const projectRoot = resolveProjectRoot();
    const managedIdsBefore = getManagedCatalogIds(projectRoot);
    deleteRuntimeCat(projectRoot, request.params.id);
    await reconcileCatRegistry(projectRoot, managedIdsBefore, opts.onCatalogChanged);
    return { deleted: true, id: request.params.id, updatedBy: operator };
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
