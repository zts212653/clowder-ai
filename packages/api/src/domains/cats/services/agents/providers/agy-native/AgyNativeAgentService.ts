import { resolve } from 'node:path';
import type { AgyProfileConfig, CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { spawnCli } from '../../../../../../utils/cli-spawn.js';
import { CliRawArchive } from '../../../session/CliRawArchive.js';
import type {
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  ProviderCompactionObservation,
  ProviderContinuityPreflight,
  ToolExecutionPolicy,
} from '../../../types.js';
import { type RawArchiveSink, sanitizeRawEvent } from '../codex-audit-hooks.js';
import { compileL0ViaSubprocess } from '../l0-compiler.js';
import { createAgyNativeContinuityInput } from './agy-native-continuity.js';
import { AgyNativeResumeMismatchError, AgyNativeStartupError } from './agy-native-errors.js';
import { prepareAgyNativeLaunch } from './agy-native-launch.js';
import { preflightAgyNativeWorkspace } from './agy-native-policy.js';
import { AgyNativeProfileBusyError } from './agy-native-profile-turn.js';
import { AgyNativeProgress } from './agy-native-progress.js';
import { type AgyNativeObservedTurn, observeAgyNativeTurn, projectAgyNativeTurn } from './agy-native-turn.js';

export interface AgyNativeAgentServiceConfig {
  readonly catId: CatId;
  readonly profile: AgyProfileConfig;
  readonly command?: string;
  readonly l0CompilerFn?: typeof compileL0ViaSubprocess;
  readonly rawArchive?: RawArchiveSink;
  readonly spawnCliFn?: typeof spawnCli;
}

const log = createModuleLogger('agy-native');

async function* archiveNativeStream(
  stream: AsyncIterable<unknown>,
  invocationId: string | undefined,
  archive: RawArchiveSink,
  closeInput: () => void,
) {
  for await (const event of stream) {
    if (invocationId) {
      try {
        await archive.append(invocationId, sanitizeRawEvent(event));
      } catch (error) {
        log.warn({ invocationId, error }, 'Native raw archive write failed');
      }
    }
    if (event && typeof event === 'object' && 'event' in event && event.event === 'result') closeInput();
    yield event;
  }
}

function hasUnsupportedNativeOverrides(
  model: string,
  profile: AgyProfileConfig,
  options?: AgentServiceOptions,
): boolean {
  return (
    !model ||
    !profile.enabled ||
    Boolean(options?.cliConfigArgs?.length) ||
    (options?.toolExecutionPolicy !== undefined && options.toolExecutionPolicy.mode !== 'read_only') ||
    Object.keys(options?.accountEnv ?? {}).length > 0
  );
}

/** One CLI process per turn; operator-approved native execution and separately scoped host MCP. */
export class AgyNativeAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly profile: AgyProfileConfig;
  private readonly command: string | undefined;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly rawArchive: RawArchiveSink;
  private readonly spawnCliFn: typeof spawnCli;

  constructor(config: AgyNativeAgentServiceConfig) {
    this.catId = config.catId;
    this.model = config.profile.model?.trim() ?? '';
    this.profile = config.profile;
    this.command = config.command;
    this.l0CompilerFn = config.l0CompilerFn ?? compileL0ViaSubprocess;
    this.spawnCliFn = config.spawnCliFn ?? spawnCli;
    this.rawArchive = config.rawArchive ?? new CliRawArchive();
  }

  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'read_only';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return {
      provider: 'google',
      carrier: 'agy_stream_json',
      deliverySemantics: 'queued_internal_turn',
      activeInvocationGuidance: 'unsupported',
    };
  }

  contextCapability(): import('../../../types.js').AgentContextCapability {
    return {
      provider: 'google',
      carrier: 'agy_stream_json',
      reportsRuntimeWindow: false,
      authoritativeUsage: true,
      usageTelemetry: 'available',
      nativeWindowControl: false,
      nativeCompressionControl: true,
      observesCompression: true,
      reason: 'AGY model-step input plus cached input reports current context; result usage is session cumulative',
    };
  }

  async requestNativeCompaction(
    input: Parameters<NonNullable<AgentService['requestNativeCompaction']>>[0],
  ): Promise<ProviderCompactionObservation> {
    const binding = input.nativeSessionBinding;
    if (!binding || binding.cliSessionId !== input.sessionId) throw new Error('agy_native_session_owner_unavailable');
    const metadata: MessageMetadata = { provider: 'google', model: this.model, modelVerified: false };
    let observation: ProviderCompactionObservation | undefined;
    let failed = false;
    let busy = false;
    for await (const message of this.invokeTurn(
      '/compact',
      metadata,
      {
        sessionId: input.sessionId,
        nativeSessionBinding: binding,
        requireExactResume: true,
        workingDirectory: binding.workspaceRoot,
        invocationId: input.invocationId,
        signal: AbortSignal.timeout(input.timeoutMs),
      },
      { ...(input.userId ? { userId: input.userId } : {}) },
    )) {
      if (message.contextCompaction && 'event' in message.contextCompaction) {
        observation = message.contextCompaction.event;
        await input.onObserved?.(observation);
      }
      if (message.type === 'error') {
        failed = true;
        busy ||= message.errorCode === 'AGY_NATIVE_BUSY';
      }
    }
    if (busy) throw new Error('agy_native_session_owner_unavailable');
    if (failed || !observation) throw new Error('agy_native_compaction_failed');
    return observation;
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    yield* this.invokeAndDrain(prompt, options);
  }

  async *invokeWithContinuityPreflight(
    preflight: ProviderContinuityPreflight,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage> {
    yield* this.invokeAndDrain('', options, preflight);
  }

  private async *invokeAndDrain(
    prompt: string,
    options?: AgentServiceOptions,
    preflight?: ProviderContinuityPreflight,
  ): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'google', model: this.model, modelVerified: false };
    const failure = (code: string, message: string): AgentMessage[] => [
      { type: 'error', catId: this.catId, errorCode: code, error: message, metadata, timestamp: Date.now() },
      { type: 'done', catId: this.catId, errorCode: code, metadata, timestamp: Date.now() },
    ];
    if (options?.signal?.aborted) {
      yield* failure('AGY_CANCELLED', 'AGY native turn was cancelled before launch');
      return;
    }
    let terminal: AgentMessage | undefined;
    for await (const message of this.invokeTurn(prompt, metadata, options, undefined, preflight)) {
      if (message.type === 'done') terminal = message;
      else yield message;
    }
    // Provider cleanup is complete before any terminal can release host custody.
    if (terminal) yield terminal;
  }

  private async *invokeTurn(
    prompt: string,
    metadata: MessageMetadata,
    options?: AgentServiceOptions,
    compactionControl?: { readonly userId?: string },
    preflight?: ProviderContinuityPreflight,
  ): AsyncGenerator<AgentMessage> {
    const failure = (code: string, message: string): AgentMessage[] => [
      { type: 'error', catId: this.catId, errorCode: code, error: message, metadata, timestamp: Date.now() },
      { type: 'done', catId: this.catId, errorCode: code, metadata, timestamp: Date.now() },
    ];
    let disposeCredentials: (() => void | Promise<void>) | undefined;
    try {
      if (hasUnsupportedNativeOverrides(this.model, this.profile, options)) {
        throw new Error('AGY native requires an explicit profile/model and refuses CLI or account env overrides');
      }
      if (!options?.workingDirectory) throw new Error('AGY native requires an explicit workingDirectory');
      const workspace = resolve(options.workingDirectory);
      const workspacePreflight = preflightAgyNativeWorkspace(workspace);
      if (!workspacePreflight.ok) {
        yield* failure(
          'AGY_WORKSPACE_CUSTOMIZATION',
          `AGY workspace refused (${workspacePreflight.reason}): ${workspacePreflight.path}`,
        );
        return;
      }
      const body = await this.l0CompilerFn({
        catId: this.catId as string,
        userId: compactionControl?.userId ?? options?.callbackEnv?.CAT_CAFE_USER_ID,
        projection: 'owner',
      });
      const launch = await prepareAgyNativeLaunch({
        catId: this.catId,
        model: this.model,
        profileConfig: this.profile,
        workspace,
        prompt,
        body,
        ...(compactionControl ? { controlOperation: 'compact' as const } : {}),
        ...(this.command ? { command: this.command } : {}),
        ...(options ? { options } : {}),
      });
      disposeCredentials = launch.disposeCredentials;
      const rawArchivePath = options?.invocationId ? this.rawArchive.getPath?.(options.invocationId) : undefined;
      if (rawArchivePath) metadata.diagnostics = { agyNative: { rawArchivePath } };
      const continuityInput = preflight ? createAgyNativeContinuityInput(launch, preflight, options) : undefined;
      if (!continuityInput) await options?.beforeProviderLaunch?.(launch.preparedRequest);
      const inputLifetime = new AbortController();
      const { stdinInput, ...deferredLaunchOptions } = launch.cliOptions;
      const cliOptions = {
        ...deferredLaunchOptions,
        ...(continuityInput ? { onStdinReady: continuityInput.onStdinReady } : { stdinInput }),
        stdinCloseSignal: inputLifetime.signal,
        rawArchivePath,
      };
      const stream = options?.spawnCliOverride ? options.spawnCliOverride(cliOptions) : this.spawnCliFn(cliOptions);
      const progress = new AgyNativeProgress(this.catId, metadata);
      let observed: AgyNativeObservedTurn | undefined;
      for await (const observation of observeAgyNativeTurn(
        archiveNativeStream(stream, options?.invocationId, this.rawArchive, () => inputLifetime.abort()),
        {
          agentName: launch.agentName,
          spawnCwd: launch.cliOptions.cwd,
          model: this.model,
          permissionMode: launch.permissionMode,
          command: launch.cliOptions.command,
          ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
          ...(launch.resumeSessionId ? { sessionId: launch.resumeSessionId } : {}),
        },
        options?.signal,
      )) {
        if (observation.kind === 'init') {
          await launch.bindSession(observation.sessionId);
          await continuityInput?.acceptVerifiedInit(observation.sessionId);
          metadata.sessionId = observation.sessionId;
          yield {
            type: 'session_init',
            catId: this.catId,
            sessionId: observation.sessionId,
            nativeSessionBinding: { ...launch.binding, cliSessionId: observation.sessionId },
            metadata,
            timestamp: Date.now(),
          };
        } else if (observation.kind === 'step') {
          yield* progress.step(observation.event);
        } else if (observation.kind === 'liveness') {
          log.warn(
            {
              catId: this.catId,
              invocationId: options?.invocationId,
              level: observation.warning.level,
              silenceMs: observation.warning.silenceDurationMs,
            },
            'Native AGY liveness warning',
          );
          yield {
            type: 'system_info',
            catId: this.catId,
            metadata,
            timestamp: Date.now(),
            content: JSON.stringify({ type: 'liveness_warning', ...observation.warning }),
          };
        } else observed = observation.observed;
      }
      if (!observed) throw new Error('AGY native stream ended without a terminal observation');
      const messages = projectAgyNativeTurn(
        this.catId,
        metadata,
        observed,
        observed.cancelledBeforeTerminal === true,
        launch.agentTools,
        compactionControl !== undefined,
      );
      yield* progress.final(messages);
    } catch (error) {
      const cancelled = options?.signal?.aborted === true;
      if (!cancelled && error instanceof AgyNativeStartupError && error.cliDiagnostics) {
        metadata.cliDiagnostics = error.cliDiagnostics;
      }
      yield* failure(
        cancelled
          ? 'AGY_CANCELLED'
          : error instanceof AgyNativeProfileBusyError
            ? 'AGY_NATIVE_BUSY'
            : error instanceof AgyNativeResumeMismatchError
              ? 'AGY_NATIVE_RESUME_MISMATCH'
              : 'AGY_NATIVE_PREFLIGHT',
        cancelled ? 'AGY native turn was cancelled' : error instanceof Error ? error.message : String(error),
      );
    } finally {
      await disposeCredentials?.();
    }
  }
}
