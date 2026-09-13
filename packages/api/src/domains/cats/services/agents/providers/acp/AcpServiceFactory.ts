import type { CatConfig } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import {
  type RuntimeProviderProfile,
  resolveBuiltinClientForProvider,
  resolveByAccountRef,
  resolveForClient,
  validateRuntimeProviderBinding,
} from '../../../../../../config/account-resolver.js';
import { AccountStoreVerdictError } from '../../../../../../config/account-store-format.js';
import { resolveBoundAccountRefForCat } from '../../../../../../config/cat-account-binding.js';
import type { AcpVariantConfig } from '../../../../../../config/cat-config-loader.js';
import { resolveContextCapacity } from '../../../../../../config/context-capacity.js';
import { resolveEffectiveOpenCodeModel } from '../../../../../../config/opencode-model.js';
import { prepareOpenCodeAcpSpawnConfig } from '../opencode-acp-spawn-config.js';
import { AcpAgentService } from './AcpAgentService.js';
import { AcpClient } from './AcpClient.js';
import { AcpHttpStreamClient } from './AcpHttpStreamClient.js';
import { AcpProcessPool, DEFAULT_ACP_IDLE_TTL_MS, type PoolKey } from './AcpProcessPool.js';
import { resolveAcpBootstrapArgs, resolveAcpBootstrapCommand, resolveAcpBootstrapCwd } from './acp-bootstrap-cwd.js';
// resolveAcpMcpServers + resolveDisabledServerIds moved to AcpAgentService.invoke()
// for invoke-time resolution (#712 P1-1).
import { createAcpPoolSpawnSignature } from './acp-pool-signature.js';
import { tryPrepareAcpProcessEnv } from './acp-spawn-env.js';
import {
  dshOmitsAcpSessionMcp,
  isDshHarnessCommand,
  mintDshCredentialFile,
  prepareDshAcpSpawnForProject,
} from './dsh-acp-bootstrap.js';
import { applyZcodeHarnessSpawn, zcodeOmitsAcpSessionMcp, zcodeUnreadyMessage } from './zcode-acp-bootstrap.js';

export type AcpPoolRegistry = Map<string, AcpProcessPool>;

/**
 * DSH continuable background turns outlive a Hub lease. Multiplexing would
 * reuse the spawn-frozen credential file across invocations. Catalog config
 * cannot opt DSH back into multiplexing.
 */
export function resolveEffectiveAcpSupportsMultiplexing(
  acpConfig: Pick<AcpVariantConfig, 'command' | 'supportsMultiplexing'>,
): boolean {
  if (isDshHarnessCommand(acpConfig.command)) return false;
  return acpConfig.supportsMultiplexing === true;
}

