import { createHmac, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import {
  resolveBoundAccountRefForCat,
  usesNativeToolConfiguration,
} from '../../../../../../config/cat-account-binding.js';
import type { AcpVariantConfig } from '../../../../../../config/cat-config-loader.js';
import { resolveContextCapacity } from '../../../../../../config/context-capacity.js';
import { resolveEffectiveOpenCodeModel } from '../../../../../../config/opencode-model.js';
import { invalidateCliCommand, resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { buildChildEnv } from '../../../../../../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan, type WindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import { saveSpan } from '../../../../../../utils/member-save-diagnostics.js';
import type { AgentRegistrationFailure } from '../../registry/AgentServiceUnavailableError.js';
import { ExecutionAdmissionConflict } from '../../registry/AgentServiceUnavailableError.js';
import { prepareDshSecretPatch, verifyDshSecretPatch } from '../dsh-secret-patch.js';
import { ensureKimiSecretHooks } from '../kimi-secret-hooks.js';
import { prepareOpenCodeAcpSpawnConfig } from '../opencode-acp-spawn-config.js';
import { piBridgeStorageArgs } from '../pi/pi-bridge-launch.js';
import { AcpAgentService } from './AcpAgentService.js';
import { AcpClient, type AcpClientConfig } from './AcpClient.js';
import { AcpHttpStreamClient } from './AcpHttpStreamClient.js';
import { AcpProcessPool, DEFAULT_ACP_IDLE_TTL_MS } from './AcpProcessPool.js';
// resolveAcpMcpServers + resolveDisabledServerIds moved to AcpAgentService.invoke()
// for invoke-time resolution (#712 P1-1).
import { createAcpPoolSpawnSignature } from './acp-pool-signature.js';
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
import { skipAcpProfile } from './lifecycle/acp-registration-failure.js';
import { pendingAcpPoolRetirement, trackAcpPoolRetirement } from './pool/acp-pool-retirement-registry.js';
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
  /** Catalog construction uses its existing accessor; plugin sources retain their registration fence. */
  resolveCurrentAcpConfig?(): AcpVariantConfig | undefined;
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
// Process-local pool identity: neither raw inherited credentials nor a guessable
// secret hash belongs in diagnostic objects or persistent session compatibility.
const environmentFingerprintKey = randomBytes(32);

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
  if (usesNativeToolConfiguration(config)) return { account: null };
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
  if (config.clientId === 'kimi') await ensureKimiSecretHooks(acpSpawnEnv ?? {});

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
  preparedEnv: Readonly<Record<string, string>>,
  preparedSpawn: NonNullable<AcpClientConfig['preparedSpawn']>,
): Promise<{ pool: AcpProcessPool; lease: AcpServicePoolLease }> {
  const { profileId, acpConfig, poolRegistry } = input;
  const spawnSignature = createAcpPoolSpawnSignature({
    command: preparedSpawn.command,
    args: [...preparedSpawn.args],
    ...(preparedSpawn.shell !== undefined ? { shell: preparedSpawn.shell } : {}),
    cwd: bootstrap.cwd,
    bootstrapIsolation: bootstrap.isolation,
    environmentFingerprint: createHmac('sha256', environmentFingerprintKey)
      .update(JSON.stringify(preparedEnv))
      .digest('hex'),
    openCodeRuntimeConfig: spawn.openCodeRuntimeConfig,
    contextPolicy: spawn.contextPolicy,
    maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
    idleTtlMs: acpConfig.pool?.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS,
    transport: acpConfig.transport ?? 'stdio',
    supportsMultiplexing: acpConfig.supportsMultiplexing,
    protocolAdapter: acpConfig.protocolAdapter,
    permissionPolicy: acpConfig.permissionPolicy,
    ...(spawn.antigravity ? { sessionPolicy: { provider: 'antigravity', profile: spawn.antigravity.profile } } : {}),
  });

  const existingPool = poolRegistry.get(profileId);
  if (existingPool && existingPool.spawnSignature !== spawnSignature) {
    const retirement = retireAcpServicePool(existingPool, () => existingPool.retireWhenIdle());
    trackAcpPoolRetirement(poolRegistry, profileId, retirement.completion);
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
        cwd: bootstrap.verifyCwd(preparedSpawn.command, [...preparedSpawn.args], preparedEnv),
        preparedEnv,
        preparedSpawn,
        ...(process.platform === 'win32' ? { verifyBootstrapCwd: bootstrap.verifyCwd } : {}),
        ...(spawn.env ? { env: spawn.env } : {}),
        // iCode fail-closed policy: flagged native effects must never be
        // auto-approved by the generic default (allow) path.
        ...(acpConfig.protocolAdapter === 'icode' || acpConfig.permissionPolicy === 'deny'
          ? { defaultPermissionDecision: 'reject' as const }
          : acpConfig.permissionPolicy === 'auto_allow'
            ? { defaultPermissionDecision: 'allow' as const }
            : {}),
        ...(spawn.antigravity
          ? { inheritParentEnv: false, permissionHandler: denyAgyAcpPermission, antigravityDiagnostics: true }
          : {}),
      };
      return acpConfig.transport === 'httpstream' ? new AcpHttpStreamClient(clientCfg) : new AcpClient(clientCfg);
    },
    spawnSignature,
    pendingAcpPoolRetirement(poolRegistry, profileId),
  );
  poolRegistry.set(profileId, pool);
  return { pool, lease: retainAcpServicePool(poolRegistry, profileId, pool, true) };
}

