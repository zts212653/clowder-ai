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
import { saveSpan } from '../../../../../../utils/member-save-diagnostics.js';
import type { AgentRegistrationFailure } from '../../registry/AgentServiceUnavailableError.js';
import { prepareOpenCodeAcpSpawnConfig } from '../opencode-acp-spawn-config.js';
import { AcpAgentService } from './AcpAgentService.js';
import { AcpClient } from './AcpClient.js';
import { AcpHttpStreamClient } from './AcpHttpStreamClient.js';
import { AcpProcessPool, DEFAULT_ACP_IDLE_TTL_MS } from './AcpProcessPool.js';
// resolveAcpMcpServers + resolveDisabledServerIds moved to AcpAgentService.invoke()
// for invoke-time resolution (#712 P1-1).
import { createAcpPoolSpawnSignature } from './acp-pool-signature.js';
import { skipAcpProfile } from './acp-registration-failure.js';
import { tryPrepareAcpProcessEnv } from './acp-spawn-env.js';
import { denyAgyAcpPermission } from './agy/agy-acp-permission.js';
import { prepareAgyAcpProfile } from './agy/agy-acp-profile.js';
import type { AgyAcpConfig } from './agy/agy-acp-session.js';
import {
  type AcpBootstrapContext,
  resolveAcpBootstrap,
  type VerifiedAcpBootstrapContext,
  verifyAcpBootstrap,
} from './bootstrap/acp-bootstrap-context.js';
import {
  type AcpServicePoolLease,
  bindAcpServicePoolLease,
  retainAcpServicePool,
  retireAcpServicePool,
} from './pool/acp-service-pool-lease.js';

export type AcpPoolRegistry = Map<string, AcpProcessPool>;

export interface CreateAcpServiceForConfigInput {
  projectRoot: string;
  profileId: string;
  config: CatConfig;
  /** Effective model resolved once by registry construction (env override included). */
  effectiveModel: string;
  acpConfig: AcpVariantConfig;
  poolRegistry: AcpPoolRegistry;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** Tests supply an owned throwaway root; production uses the platform default. */
  bootstrapRoot?: string;
  /** Carry a safe registration failure to the router while leaving this service absent. */
  onUnavailable?: (reason: AgentRegistrationFailure) => void;
}

interface AcpAccountContext {
  accountRef?: string;
  account: RuntimeProviderProfile | null;
}

