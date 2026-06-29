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
import {
  inheritFullyBlockedMcpCapabilitiesForNewCat,
  removeDeletedCatFromBlockedMcps,
} from '../config/capabilities/capability-orchestrator.js';
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

const clientSchema = z.enum(['anthropic', 'openai', 'google', 'kimi', 'antigravity', 'opencode', 'catagent', 'acp']);

/** F161: ACP transport config schema — matches AcpVariantConfig from cat-config-loader. */
const acpConfigSchema = z
  .object({
    command: z.string().min(1),
    startupArgs: z.array(z.string()),
    /** F161 Phase C: wire transport. 'stdio' (default, omitted) or 'httpstream'. */
    transport: z.enum(['stdio', 'httpstream']).optional(),
    /** Required for httpstream until ACP publishes a stable HTTP transport spec. */
    experimental: z.literal(true).optional(),
    mcpWhitelist: z.array(z.string().min(1)).optional(),
    supportsMultiplexing: z.boolean().optional(),
    pool: z
      .object({
        maxLiveProcesses: z.number().int().positive().optional(),
        idleTtlMs: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'httpstream' && value.experimental !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['experimental'],
        message: 'ACP httpstream transport is experimental; set acp.experimental=true to enable it',
      });
    }
  });
type AcpRouteConfig = z.infer<typeof acpConfigSchema>;

function resolveGenericAcpMcpSupport(
  explicitMcpSupport: boolean | undefined,
  acpConfig: AcpRouteConfig | null | undefined,
): boolean | undefined {
  if (explicitMcpSupport !== undefined) return explicitMcpSupport;
  return acpConfig ? true : undefined;
}

function resolveGenericAcpMcpSupportForPatch(
  explicitMcpSupport: boolean | undefined,
  acpConfig: AcpRouteConfig | null | undefined,
  isClientSwitchToGenericAcp: boolean,
): boolean | undefined {
  if (explicitMcpSupport !== undefined) return explicitMcpSupport;
  if (acpConfig !== undefined && acpConfig !== null) {
    if (acpConfig.mcpWhitelist !== undefined && acpConfig.mcpWhitelist.length > 0) return true;
    if (isClientSwitchToGenericAcp) return true;
    return undefined;
  }
  return isClientSwitchToGenericAcp ? true : undefined;
}

const catIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'catId must use lowercase letters, numbers, "_" or "-" and start with a letter');

