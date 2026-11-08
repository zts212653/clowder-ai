import { createHmac, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type CatConfig, defaultAcpPoolMaxProcesses } from '@cat-cafe/shared';
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
import { inspectDshNativeLaunch } from '../../../../../../config/native-accounts/dsh-installation.js';
import { inspectKimiNativeLaunch } from '../../../../../../config/native-accounts/kimi-installation.js';
import { resolveEffectiveOpenCodeModel } from '../../../../../../config/opencode-model.js';
import { invalidateCliCommand, resolveCliCommandOrBare } from '../../../../../../utils/cli-resolve.js';
import { resolveWindowsSpawnPlan, type WindowsSpawnPlan } from '../../../../../../utils/cli-spawn-win.js';
import { saveSpan } from '../../../../../../utils/member-save-diagnostics.js';
import type { AgentRegistrationFailure } from '../../registry/AgentServiceUnavailableError.js';
import { ExecutionAdmissionConflict, StaleServiceSourceConflict } from '../../registry/AgentServiceUnavailableError.js';
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
import { prepareAcpProcessEnv, tryPrepareAcpProcessEnv } from './acp-spawn-env.js';
import { denyAgyAcpPermission } from './agy/agy-acp-permission.js';
import { prepareAgyAcpProfile } from './agy/agy-acp-profile.js';
import type { AgyAcpConfig } from './agy/agy-acp-session.js';
import {
  type AcpBootstrapContext,
  resolveAcpBootstrap,
  type VerifiedAcpBootstrapContext,
  verifyAcpBootstrap,
} from './bootstrap/acp-bootstrap-context.js';
import { captureAcpConstructionEnvironment } from './configuration/acp-construction-environment.js';
import {
  acpAccountConstructionSource,
  acpConstructionJson,
  acpLaunchConstructionSource,
} from './configuration/acp-construction-source.js';
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
  /** Adapter-owned outputs applied after member/account inputs. */
  fixedEnv?: Record<string, string>;
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
        Object.keys(config.env ?? {}).length > 0 ||
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
    memberEnvironment: config.env,
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
  const fixedEnv: Record<string, string> = {};
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
    fixedEnv.KIMI_MODEL_MAX_CONTEXT_SIZE = String(contextPolicy.windowTokens);
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
    Object.assign(fixedEnv, openCodeAcpSpawnConfig.env);
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
    fixedEnv,
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
  construction: unknown,
): Promise<{ pool: AcpProcessPool; lease: AcpServicePoolLease }> {
  const { profileId, acpConfig, poolRegistry } = input;
  const maxLiveProcesses = acpConfig.pool?.maxLiveProcesses ?? defaultAcpPoolMaxProcesses(input.config.clientId);
  const spawnSignature = createAcpPoolSpawnSignature({
    command: preparedSpawn.command,
    args: [...preparedSpawn.args],
    ...(preparedSpawn.shell !== undefined ? { shell: preparedSpawn.shell } : {}),
    cwd: bootstrap.cwd,
    bootstrapIsolation: bootstrap.isolation,
    environmentFingerprint: createHmac('sha256', environmentFingerprintKey)
      .update(acpConstructionJson(construction))
      .digest('hex'),
    openCodeRuntimeConfig: spawn.openCodeRuntimeConfig,
    contextPolicy: spawn.contextPolicy,
    maxLiveProcesses,
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
      maxLiveProcesses,
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
        defaultPermissionDecision:
          acpConfig.protocolAdapter === 'icode' || acpConfig.permissionPolicy === 'deny'
            ? ('reject' as const)
            : ('allow' as const),
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
  const accountConstruction = acpAccountConstructionSource(config, bootstrap.model, accountSource);
  const spawn = await saveSpan('acp.prepare', () => prepareAcpSpawnContext(effectiveInput, bootstrap, accountContext));
  if (!spawn) return null;
  bootstrap.args = piBridgeStorageArgs(
    bootstrap.command,
    bootstrap.args,
    [bootstrap.projectRoot, catId, profileId, accountContext.accountRef ?? 'native-profile'],
    { ...process.env, ...spawn.env },
  );
  const originalArgs = bootstrap.args;
  const nativeDsh = inspectDshNativeLaunch({
    command: bootstrap.command,
    args: originalArgs,
    env: spawn.env ?? {},
    projectRoot: bootstrap.projectRoot,
  });
  bootstrap.args = await prepareDshSecretPatch(
    bootstrap.command,
    originalArgs,
    bootstrap.projectRoot,
    spawn.sessionModel,
  );
  const nativeKimi =
    config.clientId === 'kimi' && accountContext.account?.id && acpConfig.transport !== 'httpstream'
      ? inspectKimiNativeLaunch({
          command: bootstrap.command,
          args: originalArgs,
          env: {},
          projectRoot: bootstrap.projectRoot,
          accountRef: accountContext.account.id,
        })
      : null;
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
  const environment = captureAcpConstructionEnvironment({
    clientId,
    workingDirectory: verified.cwd,
    declaredEnv: spawn.env,
    inheritParentEnv: !spawn.antigravity,
    overrides: () =>
      spawn.antigravity
        ? spawn.env
        : {
            ...prepareAcpProcessEnv({
              clientId,
              provider: config.provider,
              baseModel: bootstrap.model,
              account: accountSource.account,
              memberEnvironment: config.env,
            }),
            ...spawn.fixedEnv,
          },
    onChanged(changed) {
      input.log.warn(
        {
          catId,
          profileId,
          changedEnvironmentKeys: changed.filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)).slice(0, 16),
          changedEnvironmentKeyCount: changed.length,
        },
        'ACP process environment changed before admission',
      );
      throw new StaleServiceSourceConflict('ACP process environment changed; refresh this member before admission.');
    },
  });
  const preparedEnv = environment.preparedEnv;
  const construction = { account: accountConstruction, environment: environment.projection };
  const assertConstructionCurrent = () => {
    if (
      resolveCurrentAcpConfig &&
      !isDeepStrictEqual(acpLaunchConstructionSource(acpConfig), acpLaunchConstructionSource(resolveCurrentAcpConfig()))
    )
      throw new StaleServiceSourceConflict('ACP launch source changed; refresh this member before admission.');
    if (
      !isDeepStrictEqual(
        accountConstruction,
        acpAccountConstructionSource(config, bootstrap.model, resolveAcpAccount(bootstrap.projectRoot, config)),
      )
    )
      throw new StaleServiceSourceConflict('ACP account source changed; refresh this member before admission.');
    environment.assertCurrent();
  };
  const { pool, lease } = await saveSpan('acp.pool', () =>
    ensureAcpPool(effectiveInput, verified, spawn, preparedEnv, preparedSpawn, construction),
  );

  // #712 P1-1: pass whitelist — MCP resolution happens at invoke time in
  // AcpAgentService so capability toggles take effect without registry rebuild.
  const service = new AcpAgentService({
    ...(nativeDsh ? { nativeDsh } : {}),
    ...(nativeKimi ? { nativeKimi } : {}),
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
    executionApproval: config.executionApproval ?? 'auto',
    defaultPermissionDecision:
      acpConfig.protocolAdapter === 'icode' || acpConfig.permissionPolicy === 'deny' ? 'reject' : 'allow',
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
      throw new StaleServiceSourceConflict('ACP selected account changed; refresh this member before admission.');
    assertConstructionCurrent();
    const sessionSource = resolveCurrentAcpConfig ? resolveCurrentAcpConfig() : acpConfig;
    const sessionWhitelist = [...(sessionSource?.mcpWhitelist ?? [])];
    const captured = await captureOptions({
      ...options,
      mcpWhitelist: sessionWhitelist,
    });
    assertConstructionCurrent();
    const latestSessionSource = resolveCurrentAcpConfig ? resolveCurrentAcpConfig() : acpConfig;
    if (
      (options.mcpSupport ?? config.mcpSupport) !== false &&
      !isDeepStrictEqual(sessionWhitelist, latestSessionSource?.mcpWhitelist ?? [])
    )
      throw new ExecutionAdmissionConflict(
        'ACP session configuration changed during admission; retry this invocation.',
      );
    return captured;
  };
  return bindAcpServicePoolLease(service, lease);
}