interface AcpSpawnContext {
  antigravity?: AgyAcpConfig;
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

function resolveAcpAccount(projectRoot: string, config: CatConfig): AcpAccountContext {
  if (config.configurationSource === 'native_tool' && !config.accountRef) return { account: null };
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
  if (config.agyProfile?.carrier === 'acp') {
    try {
      if (
        config.clientId !== 'google' ||
        input.acpConfig.transport === 'httpstream' ||
        (accountContext.account &&
          (accountContext.account.authType !== 'oauth' || Object.keys(accountContext.account.envVars ?? {}).length))
      ) {
        throw new Error('AGY official ACP requires Google personal OAuth over stdio without account overrides');
      }
      const prepared = await prepareAgyAcpProfile({
        catId,
        model: input.effectiveModel,
        projectRoot: bootstrap.projectRoot,
        profile: config.agyProfile,
      });
      return { ...prepared, sessionModel: input.effectiveModel, openCodeRuntimeConfig: null, contextPolicy: null };
    } catch (err) {
      return skipAcpProfile(
        input,
        'invalid-spawn-env',
        { err, catId, profileId, accountRef: accountContext.accountRef },
        'ACP registry sync skipped member due to invalid AGY profile',
      );
    }
  }
  const acpEnvResult = tryPrepareAcpProcessEnv({
    clientId: config.clientId,
    provider: config.provider,
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
  let acpSpawnEnv: Record<string, string> | undefined = acpEnvResult.env;

  let openCodeAcpSpawnConfig: Awaited<ReturnType<typeof prepareOpenCodeAcpSpawnConfig>>;
  const contextPolicy = resolveAcpContextPolicy(config, input.effectiveModel);
  if (config.clientId === 'kimi' && contextPolicy?.windowTokens) {
    // kimi-code's ACP server creates sessions through the same KimiCLI.create()
    // path as the CLI. KIMI_MODEL_MAX_CONTEXT_SIZE is its supported model-window
    // override, so keep the member policy process-scoped instead of mutating the
    // user's shared ~/.kimi-code/config.toml.
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
  bootstrap: VerifiedAcpBootstrapContext,
  spawn: AcpSpawnContext,
): Promise<{ pool: AcpProcessPool; lease: AcpServicePoolLease }> {
  const { profileId, acpConfig, poolRegistry } = input;
  const spawnSignature = createAcpPoolSpawnSignature({
    command: bootstrap.command,
    args: bootstrap.args,
    cwd: bootstrap.cwd,
    bootstrapIsolation: bootstrap.isolation,
    env: spawn.env ?? null,
    openCodeRuntimeConfig: spawn.openCodeRuntimeConfig,
    contextPolicy: spawn.contextPolicy,
    maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
    idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
    transport: acpConfig.transport ?? 'stdio',
    supportsMultiplexing: acpConfig.supportsMultiplexing,
    ...(spawn.antigravity ? { sessionPolicy: { provider: 'antigravity', profile: spawn.antigravity.profile } } : {}),
  });

  const existingPool = poolRegistry.get(profileId);
  if (existingPool && existingPool.spawnSignature !== spawnSignature) {
    await retireAcpServicePool(existingPool, () => existingPool.retireWhenIdle());
    poolRegistry.delete(profileId);
  }

  const activePool = poolRegistry.get(profileId);
  if (activePool) return { pool: activePool, lease: retainAcpServicePool(poolRegistry, profileId, activePool, false) };

  const pool = new AcpProcessPool(
    {
      maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
      idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
      healthCheckIntervalMs: 30_000,
    },
    spawn.antigravity ? { ...acpConfig, supportsMultiplexing: false, rejectActiveSessionLease: true } : acpConfig,
    () => {
      const clientCfg = {
        command: bootstrap.command,
        args: bootstrap.args,
        // Cold starts must recreate a lost cwd and revalidate its permissions.
        // Existing live processes keep their cwd and drain under pool policy.
        cwd: bootstrap.verifyCwd(),
        ...(process.platform === 'win32' ? { verifyBootstrapCwd: bootstrap.verifyCwd } : {}),
        ...(spawn.env ? { env: spawn.env } : {}),
        ...(spawn.antigravity
          ? { inheritParentEnv: false, permissionHandler: denyAgyAcpPermission, antigravityDiagnostics: true }
          : {}),
      };
      return acpConfig.transport === 'httpstream' ? new AcpHttpStreamClient(clientCfg) : new AcpClient(clientCfg);
    },
    spawnSignature,
  );
  poolRegistry.set(profileId, pool);
  return { pool, lease: retainAcpServicePool(poolRegistry, profileId, pool, true) };
}

export async function createAcpServiceForConfig(
  input: CreateAcpServiceForConfigInput,
): Promise<(AcpAgentService & { disposeHostService(): Promise<void> }) | null> {
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

  const bootstrap = resolveAcpBootstrap(projectRoot, profileId, acpConfig, effectiveModel);
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
      error.message,
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
  const spawn = await saveSpan('acp.prepare', () => prepareAcpSpawnContext(effectiveInput, bootstrap, accountContext));
  if (!spawn) return null;
  const root = input.bootstrapRoot ?? acpConfig.bootstrapRoot;
  const verified = verifyAcpBootstrap(bootstrap, profileId, root, spawn.env, acpConfig.bootstrapRoot !== undefined);
  const { pool, lease } = await saveSpan('acp.pool', () => ensureAcpPool(effectiveInput, verified, spawn));

  // #712 P1-1: pass whitelist — MCP resolution happens at invoke time in
  // AcpAgentService so capability toggles take effect without registry rebuild.
  return bindAcpServicePoolLease(
    new AcpAgentService({
      ...(spawn.antigravity ? { antigravity: spawn.antigravity, agentBusyRetryDelaysMs: [] } : {}),
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
      // #1186: Thread the member's configured idle TTL to AcpAgentService so
      // promptStream uses it as the authoritative no-event termination threshold.
      idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
    }),
    lease,
  );
}