const voiceConfigSchema = z.object({
  voice: z.string().min(1),
  langCode: z.string().min(1),
  speed: z.number().positive().optional(),
  refAudio: z.string().min(1).optional(),
  refText: z.string().min(1).optional(),
  instruct: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const baseCatSchema = z.object({
  catId: catIdSchema,
  name: z.string().min(1),
  displayName: z.string().min(1),
  variantLabel: z.string().optional(),
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
  voiceConfig: voiceConfigSchema.optional(),
});

/** Strip trailing slashes from model names — prevents "MiniMax-M2.7/" artifacts.
 *  Empty string is allowed: OAuth/subscription accounts may omit model and
 *  let the CLI use its built-in default. api_key accounts are validated at
 *  runtime in validateAccountBindingOrThrow where authType is available. */
const modelSchema = z.string().transform((v) => v.replace(/\/+$/, ''));

const createNormalCatSchema = baseCatSchema.extend({
  clientId: clientSchema.exclude(['antigravity', 'acp']),
  defaultModel: modelSchema,
  mcpSupport: z.boolean().optional(),
  cli: cliSchema.optional(),
  cliConfigArgs: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).optional(),
  acp: acpConfigSchema.optional(), // F161: optional ACP transport for any client
});

const createAntigravityCatSchema = baseCatSchema.extend({
  clientId: z.literal('antigravity'),
  defaultModel: modelSchema,
  mcpSupport: z.boolean().optional(),
  commandArgs: z.array(z.string().min(1)).min(1).optional(),
});

/** F161: Generic ACP client — acp section required (it's the only transport). */
const createAcpCatSchema = baseCatSchema.extend({
  clientId: z.literal('acp'),
  defaultModel: modelSchema,
  mcpSupport: z.boolean().optional(),
  // F161 AC-A5 / KD-1: generic ACP is a transport, not a provider identity — no provider field.
  // Env customization flows through the account's envVars templates. Any incoming provider is
  // dropped by zod (unknown key) so it never reaches persistence.
  acp: acpConfigSchema,
});

const createCatSchema = z.discriminatedUnion('clientId', [
  createNormalCatSchema,
  createAntigravityCatSchema,
  createAcpCatSchema,
]);

const updateCatSchema = z.object({
  name: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  variantLabel: z.string().nullable().optional(),
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
  voiceConfig: voiceConfigSchema.nullable().optional(),
  acp: acpConfigSchema.nullable().optional(), // F161: nullable to allow removing ACP transport
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

/**
 * Infer OpenCode provider from a bare model name.
 * Returns a known provider string or undefined (triggers validation error).
 */
function inferProviderFromModelName(model: string): string | undefined {
  const m = model.trim().toLowerCase();
  if (/^(gpt-|o[134]-|o[134]p|davinci|text-|chatgpt)/.test(m)) return 'openai';
  if (/^claude/.test(m)) return 'anthropic';
  if (/^gemini/.test(m)) return 'google';
  if (/^(moonshot|kimi)/.test(m)) return 'kimi';
  if (/^deepseek/.test(m)) return 'deepseek';
  if (/^(glm|chatglm)/.test(m)) return 'zhipu';
  if (/^(qwen|tongyi)/.test(m)) return 'dashscope';
  if (/^minimax/.test(m)) return 'minimax';
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
  // api_key accounts require an explicit model; OAuth/subscription CLIs have defaults
  if (runtimeProfile.authType === 'api_key' && !defaultModel?.trim()) {
    throw new Error('API Key 认证类型需要指定 Model');
  }
  const compatibilityError = validateRuntimeProviderBinding(client, runtimeProfile, defaultModel);
  if (compatibilityError) {
    throw new Error(compatibilityError);
  }
  const modelFormatError = validateModelFormatForProvider(client, defaultModel, runtimeProfile.authType, providerName, {
    ...options,
    accountModels: runtimeProfile.models,
  });
  if (modelFormatError) {
    throw new Error(modelFormatError);
  }
}

async function toCatResponse(
  cat: CatConfig & { contextBudget?: ContextBudget },
  projectRoot: string,
  metadata: CatResponseMetadata,
  resolveEffectiveAccountRef: (cat: CatConfig & { contextBudget?: ContextBudget }) => Promise<string | undefined>,
) {
  const acpConfig = getAcpConfig(cat.id as string, projectRoot);
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
    voiceConfig: cat.voiceConfig,
    commandArgs: cat.commandArgs,
    cliConfigArgs: cat.cliConfigArgs,
    provider: cat.provider,
    variantLabel: cat.variantLabel ?? undefined,
    isDefaultVariant: cat.isDefaultVariant ?? undefined,
    breedDisplayName: cat.breedDisplayName ?? undefined,
    mcpSupport: cat.mcpSupport,
    ...(acpConfig ? { acp: acpConfig } : {}),
    roster: metadata.roster
      ? {
          family: metadata.roster.family,
          roles: [...metadata.roster.roles],
          lead: metadata.roster.lead,
          available: metadata.roster.available,
          evaluation: metadata.roster.evaluation,
        }
      : null,
    // F161: adapterMode is now provider-agnostic — any clientId can have ACP config
    adapterMode: acpConfig ? 'acp' : 'cli',
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

/**
 * #712: Inherit fully-blocked MCP state for all projects with capabilities.json.
 *
 * When a new cat is added, any MCP entry where ALL existing cats are in blockedCats
 * should also block the new cat (the MCP is effectively fully disabled). The main
 * call site only handles projectRoot; this function covers all other projects
 * via the unified listAllProjectPaths (#712).
 */
async function inheritBlockedMcpForAllProjects(
  alreadyHandledRoot: string,
  newCatId: string,
  existingCatIds: ReadonlySet<string>,
): Promise<void> {
  const catCafeRoot = resolveProjectRoot();
  const { listAllProjectPaths } = await import('../config/governance/list-all-projects.js');

  // listAllProjectPaths already excludes catCafeRoot, deduplicates, and validates.
  // We also need catCafeRoot itself if it differs from alreadyHandledRoot.
  const allPaths = await listAllProjectPaths(catCafeRoot);
  if (resolve(catCafeRoot) !== resolve(alreadyHandledRoot)) {
    allPaths.unshift(catCafeRoot);
  }

  // Filter out the already-handled root (caller already did this one)
  const resolvedHandled = resolve(alreadyHandledRoot);
  const toProcess = allPaths.filter((p) => resolve(p) !== resolvedHandled);

  await Promise.all(
    toProcess.map((p) => inheritFullyBlockedMcpCapabilitiesForNewCat(p, newCatId, existingCatIds).catch(() => {})),
  );
}

/**
 * #712: Remove a deleted cat from blockedCats across all projects.
 *
 * Counterpart to inheritBlockedMcpForAllProjects — when a cat is deleted,
 * its ID should be cleaned from every MCP's blockedCats to avoid ghost entries.
 */
async function cleanupBlockedMcpForAllProjects(projectRoot: string, deletedCatId: string): Promise<void> {
  const catCafeRoot = resolveProjectRoot();
  const { listAllProjectPaths } = await import('../config/governance/list-all-projects.js');

  const allPaths = await listAllProjectPaths(catCafeRoot);
  // Also include catCafeRoot itself (listAllProjectPaths excludes it)
  allPaths.unshift(catCafeRoot);
  // And the active projectRoot if different
  if (resolve(projectRoot) !== resolve(catCafeRoot)) {
    const resolvedProject = resolve(projectRoot);
    if (!allPaths.some((p) => resolve(p) === resolvedProject)) {
      allPaths.push(projectRoot);
    }
  }

  await Promise.all(allPaths.map((p) => removeDeletedCatFromBlockedMcps(p, deletedCatId).catch(() => {})));
}

interface CatsRoutesOptions {
  onCatalogChanged?: (cats: Record<string, CatConfig>) => Promise<void> | void;
}

export const catsRoutes: FastifyPluginAsync<CatsRoutesOptions> = async (app, opts) => {
  // GET /api/cat-templates - 获取角色模板（纯灵魂层，不含 client/model 绑定）
  app.get('/api/cat-templates', async () => {
    try {
      const projectRoot = resolveProjectRoot();
      const templatePath = resolveProjectTemplatePath(projectRoot);
      const raw = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(templatePath, 'utf-8'))) as {
        roleTemplates?: {
          id: string;
          name: string;
          nickname?: string;
          avatar: string;
          color: { primary: string; secondary: string };
          roleDescription: string;
          personality: string;
          teamStrengths?: string;
        }[];
        clientDefaults?: Record<string, { defaultModel: string; models: string[] }>;
      };
      if (raw.roleTemplates && raw.roleTemplates.length > 0) {
        return { templates: raw.roleTemplates, clientDefaults: raw.clientDefaults ?? {} };
      }
      // Fallback: extract from breeds (legacy)
      const templateConfig = loadCatConfig(templatePath);
      const allCats = Object.values(toAllCatConfigs(templateConfig));
      const templateCats = allCats.filter((c) => c.isDefaultVariant);
      return {
        templates: templateCats.map((cat) => ({
          id: cat.breedId ?? cat.id,
          name: cat.breedDisplayName ?? cat.displayName ?? cat.name,
          nickname: cat.nickname,
          avatar: cat.avatar,
          color: cat.color,
          roleDescription: cat.roleDescription,
          personality: cat.personality,
          teamStrengths: cat.teamStrengths,
        })),
        clientDefaults: {},
      };
    } catch (err) {
      app.log.warn({ err }, 'Failed to load cat templates');
      return { templates: [], clientDefaults: {} };
    }
  });

  // GET /api/cats - 获取所有猫猫配置
  app.get('/api/cats', async () => {
    const projectRoot = resolveProjectRoot();
    const resolveMetadata = buildCatResponseMetadataResolver(projectRoot);
    const resolveEffectiveAccountRef = buildEffectiveAccountRefResolver();
    return {
      cats: await Promise.all(
        Object.values(getResolvedCats(projectRoot)).map((cat) =>
          toCatResponse(cat, projectRoot, resolveMetadata(cat.id), resolveEffectiveAccountRef),
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
      /* Infer provider for opencode API-key accounts from the model name when no
         explicit provider is given. This avoids hard-coding 'openai' for all bare
         models — Anthropic/Google accounts get the correct adapter.
         Unknown model prefixes → undefined → validation error preserved. */
      const explicitProvider = 'provider' in body ? body.provider : undefined;
      const providerNameForValidation =
        explicitProvider ??
        (body.clientId === 'opencode' && body.defaultModel && !body.defaultModel.includes('/')
          ? inferProviderFromModelName(body.defaultModel)
          : undefined);
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
          variantLabel: body.variantLabel,
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
          mcpSupport: body.mcpSupport ?? true,
          cli: {
            ...defaultCliForClient('antigravity'),
            ...(body.commandArgs ? { defaultArgs: body.commandArgs } : {}),
          },
          commandArgs: body.commandArgs,
          ...(body.voiceConfig ? { voiceConfig: body.voiceConfig } : {}),
        });
      } else if (body.clientId === 'acp') {
        // F161: Generic ACP client — no CLI config, ACP section is the transport.
        createRuntimeCat(projectRoot, {
          catId: body.catId,
          name: body.name,
          displayName: body.displayName,
          variantLabel: body.variantLabel,
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
          clientId: 'acp',
          defaultModel: body.defaultModel,
          mcpSupport: resolveGenericAcpMcpSupport(body.mcpSupport, body.acp) ?? false,
          cli: defaultCliForClient('acp'),
          // F161 AC-A5 / KD-1: generic ACP never carries provider (already stripped by schema).
          ...(body.voiceConfig ? { voiceConfig: body.voiceConfig } : {}),
          acp: body.acp,
        });
      } else {
        const resolvedCli = buildResolvedCliConfig(body.clientId, defaultCliForClient(body.clientId), body.cli);
        createRuntimeCat(projectRoot, {
          catId: body.catId,
          name: body.name,
          displayName: body.displayName,
          variantLabel: body.variantLabel,
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
              body.clientId === 'kimi' ||
              body.clientId === 'opencode'),
          cli: resolvedCli,
          ...(body.cliConfigArgs ? { cliConfigArgs: body.cliConfigArgs } : {}),
          ...(body.provider || providerNameForValidation
            ? { provider: body.provider ?? providerNameForValidation }
            : {}),
          ...(body.voiceConfig ? { voiceConfig: body.voiceConfig } : {}),
          ...(body.acp ? { acp: body.acp } : {}),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.status(400);
      return { error: message };
    }

    await inheritFullyBlockedMcpCapabilitiesForNewCat(projectRoot, body.catId, managedIdsBefore);
    // #712: Also inherit fully-blocked MCP state for all governance-registered projects.
    // Without this, only the active project's capabilities.json gets the new cat added
    // to blockedCats — other projects' fully-disabled MCPs silently become enabled for
    // the new member.
    await inheritBlockedMcpForAllProjects(projectRoot, body.catId, managedIdsBefore);
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
    return {
      cat: await toCatResponse(cat, projectRoot, metadata(cat.id), resolveEffectiveAccountRef),
      updatedBy: operator,
    };
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
    const currentAcpConfig = getAcpConfig(request.params.id as string, projectRoot);
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
        // F161 AC-A5 / KD-1: generic ACP carries no provider — exclude it from binding validation.
        const effectiveProviderName =
          effectiveClient === 'acp' ? undefined : body.provider !== undefined ? body.provider : currentCat.provider;
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

    // F161 invariant: clientId 'acp' must have an effective acp config.
    // Prevents persisting an unroutable ACP member (no command/startupArgs).
    if (effectiveClient === 'acp') {
      const effectiveAcpConfig = body.acp !== undefined ? body.acp : currentAcpConfig;
      if (!effectiveAcpConfig) {
        reply.status(400);
        return { error: 'clientId "acp" requires an acp transport config (command + startupArgs)' };
      }
    }

    const shouldClearAcpOnClientSwitch =
      isClientSwitch && effectiveClient !== 'acp' && body.acp === undefined && currentAcpConfig !== undefined;

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
      const nextGenericAcpMcpSupport =
        effectiveClient === 'acp'
          ? resolveGenericAcpMcpSupportForPatch(body.mcpSupport, body.acp, isClientSwitch)
          : body.mcpSupport;
      updateRuntimeCat(projectRoot, request.params.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.variantLabel !== undefined ? { variantLabel: body.variantLabel } : {}),
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
        ...(nextGenericAcpMcpSupport !== undefined ? { mcpSupport: nextGenericAcpMcpSupport } : {}),
        ...(hasCommandArgsPatch
          ? {
              commandArgs: body.commandArgs,
            }
          : {}),
        ...(nextCli !== undefined ? { cli: nextCli } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
        ...(body.cliConfigArgs !== undefined ? { cliConfigArgs: body.cliConfigArgs } : {}),
        // F161 AC-A5 / KD-1: generic ACP never carries provider — clear any stale value and
        // ignore incoming provider; other clients keep the explicit set/clear semantics.
        ...(effectiveClient === 'acp'
          ? currentCat.provider != null
            ? { provider: null }
            : {}
          : body.provider !== undefined
            ? body.provider === null
              ? { provider: null }
              : { provider: body.provider }
            : {}),
        ...(body.voiceConfig !== undefined
          ? body.voiceConfig === null
            ? { voiceConfig: null }
            : { voiceConfig: body.voiceConfig }
          : {}),
        ...(body.acp !== undefined
          ? body.acp === null
            ? { acp: null }
            : { acp: body.acp }
          : shouldClearAcpOnClientSwitch
            ? { acp: null }
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
      return {
        cat: await toCatResponse(cat, projectRoot, metadata(cat.id), resolveEffectiveAccountRef),
        updatedBy: operator,
      };
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
      // #712: Remove deleted cat from blockedCats across all projects.
      // Without this, the deleted cat's ID lingers as a ghost entry in MCP
      // access control, which is harmless at runtime but confusing in the UI.
      await cleanupBlockedMcpForAllProjects(projectRoot, request.params.id);
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
      if (/not found/i.test(message)) {
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