export async function createAcpServiceForConfig(
  input: CreateAcpServiceForConfigInput,
): Promise<(AcpAgentService & { disposeHostService(): Promise<void> }) | null> {
  const { projectRoot, profileId, resolveCurrentAcpConfig } = input;
  const config = structuredClone(input.config);
  const acpConfig = structuredClone(input.acpConfig);
  const catId = config.id;
  const clientId = config.clientId;
  const effectiveModel =
    config.clientId === 'opencode'
      ? (resolveEffectiveOpenCodeModel(config.provider, input.effectiveModel)?.model ?? input.effectiveModel)
      : input.effectiveModel;
  const effectiveInput = { ...input, config, acpConfig, effectiveModel };

  if (acpConfig.transport === 'httpstream' && acpConfig.experimental !== true) {
    return skipAcpProfile(
      input,
      'httpstream-missing-experimental-opt-in',
      { catId, profileId },
      'ACP registry sync skipped member because httpstream transport requires experimental opt-in',
    );
  }

  if (acpConfig.protocolAdapter === 'icode' && acpConfig.transport === 'httpstream') {
    return skipAcpProfile(
      input,
      'icode-requires-stdio',
      { catId, profileId, transport: acpConfig.transport },
      'ACP registry sync skipped iCode member because the icode adapter requires stdio transport',
    );
  }

  const icodeModelProfileId = acpConfig.protocolAdapter === 'icode' ? acpConfig.modelProfileId?.trim() : undefined;
  if (acpConfig.protocolAdapter === 'icode' && !icodeModelProfileId) {
    // Display model (defaultModel/effectiveModel) is not an iCode model profile
    // id. Falling back to it would either fail on session/set_model or leave the
    // provider on its own default while the thread shows a different model.
    return skipAcpProfile(
      input,
      'icode-missing-model-profile',
      { catId, profileId },
      'ACP registry sync skipped iCode member because modelProfileId is required',
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
  const accountSource = structuredClone(accountContext);
  const spawn = await saveSpan('acp.prepare', () => prepareAcpSpawnContext(effectiveInput, bootstrap, accountContext));
  if (!spawn) return null;
  bootstrap.args = piBridgeStorageArgs(
    bootstrap.command,
    bootstrap.args,
    [bootstrap.projectRoot, catId, profileId, accountContext.accountRef ?? 'native-profile'],
    { ...process.env, ...spawn.env },
  );
  const originalArgs = bootstrap.args;
  bootstrap.args = await prepareDshSecretPatch(bootstrap.command, originalArgs, bootstrap.projectRoot);
  // Audit and execution consume one fresh plan, rather than separate cache generations.
  invalidateCliCommand(bootstrap.command);
  const selectedCommand = resolveCliCommandOrBare(bootstrap.command);
  const selected: Pick<WindowsSpawnPlan, 'command' | 'args' | 'shell'> =
    process.platform === 'win32'
      ? resolveWindowsSpawnPlan(selectedCommand, bootstrap.args, { refresh: true })
      : { command: selectedCommand, args: [...bootstrap.args] };
  let shell = selected.shell;
  if (shell === true) {
    const command = process.env.ComSpec || 'cmd.exe';
    if (!isAbsolute(command)) invalidateCliCommand(command);
    shell = isAbsolute(command) ? command : resolveCliCommandOrBare(command);
  }
  const preparedSpawn = Object.freeze({
    command: selected.command,
    args: Object.freeze([...selected.args]),
    ...(shell !== undefined ? { shell } : {}),
  });
  const root = input.bootstrapRoot ?? acpConfig.bootstrapRoot;
  const verified = verifyAcpBootstrap(
    bootstrap,
    profileId,
    root,
    spawn.env,
    acpConfig.bootstrapRoot !== undefined,
    preparedSpawn,
  );
  if (bootstrap.args !== originalArgs) {
    const patch = bootstrap.args.at(-1);
    if (!patch) throw new Error('secret_dsh_patch_unavailable');
    const verifyCwd = verified.verifyCwd;
    verified.verifyCwd = (...args) => {
      if (!verifyDshSecretPatch(patch)) throw new Error('secret_dsh_patch_changed');
      return verifyCwd(...args);
    };
  }
  const prepareEnvironment = () =>
    Object.fromEntries(
      Object.entries(
        buildChildEnv(spawn.env, {
          workingDirectory: verified.cwd,
          ...(spawn.antigravity ? { inheritParentEnv: false } : {}),
        }),
      )
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const preparedEnv = Object.freeze(prepareEnvironment());
  const assertConstructionCurrent = () => {
    if (resolveCurrentAcpConfig && !isDeepStrictEqual(acpConfig, resolveCurrentAcpConfig()))
      throw new ExecutionAdmissionConflict('ACP launch source changed; refresh this member before admission.');
    if (!isDeepStrictEqual(accountSource, resolveAcpAccount(bootstrap.projectRoot, config)))
      throw new ExecutionAdmissionConflict('ACP account source changed; refresh this member before admission.');
    if (!isDeepStrictEqual(preparedEnv, prepareEnvironment()))
      throw new ExecutionAdmissionConflict('ACP process environment changed; refresh this member before admission.');
  };
  const { pool, lease } = await saveSpan('acp.pool', () =>
    ensureAcpPool(effectiveInput, verified, spawn, preparedEnv, preparedSpawn),
  );

  // #712 P1-1: pass whitelist — MCP resolution happens at invoke time in
  // AcpAgentService so capability toggles take effect without registry rebuild.
  const service = new AcpAgentService({
    ...(spawn.antigravity ? { antigravity: spawn.antigravity, agentBusyRetryDelaysMs: [] } : {}),
    catId,
    pool,
    clientId,
    poolKey: bootstrap.poolKey,
    projectRoot: bootstrap.projectRoot,
    mcpWhitelist: acpConfig.mcpWhitelist ?? [],
    providerName: config.clientId === 'acp' ? 'acp' : config.clientId,
    modelName: spawn.sessionModel ?? config.defaultModel ?? 'acp',
    // iCode: modelProfileId is the session/set_model target (iCode model
    // configuration id), distinct from defaultModel (display/audit model name).
    // The factory rejects iCode members without it, so this is always defined.
    sessionModel: acpConfig.protocolAdapter === 'icode' ? icodeModelProfileId : spawn.sessionModel,
    protocolAdapter: acpConfig.protocolAdapter,
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
  });
  const captureOptions = service.captureInvocationOptions.bind(service);
  service.captureInvocationOptions = async (options) => {
    if ('accountRef' in options && options.accountRef !== accountSource.account?.id)
      throw new ExecutionAdmissionConflict('ACP selected account changed; refresh this member before admission.');
    assertConstructionCurrent();
    const captured = await captureOptions(options);
    assertConstructionCurrent();
    return captured;
  };
  return bindAcpServicePoolLease(service, lease);
}
