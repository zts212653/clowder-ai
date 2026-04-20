/**
 * Cats API Routes
 * GET /api/cats - 获取所有猫猫信息
 * GET /api/cats/:id/status - 获取猫猫状态
 */

import { resolve } from 'node:path';
import {
  type CatConfig,
  CLI_EFFORT_VALUES,
  type CliConfig,
  type ClientId,
  type ContextBudget,
  catRegistry,
  getCliEffortOptionsForProvider,
  getDefaultCliEffortForProvider,
  isValidCliEffortForProvider,
  type RosterEntry,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  builtinAccountIdForClient,
  resolveBuiltinClientForProvider,
  resolveByAccountRef,
  validateModelFormatForProvider,
  validateRuntimeProviderBinding,
} from '../config/account-resolver.js';
import { resolveBoundAccountRefForCat } from '../config/cat-account-binding.js';
import { bootstrapCatCatalog, resolveCatCatalogPath } from '../config/cat-catalog-store.js';
import { getAcpConfig, getRoster, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { resolveProjectTemplatePath } from '../config/project-template-path.js';
import { getResolvedCats } from '../config/resolved-cats.js';
import { createRuntimeCat, deleteRuntimeCat, updateRuntimeCat } from '../config/runtime-cat-catalog.js';
import { deleteRuntimeOverride, getRuntimeOverride, setRuntimeOverride } from '../config/session-strategy-overrides.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

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

const cliEffortSchema = z.enum(CLI_EFFORT_VALUES);
const cliSchema = z.object({
  command: z.string().min(1).optional(),
  outputFormat: z.string().min(1).optional(),
  defaultArgs: z.array(z.string().min(1)).optional(),
  effort: cliEffortSchema.nullable().optional(),
});

const clientSchema = z.enum(['anthropic', 'openai', 'google', 'kimi', 'dare', 'antigravity', 'opencode', 'catagent']);
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
  contextBudget: contextBudgetSchema.optional(),
  roleDescription: z.string().min(1),
  personality: z.string().optional(),
  teamStrengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  strengths: z.array(z.string().min(1)).optional(),
  sessionChain: z.boolean().optional(),
});

/** Strip trailing slashes from model names — prevents "MiniMax-M2.7/" artifacts. */
const modelSchema = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\/+$/, ''))
  .pipe(z.string().min(1));

const createNormalCatSchema = baseCatSchema.extend({
  clientId: clientSchema.exclude(['antigravity']),
  defaultModel: modelSchema,
  mcpSupport: z.boolean().optional(),
  cli: cliSchema.optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).optional(),
});

const createAntigravityCatSchema = baseCatSchema.extend({
  clientId: z.literal('antigravity'),
  defaultModel: modelSchema,
  commandArgs: z.array(z.string().min(1)).min(1).optional(),
});

const createCatSchema = z.discriminatedUnion('clientId', [createNormalCatSchema, createAntigravityCatSchema]);

const updateCatSchema = z.object({
  name: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  nickname: z.string().optional(),
  avatar: z.string().min(1).optional(),
  color: colorSchema.optional(),
  mentionPatterns: z.array(z.string().min(1)).min(1).optional(),
  accountRef: z.string().min(1).nullable().optional(),
  contextBudget: contextBudgetSchema.nullable().optional(),
  roleDescription: z.string().min(1).optional(),
  personality: z.string().optional(),
  teamStrengths: z.string().optional(),
  caution: z.string().nullable().optional(),
  strengths: z.array(z.string().min(1)).optional(),
  sessionChain: z.boolean().optional(),
  available: z.boolean().optional(),
  clientId: clientSchema.optional(),
  defaultModel: modelSchema.optional(),
  mcpSupport: z.boolean().optional(),
  cli: cliSchema.optional(),
  commandArgs: z.array(z.string().min(1)).optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).nullable().optional(),
});

type UpdateCatRequestBody = z.infer<typeof updateCatSchema>;

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
}

function buildCatResponseMetadataResolver(projectRoot: string) {
  let roster: Record<string, RosterEntry> = {};
  try {
    roster = getRoster(loadCatConfig(resolveCatCatalogPath(projectRoot)));
  } catch {
    roster = {};
  }

  return (catId: string): CatResponseMetadata => ({ roster: roster[catId] ?? null });
}

