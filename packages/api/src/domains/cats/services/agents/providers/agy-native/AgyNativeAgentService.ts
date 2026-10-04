import { resolve } from 'node:path';
import type { AgyProfileConfig, CatId } from '@cat-cafe/shared';
import { spawnCli } from '../../../../../../utils/cli-spawn.js';
import type { PreparedIdleFreshnessNotice } from '../../../freshness/FreshnessNoticeBroker.js';
import type {
  AgentFreshnessCarrierCapability,
  AgentMessage,
  AgentService,
  AgentServiceOptions,
  MessageMetadata,
  ToolExecutionPolicy,
} from '../../../types.js';
import { compileL0ViaSubprocess } from '../l0-compiler.js';
import { type AgyNativeSessionBinding, prepareAgyNativeLaunch } from './agy-native-launch.js';
import { preflightAgyNativeWorkspace } from './agy-native-policy.js';
import { projectAgyNativeTurn, readAgyNativeTurn } from './agy-native-turn.js';

export interface AgyNativeAgentServiceConfig {
  readonly catId: CatId;
  readonly profile: AgyProfileConfig;
  readonly command?: string;
  readonly l0CompilerFn?: typeof compileL0ViaSubprocess;
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
    Object.keys(options?.accountEnv ?? {}).length > 0
  );
}

function rememberSuccessfulSession(
  sessions: Map<string, AgyNativeSessionBinding>,
  sessionId: string,
  binding: AgyNativeSessionBinding,
  messages: readonly AgentMessage[],
): void {
  const terminal = messages.at(-1);
  if (terminal?.type === 'done' && !terminal.errorCode) sessions.set(sessionId, binding);
}