export interface CreateAcpServiceForConfigInput {
  projectRoot: string;
  profileId: string;
  config: CatConfig;
  /** Effective model resolved once by registry construction (env override included). */
  effectiveModel: string;
  acpConfig: AcpVariantConfig;
  poolRegistry: AcpPoolRegistry;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

interface AcpBootstrapContext {
  projectRoot: string;
  command: string;
  args: string[];
  cwd: string;
  model?: string;
  poolKey: PoolKey;
  extraEnv?: Record<string, string>;
}

interface AcpAccountContext {
  accountRef?: string;
  account: RuntimeProviderProfile | null;
}

interface AcpSpawnContext {
  env?: Record<string, string>;
  sessionModel?: string;
  openCodeRuntimeConfig: unknown;
  contextPolicy: AcpContextPolicy | null;
}

interface AcpContextPolicy {
  windowTokens: number | null;
  inputCeilingTokens: number | null;
  source: string;
}

const CONTEXT_POLICY_ACP_CLIENTS = new Set(['opencode', 'google', 'kimi']);

function resolveAcpContextPolicy(config: CatConfig, effectiveModel: string): AcpContextPolicy | null {
  if (!CONTEXT_POLICY_ACP_CLIENTS.has(config.clientId)) return null;
  const legacyCap = (config.cli as { contextWindow?: number } | undefined)?.contextWindow;
  const capacity = resolveContextCapacity({
    catId: config.id,
    memberWindowTokens: config.contextWindow ?? (legacyCap && legacyCap > 0 ? legacyCap : undefined),
    model: effectiveModel,
  });
  const resolved = capacity.source !== 'unresolved';
  return {
    windowTokens: resolved ? capacity.windowTokens : null,
    inputCeilingTokens: resolved ? capacity.inputCeilingTokens : null,
    source: capacity.source,
  };
}

async function closeAcpPoolForProfile(
  poolRegistry: AcpPoolRegistry,
  profileId: string,
  reason: string,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<void> {
  const existingPool = poolRegistry.get(profileId);
  if (!existingPool) return;
  try {
    await existingPool.closeAll();
  } catch (err) {
    log.warn({ err, profileId, reason }, 'ACP registry sync failed to close skipped member pool');
  } finally {
    poolRegistry.delete(profileId);
  }
}

async function skipAcpProfile(
  input: CreateAcpServiceForConfigInput,
  reason: string,
  logPayload: Record<string, unknown>,
  message: string,
): Promise<null> {
  input.log.warn(logPayload, message);
  await closeAcpPoolForProfile(input.poolRegistry, input.profileId, reason, input.log);
  return null;
}

function resolveAcpBootstrap(
  projectRoot: string,
  profileId: string,
  acpConfig: AcpVariantConfig,
  effectiveModel: string,
): AcpBootstrapContext {
  const model = effectiveModel.trim() || undefined;
  const args = resolveAcpBootstrapArgs(projectRoot, acpConfig.startupArgs, {
    base_model: model,
    model,
  });
  return {
    projectRoot,
    command: resolveAcpBootstrapCommand(projectRoot, acpConfig.command),
    args,
    cwd: resolveAcpBootstrapCwd(projectRoot, profileId),
    model,
    poolKey: { projectPath: projectRoot, providerProfile: profileId },
  };
}

function resolveAcpAccount(projectRoot: string, config: CatConfig): AcpAccountContext {
  const catId = config.id;
  const accountRef = resolveBoundAccountRefForCat(projectRoot, catId, config);
  const builtinClient = resolveBuiltinClientForProvider(config.clientId);
  const account = builtinClient
    ? resolveForClient(projectRoot, builtinClient, accountRef)
    : accountRef
      ? resolveByAccountRef(projectRoot, accountRef)
      : null;
  return { accountRef, account };
}

async function prepareAcpSpawnContext(
  input: CreateAcpServiceForConfigInput,
  bootstrap: AcpBootstrapContext,
  accountContext: AcpAccountContext,
): Promise<AcpSpawnContext | null> {
  const { config, profileId } = input;
  const catId = config.id;
  const acpEnvResult = tryPrepareAcpProcessEnv({
    clientId: config.clientId,
    provider: config.provider,
    command: input.acpConfig.command,
    baseModel: bootstrap.model,
    account: accountContext.account,
  });
  if (!acpEnvResult.ok) {
    return skipAcpProfile(
      input,
      'invalid-spawn-env',
      { err: acpEnvResult.error, catId, profileId, accountRef: accountContext.accountRef },
      'ACP registry sync skipped member due to invalid spawn env',
    );
  }
  let acpSpawnEnv: Record<string, string> | undefined = {
    ...(bootstrap.extraEnv ?? {}),
    ...(acpEnvResult.env ?? {}),
  };
  if (Object.keys(acpSpawnEnv).length === 0) acpSpawnEnv = undefined;

  let openCodeAcpSpawnConfig: Awaited<ReturnType<typeof prepareOpenCodeAcpSpawnConfig>>;
  const contextPolicy = resolveAcpContextPolicy(config, input.effectiveModel);
  if (config.clientId === 'kimi' && contextPolicy?.windowTokens) {
    // kimi-code's ACP server creates sessions through the same KimiCLI.create()
    // path as the CLI. KIMI_MODEL_MAX_CONTEXT_SIZE is its supported model-window
    // override, so keep the member policy process-scoped instead of mutating the
    // user's shared ~/.kimi/config.toml.
    acpSpawnEnv = {
      ...(acpSpawnEnv ?? {}),
      KIMI_MODEL_MAX_CONTEXT_SIZE: String(contextPolicy.windowTokens),
    };
  }
  try {
    openCodeAcpSpawnConfig = await prepareOpenCodeAcpSpawnConfig({
      projectRoot: bootstrap.projectRoot,
      profileId,
      clientId: config.clientId,
      providerName: config.provider,
      defaultModel: input.effectiveModel,
      account: accountContext.account,
    });
  } catch (err) {
    return skipAcpProfile(
      input,
      'invalid-opencode-spawn-config',
      { err, catId, profileId, accountRef: accountContext.accountRef },
      'ACP registry sync skipped member due to invalid OpenCode spawn config',
    );
  }

  let sessionModel = bootstrap.model;
  if (openCodeAcpSpawnConfig) {
    sessionModel = openCodeAcpSpawnConfig.runtimeConfigSummary.model ?? sessionModel;
    acpSpawnEnv = { ...(acpSpawnEnv ?? {}), ...openCodeAcpSpawnConfig.env };
    input.log.info(
      {
        catId,
        profileId,
        configPath: openCodeAcpSpawnConfig.configPath,
        runtimeConfigSummary: openCodeAcpSpawnConfig.runtimeConfigSummary,
      },
      'ACP OpenCode: prepared spawn runtime config',
    );
  }

  return {
    env: acpSpawnEnv,
    sessionModel,
    openCodeRuntimeConfig: openCodeAcpSpawnConfig?.runtimeConfigSummary ?? null,
    contextPolicy,
  };
}

async function ensureAcpPool(
  input: CreateAcpServiceForConfigInput,
  bootstrap: AcpBootstrapContext,
  spawn: AcpSpawnContext,
): Promise<AcpProcessPool> {
  const { profileId, acpConfig, poolRegistry } = input;
  const supportsMultiplexing = resolveEffectiveAcpSupportsMultiplexing(acpConfig);
  const spawnSignature = createAcpPoolSpawnSignature({
    command: bootstrap.command,
    args: bootstrap.args,
    cwd: bootstrap.cwd,
    env: spawn.env ?? null,
    openCodeRuntimeConfig: spawn.openCodeRuntimeConfig,
    contextPolicy: spawn.contextPolicy,
    maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
    idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
    transport: acpConfig.transport ?? 'stdio',
    supportsMultiplexing,
  });

  const existingPool = poolRegistry.get(profileId);
  if (existingPool && existingPool.spawnSignature !== spawnSignature) {
    existingPool.retireWhenIdle();
    poolRegistry.delete(profileId);
  }

  const activePool = poolRegistry.get(profileId);
  if (activePool) return activePool;

  const pool = new AcpProcessPool(
    {
      maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
      idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
      healthCheckIntervalMs: 30_000,
    },
    { ...acpConfig, supportsMultiplexing },
    () => {
      const retireAfterLease = isDshHarnessCommand(acpConfig.command);
      const env = { ...(spawn.env ?? {}) };
      if (retireAfterLease) {
        env.CAT_CAFE_CREDENTIAL_FILE = mintDshCredentialFile(input.projectRoot, input.config.id);
      }
      const clientCfg = {
        command: bootstrap.command,
        args: bootstrap.args,
        cwd: bootstrap.cwd,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        retireAfterLease,
      };
      return acpConfig.transport === 'httpstream' ? new AcpHttpStreamClient(clientCfg) : new AcpClient(clientCfg);
    },
    spawnSignature,
  );
  poolRegistry.set(profileId, pool);
  return pool;
}

export async function createAcpServiceForConfig(
  input: CreateAcpServiceForConfigInput,
): Promise<AcpAgentService | null> {
  const { projectRoot, profileId, config, acpConfig } = input;
  const catId = config.id;
  const effectiveModel =
    config.clientId === 'opencode'
      ? (resolveEffectiveOpenCodeModel(config.provider, input.effectiveModel)?.model ?? input.effectiveModel)
      : input.effectiveModel;
  const effectiveInput = effectiveModel === input.effectiveModel ? input : { ...input, effectiveModel };

  if (acpConfig.transport === 'httpstream' && acpConfig.experimental !== true) {
    return skipAcpProfile(
      input,
      'httpstream-missing-experimental-opt-in',
      { catId, profileId },
      'ACP registry sync skipped member because httpstream transport requires experimental opt-in',
    );
  }

  let bootstrap = resolveAcpBootstrap(projectRoot, profileId, acpConfig, effectiveModel);
  if (isDshHarnessCommand(acpConfig.command)) {
    const dshPrepared = await prepareDshAcpSpawnForProject({
      command: acpConfig.command,
      args: acpConfig.startupArgs,
      projectRoot: bootstrap.projectRoot,
      bootstrapCwd: bootstrap.cwd,
      mcpWhitelist: acpConfig.mcpWhitelist ?? [],
      mcpSupport: config.mcpSupport !== false,
      catId,
    });
    if (!dshPrepared.ok) {
      return skipAcpProfile(
        input,
        'dsh-acp-unavailable',
        { err: dshPrepared.error, catId, profileId },
        dshPrepared.error.message,
      );
    }
    bootstrap = {
      ...bootstrap,
      command: dshPrepared.command,
      args: dshPrepared.args,
      extraEnv: dshPrepared.env,
      // Overlay + official plugins resolve from the composition dir, not ACP tmp cwd.
      cwd: dshPrepared.cwd,
    };
  }
  const zcodePrepared = applyZcodeHarnessSpawn(bootstrap, acpConfig.command);
  if (!zcodePrepared.ok) {
    return skipAcpProfile(
      input,
      'zcode-acp-unavailable',
      { err: zcodePrepared.error, catId, profileId },
      zcodePrepared.error.message,
    );
  }
  bootstrap = zcodePrepared.bootstrap;
  let accountContext: AcpAccountContext;
  try {
    accountContext = resolveAcpAccount(bootstrap.projectRoot, config);
  } catch (error) {
    if (!(error instanceof AccountStoreVerdictError)) throw error;
    return skipAcpProfile(
      input,
      'rejected-account-binding',
      { catId, profileId, reason: error.message },
      'ACP registry sync skipped member because its account could not be adjudicated',
    );
  }
  if (accountContext.accountRef && !accountContext.account) {
    return skipAcpProfile(
      input,
      'missing-account-binding',
      { catId, profileId, accountRef: accountContext.accountRef },
      'ACP registry sync skipped member because bound accountRef could not be resolved',
    );
  }
  if (accountContext.account) {
    const error = validateRuntimeProviderBinding(config.clientId, accountContext.account, effectiveModel);
    if (error) {
      return skipAcpProfile(
        input,
        'incompatible-account-binding',
        { catId, profileId, accountRef: accountContext.accountRef, error },
        'ACP registry sync skipped member because account identity is incompatible with its destination',
      );
    }
  }
  const spawn = await prepareAcpSpawnContext(effectiveInput, bootstrap, accountContext);
  if (!spawn) return null;
  const zcodeUnready = zcodeUnreadyMessage(acpConfig.command, { ...process.env, ...spawn.env });
  if (zcodeUnready) {
    return skipAcpProfile(
      input,
      'zcode-provider-unready',
      { catId, profileId, accountRef: accountContext.accountRef },
      zcodeUnready,
    );
  }
  const pool = await ensureAcpPool(effectiveInput, bootstrap, spawn);

  // #712 P1-1: pass whitelist — MCP resolution happens at invoke time in
  // AcpAgentService so capability toggles take effect without registry rebuild.
  return new AcpAgentService({
    catId,
    pool,
    poolKey: bootstrap.poolKey,
    projectRoot: bootstrap.projectRoot,
    mcpWhitelist: acpConfig.mcpWhitelist ?? [],
    providerName: config.clientId === 'acp' ? 'acp' : config.clientId,
    modelName: spawn.sessionModel ?? config.defaultModel ?? 'acp',
    sessionModel: spawn.sessionModel,
    contextBinding: {
      model: effectiveModel,
      ...((config.clientId === 'opencode' || config.clientId === 'kimi') && spawn.contextPolicy?.windowTokens
        ? { windowTokens: spawn.contextPolicy.windowTokens }
        : {}),
      source: 'service_spawn',
    },
    mcpSupport: config.mcpSupport,
    omitSessionMcpServers: dshOmitsAcpSessionMcp(acpConfig.command) || zcodeOmitsAcpSessionMcp(acpConfig.command),
    // #1186: Thread the member's configured idle TTL to AcpAgentService so
    // promptStream uses it as the authoritative no-event termination threshold.
    idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
  });
}