function defaultCliForClient(client: ClientId): { command: string; outputFormat: string } {
  switch (client) {
    case 'anthropic':
      return { command: 'claude', outputFormat: 'stream-json' };
    case 'openai':
      return { command: 'codex', outputFormat: 'json' };
    case 'google':
      return { command: 'gemini', outputFormat: 'stream-json' };
    case 'kimi':
      return { command: 'kimi', outputFormat: 'stream-json' };
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

type CliPatch = z.infer<typeof cliSchema>;

function buildResolvedCliConfig(client: ClientId, baseCli: CliConfig, patch?: CliPatch): CliConfig {
  const defaultArgs =
    patch?.defaultArgs !== undefined
      ? patch.defaultArgs.length > 0
        ? patch.defaultArgs
        : undefined
      : baseCli.defaultArgs && baseCli.defaultArgs.length > 0
        ? [...baseCli.defaultArgs]
        : undefined;

  const effortTouched = patch ? Object.hasOwn(patch, 'effort') : false;
  const nextEffort = effortTouched ? patch?.effort : baseCli.effort;
  if (nextEffort !== undefined && nextEffort !== null && !isValidCliEffortForProvider(client, nextEffort)) {
    const options = getCliEffortOptionsForProvider(client);
    if (!options) {
      throw new Error(`client "${client}" does not support cli.effort`);
    }
    throw new Error(`client "${client}" only supports cli.effort ${options.join(' / ')}`);
  }

  return {
    command: patch?.command ?? baseCli.command,
    outputFormat: patch?.outputFormat ?? baseCli.outputFormat,
    ...(defaultArgs ? { defaultArgs } : {}),
    ...(nextEffort !== undefined && nextEffort !== null ? { effort: nextEffort } : {}),
  };
}

function resolveAccountRef(body: { accountRef?: string | null }): string | undefined | null {
  if (body.accountRef !== undefined) return body.accountRef;
  return undefined;
}

/**
 * Resolve the target CLI config when patching a cat.
 *
 * Rules:
 * - Explicit body.cli takes precedence (including any effort value user sets)
 * - Provider switch: reset CLI to new provider's default (command, outputFormat, effort)
 * - antigravity commandArgs patch: preserve defaultArgs while using antigravity CLI
 */
function resolveNextCli(params: {
  body: UpdateCatRequestBody;
  currentCat: CatConfig;
  effectiveClient: ClientId;
  hasCommandArgsPatch: boolean;
  nextCommandArgs: string[];
}): CliConfig | undefined {
  const { body, currentCat, effectiveClient, hasCommandArgsPatch, nextCommandArgs } = params;
  const isClientSwitch = body.clientId !== undefined && body.clientId !== currentCat.clientId;
  const defaultCli = defaultCliForClient(effectiveClient);
  const defaultEffort = getDefaultCliEffortForProvider(effectiveClient);

  if (body.cli !== undefined) {
    const baseCli =
      isClientSwitch || !currentCat.cli
        ? {
            ...defaultCli,
            ...(defaultEffort ? { effort: defaultEffort } : {}),
          }
        : currentCat.cli;
    return buildResolvedCliConfig(effectiveClient, baseCli, body.cli);
  }

  if (isClientSwitch) {
    return {
      ...defaultCli,
      ...(defaultEffort ? { effort: defaultEffort } : {}),
      ...(effectiveClient === 'antigravity' && hasCommandArgsPatch && nextCommandArgs.length > 0
        ? { defaultArgs: nextCommandArgs }
        : {}),
    };
  }

  if (effectiveClient === 'antigravity' && hasCommandArgsPatch) {
    return {
      ...defaultCliForClient('antigravity'),
      ...(nextCommandArgs.length > 0 ? { defaultArgs: nextCommandArgs } : {}),
    };
  }

  return undefined;
}

function buildEffectiveAccountRefResolver() {
  return async (cat: CatConfig & { contextBudget?: ContextBudget }): Promise<string | undefined> =>
    resolveBoundAccountRefForCat('', cat.id, cat);
}

async function validateAccountBindingOrThrow(
  projectRoot: string,
  client: ClientId,
  accountRef?: string | null,
  defaultModel?: string | null,
  providerName?: string | null,
  options?: { legacyCompat?: boolean },
): Promise<void> {
  const trimmedAccountRef = accountRef?.trim();
  if (client === 'antigravity' && trimmedAccountRef) {
    throw new Error('antigravity client does not support accountRef');
  }
  if (client !== 'antigravity' && !trimmedAccountRef) {
    throw new Error(`client "${client}" requires a provider binding`);
  }
  if (!trimmedAccountRef) return;
  const runtimeProfile = resolveByAccountRef(projectRoot, trimmedAccountRef);
  if (!runtimeProfile) {
    throw new Error(`provider "${trimmedAccountRef}" not found`);
  }
  const compatibilityError = validateRuntimeProviderBinding(client, runtimeProfile, defaultModel);
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }
  const modelFormatError = validateModelFormatForProvider(client, defaultModel, runtimeProfile.kind, providerName, {
    ...options,
    accountModels: runtimeProfile.models,
  });
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
    clientId: cat.clientId,
    defaultModel: cat.defaultModel,
    cli: cat.cli,
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
    provider: cat.provider,
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
    source: (cat.source ?? 'runtime') as CatSource,
    adapterMode: cat.clientId === 'google' ? (getAcpConfig(cat.id as string) ? 'acp' : 'cli') : undefined,
  };
}