/** One CLI process per turn; no native shell or unvalidated MCP process is exposed. */
export class AgyNativeAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly profile: AgyProfileConfig;
  private readonly command: string | undefined;
  private readonly l0CompilerFn: typeof compileL0ViaSubprocess;
  private readonly sessions = new Map<string, AgyNativeSessionBinding>();
  private activeTurn: { readonly signal?: AbortSignal; readonly settled: Promise<void> } | null = null;

  constructor(config: AgyNativeAgentServiceConfig) {
    this.catId = config.catId;
    this.model = config.profile.model?.trim() ?? '';
    this.profile = config.profile;
    this.command = config.command;
    this.l0CompilerFn = config.l0CompilerFn ?? compileL0ViaSubprocess;
  }

  injectsL0Natively(): boolean {
    return true;
  }

  supportsToolExecutionPolicy(policy: ToolExecutionPolicy): boolean {
    return policy.mode === 'callback_allowlist' || policy.mode === 'read_only';
  }

  freshnessCarrierCapability(): AgentFreshnessCarrierCapability {
    return { provider: 'google', carrier: 'agy_stream_json', deliverySemantics: 'queued_internal_turn' };
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'google', model: this.model, modelVerified: false };
    const previous = this.activeTurn;
    if (previous?.signal?.aborted) await previous.settled;
    const failure = (code: string, message: string): AgentMessage[] => [
      { type: 'error', catId: this.catId, errorCode: code, error: message, metadata, timestamp: Date.now() },
      { type: 'done', catId: this.catId, errorCode: code, metadata, timestamp: Date.now() },
    ];
    if (options?.signal?.aborted) {
      yield* failure('AGY_CANCELLED', 'AGY native turn was cancelled before launch');
      return;
    }
    if (this.activeTurn) {
      yield* failure('AGY_NATIVE_BUSY', 'Another turn is already using this isolated AGY profile');
      return;
    }
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.activeTurn = { ...(options?.signal ? { signal: options.signal } : {}), settled };
    let messages: AgentMessage[];
    try {
      messages = await this.invokeTurn(prompt, metadata, options);
    } finally {
      this.activeTurn = null;
      settle();
    }
    // Provider cleanup is complete before any terminal can release host custody.
    yield* messages;
  }

  private async invokeTurn(
    prompt: string,
    metadata: MessageMetadata,
    options?: AgentServiceOptions,
  ): Promise<AgentMessage[]> {
    const failure = (code: string, message: string): AgentMessage[] => [
      { type: 'error', catId: this.catId, errorCode: code, error: message, metadata, timestamp: Date.now() },
      { type: 'done', catId: this.catId, errorCode: code, metadata, timestamp: Date.now() },
    ];
    let disposeCredentials: (() => void) | undefined;
    const idleFreshness = options?.activeInvocationFreshness?.idle;
    let preparedNotice: PreparedIdleFreshnessNotice | null = null;
    try {
      if (hasUnsupportedNativeOverrides(this.model, this.profile, options)) {
        throw new Error('AGY native requires an explicit profile/model and refuses CLI or account env overrides');
      }
      if (!options?.workingDirectory) throw new Error('AGY native requires an explicit workingDirectory');
      const workspace = resolve(options.workingDirectory);
      const preflight = preflightAgyNativeWorkspace(workspace);
      if (!preflight.ok) {
        const code =
          preflight.reason === 'workspace_sensitive_content'
            ? 'AGY_WORKSPACE_SENSITIVE_CONTENT'
            : 'AGY_WORKSPACE_CUSTOMIZATION';
        return failure(code, `AGY workspace refused (${preflight.reason}): ${preflight.path}`);
      }
      const prior = options?.sessionId ? this.sessions.get(options.sessionId) : undefined;
      const body = await this.l0CompilerFn({
        catId: this.catId as string,
        userId: options?.callbackEnv?.CAT_CAFE_USER_ID,
        projection: options?.toolExecutionPolicy?.mode === 'collective_participation' ? 'public' : 'owner',
      });
      if (options?.agyNativeScope?.mcpTools.includes('cat-cafe-collab/cat_cafe_get_thread_context')) {
        preparedNotice = (await idleFreshness?.prepare()) ?? null;
      }
      const turnPrompt = preparedNotice ? `${prompt}\n\n${preparedNotice.text}` : prompt;
      const launch = prepareAgyNativeLaunch({
        catId: this.catId,
        model: this.model,
        profileConfig: this.profile,
        workspace,
        prompt: turnPrompt,
        body,
        ...(prior ? { prior } : {}),
        ...(this.command ? { command: this.command } : {}),
        ...(options ? { options } : {}),
      });
      disposeCredentials = launch.disposeCredentials;
      await options?.beforeProviderLaunch?.(launch.preparedRequest);
      const stream = options?.spawnCliOverride
        ? options.spawnCliOverride(launch.cliOptions)
        : spawnCli(launch.cliOptions);
      const observed = await readAgyNativeTurn(
        stream,
        {
          agentName: launch.agentName,
          spawnCwd: launch.cliOptions.cwd,
          model: this.model,
        },
        options?.signal,
      );
      const messages = projectAgyNativeTurn(
        this.catId,
        metadata,
        observed,
        observed.cancelledBeforeTerminal === true,
        launch.grantedMcpTools,
      );
      if (preparedNotice) {
        const terminal = messages.at(-1);
        if (terminal?.type === 'done' && !terminal.errorCode) {
          await idleFreshness?.commitDelivered(preparedNotice, { acceptedTurnId: observed.sessionId });
        } else {
          idleFreshness?.defer(preparedNotice);
        }
        preparedNotice = null;
      }
      rememberSuccessfulSession(this.sessions, observed.sessionId, launch.binding, messages);
      return messages;
    } catch (error) {
      if (preparedNotice) idleFreshness?.defer(preparedNotice);
      const cancelledWithoutInit =
        options?.signal?.aborted === true &&
        error instanceof Error &&
        error.message === 'AGY native stream ended without a verified init';
      return failure(
        cancelledWithoutInit ? 'AGY_CANCELLED' : 'AGY_NATIVE_PREFLIGHT',
        cancelledWithoutInit
          ? 'AGY native turn was cancelled before init'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      disposeCredentials?.();
    }
  }
}