async function reconcileCatRegistry(projectRoot: string, managedIdsBefore: ReadonlySet<string>) {
  const runtimeCats = toAllCatConfigs(loadCatConfig(resolve(projectRoot, '.cat-cafe', 'cat-catalog.json')));
  const extraCats = catRegistry.getAllConfigs();
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeCats)) {
    catRegistry.register(id, config);
  }
  for (const [id, config] of Object.entries(extraCats)) {
    if (!runtimeCats[id] && !managedIdsBefore.has(id)) catRegistry.register(id, config);
  }
  return catRegistry.getAllConfigs();
}

function getManagedCatalogIds(projectRoot: string): Set<string> {
  try {
    return new Set(Object.keys(toAllCatConfigs(loadCatConfig(resolve(projectRoot, '.cat-cafe', 'cat-catalog.json')))));
  } catch {
    return new Set();
  }
}

export const catsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/cats - 获取所有猫猫配置
  app.get('/api/cats', async () => {
    const projectRoot = resolveProjectRoot();
    const resolveMetadata = buildCatResponseMetadataResolver(projectRoot);
    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver();
    return {
      cats: await Promise.all(
        Object.values(getResolvedCats(projectRoot)).map((cat) =>
          toCatResponse(cat, resolveMetadata(cat.id), resolveEffectiveAccountRef),
        ),
      ),
    };
  });

  app.post('/api/cats', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
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
      const providerNameForValidation = 'provider' in body ? body.provider : undefined;
      await validateAccountBindingOrThrow(
        projectRoot,
        body.clientId,
        accountRef,
        body.defaultModel,
        providerNameForValidation,
      );
      const resolvedAvatar = body.avatar ?? '/avatars/default.png';
      if (body.clientId === 'antigravity') {
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
          clientId: 'antigravity',
          defaultModel: body.defaultModel,
          mcpSupport: false,
          cli: {
            ...defaultCliForClient('antigravity'),
            ...(body.commandArgs ? { defaultArgs: body.commandArgs } : {}),
          },
          commandArgs: body.commandArgs,
        });
      } else {
        const resolvedCli = buildResolvedCliConfig(body.clientId, defaultCliForClient(body.clientId), body.cli);
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
          clientId: body.clientId,
          defaultModel: body.defaultModel,
          mcpSupport:
            body.mcpSupport ??
            (body.clientId === 'anthropic' ||
              body.clientId === 'openai' ||
              body.clientId === 'google' ||
              body.clientId === 'opencode'),
          cli: resolvedCli,
          ...(body.cliConfigArgs ? { cliConfigArgs: body.cliConfigArgs } : {}),
          ...(body.provider ? { provider: body.provider } : {}),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }

    const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore);
    await configEventBus.emitChangeAsync({
      source: 'cat-config',
      scope: 'domain',
      changedKeys: [body.catId],
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
    const cat = resolved[body.catId];
    const metadata = buildCatResponseMetadataResolver(projectRoot);
    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver();
    reply.status(201);
    return { cat: await toCatResponse(cat, metadata(cat.id), resolveEffectiveAccountRef), updatedBy: operator };
  });

  app.patch<{ Params: { id: string } }>('/api/cats/:id', async (request, reply) => {
    const operator = resolveHeaderUserId(request);
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

    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver();
    const currentCat = getResolvedCats(projectRoot)[request.params.id] ?? catRegistry.tryGet(request.params.id)?.config;
    if (!currentCat) {
      reply.status(404);
      return { error: `Cat "${request.params.id}" not found` };
    }
    const effectiveClient = body.clientId ?? currentCat.clientId;
    const currentEffectiveAccountRef = await resolveEffectiveAccountRef(currentCat);
    let targetAccountRef = resolveAccountRef(body);
    let effectiveAccountRef =
      targetAccountRef !== undefined ? (targetAccountRef ?? undefined) : currentEffectiveAccountRef;
    const effectiveDefaultModel = body.defaultModel !== undefined ? body.defaultModel : currentCat.defaultModel;

    // Auto-rebase builtin binding when switching client families.
    // When the editor sends the old client's builtin accountRef during a provider switch,
    // rebase to the new client's builtin so validation doesn't reject the stale ref.
    const isClientSwitch = body.clientId !== undefined && body.clientId !== currentCat.clientId;
    if (isClientSwitch && effectiveAccountRef) {
      const oldBuiltin = resolveBuiltinClientForProvider(currentCat.clientId);
      if (oldBuiltin && builtinAccountIdForClient(oldBuiltin) === effectiveAccountRef) {
        const newBuiltin = resolveBuiltinClientForProvider(effectiveClient);
        if (newBuiltin) {
          effectiveAccountRef = builtinAccountIdForClient(newBuiltin) ?? undefined;
          targetAccountRef = effectiveAccountRef;
        }
      }
    }
    const providerConfigTouched =
      body.clientId !== undefined ||
      body.defaultModel !== undefined ||
      targetAccountRef !== undefined ||
      body.provider !== undefined;

    if (providerConfigTouched) {
      try {
        const effectiveProviderName = body.provider !== undefined ? body.provider : currentCat.provider;
        // Legacy compat: existing opencode+api_key members without provider name
        // can still be edited for non-binding changes (name, model, etc.).
        // NOT allowed when: switching accountRef, or switching clientId to opencode
        // from another client — both create a new binding that must have provider name.
        // Compare against current binding — editor always sends accountRef even when unchanged.
        const isBindingChange =
          targetAccountRef !== undefined && (targetAccountRef ?? undefined) !== currentEffectiveAccountRef;
        const isClientSwitch = body.clientId !== undefined && body.clientId !== currentCat.clientId;
        const isExistingOpencode = currentCat.clientId === 'opencode';
        const legacyCompat =
          body.provider === undefined &&
          !currentCat.provider &&
          !isBindingChange &&
          !isClientSwitch &&
          isExistingOpencode;
        await validateAccountBindingOrThrow(
          projectRoot,
          effectiveClient,
          effectiveAccountRef,
          effectiveDefaultModel,
          effectiveProviderName,
          { legacyCompat },
        );
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
      const nextCli = resolveNextCli({
        body,
        currentCat,
        effectiveClient,
        hasCommandArgsPatch,
        nextCommandArgs,
      });
      updateRuntimeCat(projectRoot, request.params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.nickname !== undefined ? { nickname: body.nickname } : {}),
        ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.mentionPatterns !== undefined ? { mentionPatterns: body.mentionPatterns } : {}),
        ...(targetAccountRef !== undefined ? { accountRef: targetAccountRef } : {}),
        ...(body.contextBudget !== undefined ? { contextBudget: body.contextBudget } : {}),
        ...(body.roleDescription !== undefined ? { roleDescription: body.roleDescription } : {}),
        ...(body.personality !== undefined ? { personality: body.personality } : {}),
        ...(body.teamStrengths !== undefined ? { teamStrengths: body.teamStrengths } : {}),
        ...(body.caution !== undefined ? { caution: body.caution } : {}),
        ...(body.strengths !== undefined ? { strengths: body.strengths } : {}),
        ...(body.sessionChain !== undefined ? { sessionChain: body.sessionChain } : {}),
        ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.mcpSupport !== undefined ? { mcpSupport: body.mcpSupport } : {}),
        ...(hasCommandArgsPatch
          ? {
              commandArgs: body.commandArgs,
            }
          : {}),
        ...(nextCli !== undefined ? { cli: nextCli } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
        ...(body.cliConfigArgs !== undefined ? { cliConfigArgs: body.cliConfigArgs } : {}),
        ...(body.provider !== undefined
          ? body.provider === null
            ? { provider: null }
            : { provider: body.provider }
          : {}),
      });
      const resolved = await reconcileCatRegistry(projectRoot, managedIdsBefore);
      await configEventBus.emitChangeAsync({
        source: 'cat-config',
        scope: 'domain',
        changedKeys: [request.params.id],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
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
    const operator = resolveHeaderUserId(request);
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
      await reconcileCatRegistry(projectRoot, managedIdsBefore);
      await configEventBus.emitChangeAsync({
        source: 'cat-config',
        scope: 'domain',
        changedKeys: [request.params.id],
        changeSetId: createChangeSetId(),
        timestamp: Date.now(),
      });
      return { deleted: true, id: request.params.id, updatedBy: operator };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cannot delete seed cat/i.test(message)) {
        reply.status(409);
      } else if (/not found/i.test(message)) {
        reply.status(404);
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
