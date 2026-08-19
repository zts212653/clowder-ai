/**
 * AcpAgentService — Generic AgentService implementation backed by ACP protocol.
 *
 * F161: Renamed from GeminiAcpAdapter. Provider-agnostic — works with any CLI
 * that speaks ACP (gemini --acp, opencode acp, etc.).
 *
 * Phase C (F149): Acquires a client lease from AcpProcessPool per invocation.
 * Pool handles lifecycle (spawn, init, idle TTL, eviction, zombie cleanup).
 *
 * Key behaviors:
 *   - Pool-backed: each invoke() acquires lease, releases in finally
 *   - Session reuse: if options.sessionId is provided (from session chain), reuse
 *     the existing ACP session for multi-turn memory. Falls back to newSession()
 *     if the session is gone (process restarted, evicted, etc.).
 *   - 4-window abort coverage (pre-invoke, post-newSession, post-yield, during-prompt)
 *   - Failure classification: init_failure / prompt_failure / model_capacity / mcp_pollution / stream_idle_stall / turn_budget_exceeded
 *   - System prompt: prepended to prompt text (ACP agents have no system prompt flag)
 */

import type { CapabilitiesConfig, CatId } from '@cat-cafe/shared';
import { readCapabilitiesConfig } from '../../../../../../config/capabilities/capability-orchestrator.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { createPromptDigest } from '../../../context/prompt-digest.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import {
  ACP_PROMPT_TIMEOUT_MARGIN_MS,
  type AcpCapacitySignal,
  AcpProtocolError,
  AcpStreamIdleError,
  AcpTimeoutError,
} from './AcpClient.js';
import { type AcpLease, type AcpProcessPool, DEFAULT_ACP_IDLE_TTL_MS, type PoolKey } from './AcpProcessPool.js';
import {
  bindSessionCredentialFile,
  type PreparedCredentialEnv,
  prepareSessionCredentialFile,
  resolveSessionCredentialFile,
  writeSessionCredentialFile,
} from './acp-credential-file.js';
import { createAcpSessionState, flushAcpThinking, transformAcpEvent } from './acp-event-transformer.js';
import { resolveAcpMcpServers, resolveDisabledServerIds, resolveUserProjectMcpServers } from './acp-mcp-resolver.js';
import { callbackEnvDiagnostic, materializeSessionMcpServers } from './acp-session-env.js';
import type { AcpMcpServer, AcpNewSessionResult, AcpSessionUpdate } from './types.js';

const log = createModuleLogger('acp-agent');

/**
 * turn.agent_busy: the ACP agent (e.g. kimi) rejected session/prompt because an
 * internally-launched turn (background-task completion steer, goal continuation)
 * still occupies the session's single-turn slot. The harness cannot see these
 * internal turns, so the rejection arrives as -32600 with zero prior events.
 * Such turns are usually short — retry with bounded backoff instead of failing
 * the invocation outright. Retry is only safe because the rejected prompt never
 * started a turn (zero events yielded).
 */
const DEFAULT_AGENT_BUSY_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/** Structural surface needed by the busy-retry wrapper (AcpClient-compatible). */
interface PromptStreamClient {
  promptStream(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
  ): AsyncGenerator<AcpSessionUpdate>;
}

function isAgentBusyError(err: unknown): boolean {
  if (!(err instanceof AcpProtocolError)) return false;
  const data = err.data;
  if (typeof data === 'object' && data !== null && (data as Record<string, unknown>).code === 'turn.agent_busy') {
    return true;
  }
  return /turn\.agent_busy|another turn.*is active/i.test(err.message);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type ResumeDisposition = 'fresh_without_resume' | 'resume_requested' | 'resumed' | 'load_failed_fresh' | 'sealed_fresh';

type PromptPhase =
  | 'not_started'
  | 'active_unacknowledged'
  | 'provider_acknowledged'
  | 'locally_terminated_unacknowledged'
  /**
   * Busy-retry backoff: NO harness session/prompt is in flight — the agent is
   * running one of its own internal turns. Abort in this window must NOT send
   * session/cancel or seal the session: that would kill the agent-internal
   * turn this retry is deliberately waiting out.
   */
  | 'busy_backoff';

export interface AcpAgentServiceConfig {
  catId: CatId;
  pool: AcpProcessPool;
  poolKey: PoolKey;
  /** Project root (monorepo root) — used as default session cwd */
  projectRoot: string;
  /**
   * MCP whitelist from ACP variant config. When set, MCP servers are resolved
   * at invoke time from capabilities.json (not frozen at construction time).
   * This ensures capability toggles take effect without registry rebuild.
   */
  mcpWhitelist?: string[];
  /** @deprecated Pre-resolved MCP servers. Prefer mcpWhitelist for invoke-time resolution. */
  mcpServers?: AcpMcpServer[];
  /** Provider name for metadata (e.g. 'google', 'opencode'). Defaults to 'acp'. */
  providerName?: string;
  /** Model name for metadata. Defaults to 'acp'. */
  modelName?: string;
  /** ACP session model override sent via session/set_config_option when the agent exposes model selection. */
  sessionModel?: string;
  /** #1208: model/window already applied to this process-pool generation. */
  contextBinding?: import('../../../types.js').AgentContextBinding;
  /** When false, disables ALL MCP servers (base + per-project) for this member. */
  mcpSupport?: boolean;
  /**
   * #1186: Configured ACP Idle TTL from member's pool config (ms).
   * Used as the authoritative idle stall threshold for all "no events" termination
   * paths in promptStream (both tool and non-tool idle). Previously, hardcoded
   * constants (90s stall, 180s tool ceiling) overrode the user's configured value.
   */
  idleTtlMs?: number;
  /**
   * turn.agent_busy retry backoff delays (ms). Each entry is one retry wait after
   * a zero-event busy rejection; exhaustion surfaces the error as `agent_busy`.
   * Defaults to DEFAULT_AGENT_BUSY_RETRY_DELAYS_MS (~2min total window, covering
   * typical agent-internal turns like background-task completion steers).
   */
  agentBusyRetryDelaysMs?: number[];
}

/** @deprecated Use AcpAgentServiceConfig. Kept for backward compat during transition. */
export type GeminiAcpAdapterConfig = AcpAgentServiceConfig;

export class AcpAgentService implements AgentService {
  readonly catId: CatId;
  private readonly pool: AcpProcessPool;
  private readonly poolKey: PoolKey;
  private readonly projectRoot: string;
  /** Invoke-time whitelist — when non-null, MCP servers are resolved fresh each invoke. */
  private readonly mcpWhitelist: string[] | null;
  /** Pre-resolved servers (legacy/test path). Used only when mcpWhitelist is null. */
  private readonly mcpServers: AcpMcpServer[];
  private readonly providerName: string;
  private readonly modelName: string;
  private readonly sessionModel?: string;
  private readonly appliedContextBinding?: import('../../../types.js').AgentContextBinding;
  private readonly mcpSupportEnabled: boolean;
  /**
   * #1186: Resolved ACP idle TTL — authoritative threshold for all no-event termination.
   * Always concrete: defaults to DEFAULT_ACP_IDLE_TTL_MS (30m) when config omits it,
   * so promptStream never falls back to the client's hardcoded 90s/15m defaults.
   */
  private readonly idleTtlMs: number;
  /** turn.agent_busy retry backoff schedule — see AcpAgentServiceConfig.agentBusyRetryDelaysMs. */
  private readonly agentBusyRetryDelaysMs: number[];
  /** Becomes true only after this concrete ACP service observes usable standard usage telemetry. */
  private observedUsageUpdate = false;

  constructor(config: AcpAgentServiceConfig) {
    this.catId = config.catId;
    this.pool = config.pool;
    this.poolKey = config.poolKey;
    this.projectRoot = config.projectRoot;
    this.mcpWhitelist = config.mcpWhitelist ?? null;
    this.mcpServers = config.mcpServers ?? [];
    this.providerName = config.providerName ?? 'acp';
    this.modelName = config.modelName ?? config.sessionModel ?? 'acp';
    this.sessionModel = config.sessionModel?.trim() || undefined;
    this.appliedContextBinding = config.contextBinding;
    this.mcpSupportEnabled = config.mcpSupport !== false;
    this.idleTtlMs = config.idleTtlMs ?? DEFAULT_ACP_IDLE_TTL_MS;
    this.agentBusyRetryDelaysMs = config.agentBusyRetryDelaysMs ?? DEFAULT_AGENT_BUSY_RETRY_DELAYS_MS;
  }

  contextCapability(): import('../../../types.js').AgentContextCapability {
    const nativeWindowControl = this.providerName === 'kimi' || this.providerName === 'opencode';
    return {
      provider: this.providerName,
      carrier: 'acp',
      reportsRuntimeWindow: true,
      authoritativeUsage: true,
      usageTelemetry: this.observedUsageUpdate ? 'available' : 'conditional',
      nativeWindowControl,
      nativeCompressionControl: false,
      observesCompression: false,
      reason: this.observedUsageUpdate
        ? `Active ACP agent emitted authoritative usage_update telemetry${
            nativeWindowControl ? ' and applies the member window at process spawn' : ''
          }`
        : `ACP lifecycle support is conditional until the active agent emits usage_update.used${
            nativeWindowControl ? '; the member window is applied at process spawn' : ''
          }`,
    };
  }

  contextBinding(): import('../../../types.js').AgentContextBinding | undefined {
    return this.appliedContextBinding;
  }

  private observeUsageTelemetry(event: AcpSessionUpdate): void {
    if (event.update?.sessionUpdate !== 'usage_update') return;
    const used = event.update.used;
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0) {
      this.observedUsageUpdate = true;
    }
  }

  /**
   * promptStream wrapper that absorbs turn.agent_busy rejections. The agent rejects
   * a new prompt while one of ITS OWN internal turns (background-task completion
   * steer, goal continuation — invisible to the harness) occupies the session.
   * The rejection arrives before the prompt starts a turn (zero events), so
   * retrying after a backoff is safe and cannot double-send user-visible output.
   * Any other error — or a failure after real events flowed — propagates unchanged.
   */
  private async *promptStreamWithBusyRetry(
    client: PromptStreamClient,
    sessionId: string,
    prompt: string,
    opts: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
    ctx: Record<string, unknown>,
    signal?: AbortSignal,
    hooks?: { onAttemptStart?: () => void; onBackoff?: (attempt: number, delayMs: number) => void },
  ): AsyncGenerator<AcpSessionUpdate> {
    const delays = this.agentBusyRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      let yieldedEvents = 0;
      hooks?.onAttemptStart?.();
      try {
        for await (const event of client.promptStream(sessionId, prompt, opts)) {
          yieldedEvents++;
          yield event;
        }
        return;
      } catch (err) {
        if (!isAgentBusyError(err) || yieldedEvents > 0 || attempt >= delays.length) throw err;
        const delayMs = delays[attempt];
        if (delayMs === undefined) throw err; // unreachable: attempt < delays.length
        log.warn(
          { ...ctx, sessionId, busyAttempt: attempt + 1, maxRetries: delays.length, delayMs },
          'ACP agent busy with an internal turn — backing off before prompt retry',
        );
        hooks?.onBackoff?.(attempt + 1, delayMs);
        await sleepWithAbort(delayMs, signal);
      }
    }
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: this.providerName, model: this.modelName };
    // Diagnostic context: threadId + invocationId for correlating thread-specific failures
    const threadId = options?.auditContext?.threadId;
    const invocationId = options?.auditContext?.invocationId;
    const ctx = { catId: this.catId, threadId, invocationId };
    // F197 KD-5: per-invocation transformer state for toolCallId dedup + lifecycle tracking.
    // Lifecycle = ACP session/invocation (this generator) — GC'd when invoke() returns.
    const acpState = createAcpSessionState();

    // Window 1: pre-aborted signal short-circuits immediately
    if (options?.signal?.aborted) {
      yield {
        type: 'error',
        catId: this.catId,
        error: 'prompt_failure: aborted before start',
        errorCode: 'prompt_failure',
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    let lease: AcpLease | null = null;
    try {
      lease = await this.pool.acquire(this.poolKey, { sessionId: options?.sessionId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ ...ctx, err: errMsg }, 'ACP init failure');
      yield {
        type: 'error',
        catId: this.catId,
        error: `init_failure: ${errMsg}`,
        errorCode: 'init_failure',
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
      return;
    }

    // Pool returns AcpPoolClient; we know it's actually an AcpClient with full protocol methods
    const client = lease.client as unknown as {
      newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpNewSessionResult>;
      loadSession(sessionId: string, cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpNewSessionResult>;
      setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
      cancelSession(sessionId: string): void;
      promptStream(
        sessionId: string,
        text: string,
        options?: { timeoutMs?: number; idleWarningMs?: number; idleStallMs?: number },
      ): AsyncGenerator<import('./types.js').AcpSessionUpdate>;
      onCapacity(fn: (signal: AcpCapacitySignal) => void): void;
      offCapacity(fn: (signal: AcpCapacitySignal) => void): void;
      readonly recentCapacitySignal: AcpCapacitySignal | null;
      clearRecentCapacitySignal(): void;
    };
    const cwd = options?.workingDirectory ?? this.projectRoot;
    let sessionId: string | undefined;
    let promptPhase: PromptPhase = 'not_started';

    const sealActivePromptSession = (activeSessionId: string): boolean => {
      if (promptPhase !== 'active_unacknowledged') return false;
      promptPhase = 'locally_terminated_unacknowledged';
      const sessionIds = new Set([activeSessionId, options?.sessionId].filter((id): id is string => Boolean(id)));
      for (const id of sessionIds) this.pool.sealSession?.(this.poolKey, id);
      return true;
    };
    const cancelActivePromptSession = (activeSessionId: string): boolean => {
      if (!sealActivePromptSession(activeSessionId)) return false;
      client.cancelSession(activeSessionId);
      return true;
    };
    const markPromptAcknowledged = () => {
      if (promptPhase === 'active_unacknowledged') promptPhase = 'provider_acknowledged';
    };

    // Per-invoke capacity listener — covers the entire invoke lifecycle (newSession + prompt + grace).
    // This is intentionally invoke-level, not prompt-level: capacity is a provider-level property
    // (same process = same API key = same quota), so signals from any phase are relevant.
    let capacitySignal: AcpCapacitySignal | null = null;
    let capacityWarningYielded = false; // F149: dedup — at most one warning per invoke
    const onCapacity = (signal: AcpCapacitySignal) => {
      capacitySignal = signal;
    };
    client.onCapacity(onCapacity);

    // Abort handler: cancels the specific session, not the shared client
    const onAbort = options?.signal
      ? () => {
          const phaseAtAbort = promptPhase;
          const cancelledActivePrompt = sessionId ? cancelActivePromptSession(sessionId) : false;
          log.info({ ...ctx, sessionId, phaseAtAbort, cancelledActivePrompt }, 'ACP invocation abort signal observed');
        }
      : undefined;
    if (onAbort && options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    let promptStreamStartedAt = 0;
    let eventCount = 0;
    // Circuit breaker: compaction auto-continue loop detection.
    // After scratchpad is detected by the transformer, count events still arriving.
    // If they exceed the threshold, OpenCode is in a compaction → auto-continue loop.
    let scratchpadSuppressedEvents = 0;
    const MAX_SCRATCHPAD_SUPPRESSED_EVENTS = 50;

    try {
      // #712 P1-1: resolve MCP servers at invoke time from capabilities.json
      // so capability toggles take effect immediately without registry rebuild.
      // P1-2: check project-local capabilities.json first, fall back to runtime root.
      const userProjectRoot = options?.workingDirectory;
      let baseMcpServers: AcpMcpServer[];
      if (this.mcpWhitelist !== null) {
        let capConfig: CapabilitiesConfig | null = null;
        // Track which root supplied capabilities.json — external MCP entries
        // with relative paths must resolve against the config source, not runtime root.
        let configSourceRoot = this.projectRoot;
        if (this.mcpSupportEnabled && userProjectRoot && userProjectRoot !== this.projectRoot) {
          try {
            capConfig = await readCapabilitiesConfig(userProjectRoot);
            configSourceRoot = userProjectRoot;
          } catch {
            /* No project-local config — fall back to runtime root */
          }
        }
        if (!capConfig) {
          try {
            capConfig = await readCapabilitiesConfig(this.projectRoot);
            configSourceRoot = this.projectRoot;
          } catch {
            /* best-effort — resolveAcpMcpServers handles null config */
          }
        }
        const disabled = resolveDisabledServerIds(this.projectRoot, this.catId as string, capConfig);
        baseMcpServers = await resolveAcpMcpServers(this.projectRoot, this.mcpWhitelist, undefined, {
          mcpSupport: this.mcpSupportEnabled,
          disabledServerIds: disabled,
          catId: this.catId as string,
          capabilitiesConfig: capConfig,
          configSourceRoot,
        });
      } else {
        baseMcpServers = this.mcpServers;
      }

      // F145 Phase E: merge user project .mcp.json servers per-invoke
      // F161 gate: when mcpSupport is disabled, skip ALL MCP
      let invokeServers = baseMcpServers;
      if (this.mcpSupportEnabled && userProjectRoot && userProjectRoot !== this.projectRoot) {
        const baseNames = new Set(baseMcpServers.map((s) => s.name));
        const userServers = resolveUserProjectMcpServers(userProjectRoot, baseNames);
        if (userServers.length > 0) {
          invokeServers = [...baseMcpServers, ...userServers];
        }
      }

      // Per-invocation: merge callbackEnv into cat-cafe* MCP servers so callback tools
      // (multi_mention, post_message, etc.) get CAT_CAFE_API_URL / token / invocationId.
      // #1099 review P1: the credential refresh file is SESSION-scoped — the nonce path
      // is decided before session/new (MCP subprocess env freezes at session creation),
      // and resume rewrites the same file with fresh creds. A superseded process keeps
      // its own file, which stops updating — its late callbacks fail registry.isLatest().
      const buildSessionConfig = (preparedCreds: PreparedCredentialEnv | null) => {
        const sessionCallbackEnv = preparedCreds?.env ?? options?.callbackEnv;
        return {
          mcpServers: materializeSessionMcpServers(invokeServers, sessionCallbackEnv),
          envDiag: callbackEnvDiagnostic(sessionCallbackEnv),
        };
      };
      let sessionMcpServers: AcpMcpServer[] = invokeServers;
      let envDiag = callbackEnvDiagnostic(options?.callbackEnv);
      // Session reuse: if options.sessionId is provided (from session chain), try to
      // reuse the existing ACP session for multi-turn memory. The agent keeps conversation
      // history server-side, so reusing the session avoids "amnesia" across turns.
      let resumeDisposition: ResumeDisposition = options?.sessionId
        ? lease.canResumeRequestedSession === false
          ? 'sealed_fresh'
          : 'resume_requested'
        : 'fresh_without_resume';
      const resumeSessionId = resumeDisposition === 'resume_requested' ? options?.sessionId : undefined;
      if (resumeDisposition === 'sealed_fresh') {
        log.warn(
          { ...ctx, sealedSessionId: options?.sessionId },
          'ACP cancelled session is sealed; creating a fresh replacement session',
        );
      }

      if (resumeSessionId) {
        const resumeCreds = resolveSessionCredentialFile(options?.callbackEnv, resumeSessionId);
        const resumeConfig = buildSessionConfig(resumeCreds);
        try {
          log.info(
            {
              ...ctx,
              sessionId: resumeSessionId,
              cwd,
              mcpCount: resumeConfig.mcpServers.length,
              ...resumeConfig.envDiag,
            },
            'ACP session resume: loading existing session',
          );
          const session = await client.loadSession(resumeSessionId, cwd, resumeConfig.mcpServers);
          sessionId = session.sessionId || resumeSessionId;
          this.pool.rememberSession?.(this.poolKey, sessionId, lease);
          if (sessionId !== resumeSessionId) this.pool.rememberSession?.(this.poolKey, resumeSessionId, lease);
          if (resumeCreds) {
            writeSessionCredentialFile(options?.callbackEnv, resumeCreds.path);
            bindSessionCredentialFile(sessionId, resumeCreds.path);
            if (sessionId !== resumeSessionId) bindSessionCredentialFile(resumeSessionId, resumeCreds.path);
          }
          sessionMcpServers = resumeConfig.mcpServers;
          envDiag = resumeConfig.envDiag;
          metadata.sessionId = sessionId;
          resumeDisposition = 'resumed';
          log.info({ ...ctx, sessionId, requestedSessionId: resumeSessionId }, 'ACP session resume completed');
        } catch (err) {
          resumeDisposition = 'load_failed_fresh';
          const errorMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            { ...ctx, sessionId: resumeSessionId, cwd, err: errorMsg },
            'ACP session resume failed; creating a fresh session',
          );
        }
      }

      if (resumeDisposition !== 'resumed') {
        const freshCreds = prepareSessionCredentialFile(options?.callbackEnv);
        const freshConfig = buildSessionConfig(freshCreds);
        sessionMcpServers = freshConfig.mcpServers;
        envDiag = freshConfig.envDiag;
        log.info(
          { ...ctx, cwd, promptLen: prompt.length, mcpCount: sessionMcpServers.length, ...envDiag },
          'ACP newSession starting',
        );
        const session = await client.newSession(cwd, sessionMcpServers);
        sessionId = session.sessionId;
        this.pool.rememberSession?.(this.poolKey, sessionId, lease);
        if (freshCreds) bindSessionCredentialFile(sessionId, freshCreds.path);
        metadata.sessionId = sessionId;
        log.info({ ...ctx, sessionId }, 'ACP newSession completed');

        const sessionModel = this.sessionModel;
        const modelConfig = sessionModel ? resolveSessionModelConfigOption(session, sessionModel) : null;
        if (modelConfig && sessionModel) {
          try {
            await client.setSessionConfigOption(sessionId, modelConfig.configId, sessionModel);
            log.info({ ...ctx, sessionId, model: this.sessionModel }, 'ACP session model selected');
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            log.warn(
              { ...ctx, sessionId, model: this.sessionModel, err: errorMsg },
              'ACP session model selection failed — continuing with agent default',
            );
          }
        }
      }

      // At this point sessionId is always defined (resume or newSession path).
      // TS control-flow can't prove it across the if/else — assert for downstream usage.
      if (!sessionId) throw new Error('ACP invariant: sessionId must be set after session setup');

      // Window 2: abort may have fired during newSession
      if (options?.signal?.aborted) {
        yield {
          type: 'error',
          catId: this.catId,
          error: 'prompt_failure: aborted during session setup',
          errorCode: 'prompt_failure',
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId,
        ephemeralSession: false,
        metadata,
        timestamp: Date.now(),
      };

      // Window 3: consumer may abort during the yield above
      if (options?.signal?.aborted) {
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Prepend system prompt (ACP agents have no system prompt flag).
      // Any resumed turn that had to create a fresh session lost the identity it
      // expected session memory to carry, so restore the fallback exactly once.
      const restoresResumeIdentity = resumeDisposition === 'load_failed_fresh' || resumeDisposition === 'sealed_fresh';
      const fallbackSystemPrompt =
        restoresResumeIdentity && options?.resumeFallbackSystemPrompt ? options.resumeFallbackSystemPrompt : undefined;
      const effectivePrompt = options?.systemPrompt
        ? `${options.systemPrompt}\n\n${prompt}`
        : fallbackSystemPrompt
          ? `${fallbackSystemPrompt}\n\n${prompt}`
          : prompt;

      // Window 4: onAbort listener covers the duration of promptStream
      promptStreamStartedAt = Date.now();
      // Prompt digest: length + hash only (snippets gated by AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS)
      const promptDigest = createPromptDigest(effectivePrompt);
      // #1186: Thread resolved idle TTL to promptStream so the watchdog respects
      // the member's ACP Idle TTL (or 30m default) instead of hardcoded 90s/180s.
      // Turn budget (timeoutMs) must exceed idle stall so AcpStreamIdleError fires
      // first with configuredIdleStallMs. Add 60s margin to avoid timer races.
      const promptStreamOpts = {
        idleStallMs: this.idleTtlMs,
        timeoutMs: this.idleTtlMs + ACP_PROMPT_TIMEOUT_MARGIN_MS,
      };
      // Busy-retry phase tracking: attempts re-mark the prompt active; the
      // backoff window downgrades to busy_backoff so abort cannot cancel/seal
      // the agent-internal turn we are waiting out.
      const busyRetryHooks = {
        onAttemptStart: () => {
          promptPhase = 'active_unacknowledged';
        },
        onBackoff: () => {
          promptPhase = 'busy_backoff';
        },
      };
      log.info({ ...ctx, sessionId, promptDigest, idleTtlMs: this.idleTtlMs }, 'ACP promptStream starting');
      eventCount = 0;
      promptPhase = 'active_unacknowledged';
      for await (const event of this.promptStreamWithBusyRetry(
        client,
        sessionId,
        effectivePrompt,
        promptStreamOpts,
        ctx,
        options?.signal,
        busyRetryHooks,
      )) {
        this.observeUsageTelemetry(event);
        // F149: Capacity signal injected by AcpClient.promptStream from stderr.
        // Breaks through zero-event stalls where the old listener-only path couldn't.
        if (event.update?.sessionUpdate === 'provider_capacity_signal') {
          if (!capacityWarningYielded) {
            capacityWarningYielded = true;
            capacitySignal = { message: event.update.message as string, timestamp: event.update.timestamp as number };
            log.info({ ...ctx, sessionId }, 'ACP capacity warning yielded to frontend (stream)');
            yield makeCapacityWarning(this.catId, this.providerName, capacitySignal, metadata);
          }
          continue; // Not a real ACP event — don't count, don't transform
        }
        // F149: Stream idle warning injected by AcpClient idle watchdog.
        // #1203: Internal telemetry only — in the zero-first-event case this
        // fires before any reply exists, making the '已开始回复但后续停滞' bubble
        // factually wrong. The terminal stall still errors via AcpStreamIdleError.
        if (event.update?.sessionUpdate === 'stream_idle_warning') {
          log.info(
            { ...ctx, sessionId, idleSinceMs: event.update.idleSinceMs },
            'Stream idle warning (suppressed — internal telemetry)',
          );
          continue; // Not a real ACP event — don't count, don't transform
        }
        // Tool wait warning — agent is waiting for MCP tool result, idle is expected.
        // #1203: Internal watchdog telemetry only — the CLI shows no such bubble,
        // so don't surface one in chat. The client-side watchdog + stall ceiling
        // still protect against genuinely hung tools.
        if (event.update?.sessionUpdate === 'stream_tool_wait_warning') {
          log.info(
            { ...ctx, sessionId, idleSinceMs: event.update.idleSinceMs },
            'Stream tool wait warning (idle suppressed — tool executing)',
          );
          continue;
        }
        // F149: Fallback — capacity signal captured before promptStream started
        // (e.g. during newSession), surfaced on first real event
        if (capacitySignal && !capacityWarningYielded) {
          capacityWarningYielded = true;
          log.info({ ...ctx, sessionId }, 'ACP capacity warning yielded to frontend (pre-stream fallback)');
          yield makeCapacityWarning(this.catId, this.providerName, capacitySignal, metadata);
        }
        eventCount++;
        if (eventCount === 1) {
          const firstEventLatencyMs = Date.now() - promptStreamStartedAt;
          log.info({ ...ctx, sessionId, firstEventLatencyMs }, 'ACP first event received');
        }
        // F197: transformAcpEvent may return AgentMessage | AgentMessage[] | null
        // (Gemini v0.36 single-event with status=completed splits into [tool_use, tool_result])
        const result = transformAcpEvent(event, this.catId, metadata, acpState);

        // Circuit breaker: OpenCode compaction auto-continue loop detection.
        // When the transformer detects compaction scratchpad output, it suppresses
        // subsequent text chunks (returns null). If events keep flowing after detection,
        // OpenCode is stuck in a compaction → auto-continue loop. Cancel the session
        // after a threshold to stop burning tokens.
        if (acpState.scratchpadDetected) {
          scratchpadSuppressedEvents++;
          if (scratchpadSuppressedEvents >= MAX_SCRATCHPAD_SUPPRESSED_EVENTS) {
            log.error(
              { ...ctx, sessionId, eventCount, scratchpadSuppressedEvents },
              'ACP compaction auto-continue loop detected — cancelling session',
            );
            cancelActivePromptSession(sessionId);
            throw new Error(
              `ACP compaction auto-continue loop cancelled after ${scratchpadSuppressedEvents} suppressed events`,
            );
          }
        }

        if (!result) continue;
        if (Array.isArray(result)) {
          for (const msg of result) yield msg;
        } else {
          yield result;
        }
      }
      markPromptAcknowledged();
      log.info({ ...ctx, sessionId, eventCount }, 'ACP promptStream completed');

      // #1091: Zero-event resume detection. Some ACP providers (e.g. kimi) return
      // success from session/load but don't actually restore conversation context.
      // The subsequent promptStream produces zero content events and exits immediately.
      // Detect this and retry with a fresh session so the cat isn't silently dead.
      const promptElapsedMs = Date.now() - promptStreamStartedAt;
      const RESUME_EMPTY_THRESHOLD_MS = 3_000;
      if (resumeDisposition === 'resumed' && eventCount === 0 && promptElapsedMs < RESUME_EMPTY_THRESHOLD_MS) {
        log.warn(
          { ...ctx, sessionId, promptElapsedMs },
          '#1091: ACP resumed session produced zero events in <3s — retrying with fresh session',
        );
        // Create fresh session and retry promptStream once (not recursive — single retry)
        promptPhase = 'not_started';
        try {
          const retryCreds = prepareSessionCredentialFile(options?.callbackEnv);
          const retryConfig = buildSessionConfig(retryCreds);
          const freshSession = await client.newSession(cwd, retryConfig.mcpServers);
          const freshSessionId = freshSession.sessionId;
          this.pool.rememberSession?.(this.poolKey, freshSessionId, lease);
          // Replacement retry is a NEW ACP session, so it must get a fresh
          // credential file path. Reusing the failed resume path would let the
          // dead session read future replacement-session credentials.
          if (retryCreds) bindSessionCredentialFile(freshSessionId, retryCreds.path);
          metadata.sessionId = freshSessionId;
          // Repoint the outer sessionId so the abort handler cancels the fresh
          // session, not the dead resumed one.
          sessionId = freshSessionId;

          // Abort may have fired during the fresh newSession (mirrors Window 2)
          if (options?.signal?.aborted) {
            yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
            return;
          }

          // Apply session model if configured
          const sessionModel = this.sessionModel;
          const modelConfig = sessionModel ? resolveSessionModelConfigOption(freshSession, sessionModel) : null;
          if (modelConfig && sessionModel) {
            try {
              await client.setSessionConfigOption(freshSessionId, modelConfig.configId, sessionModel);
            } catch {
              /* best-effort — continue with agent default */
            }
          }

          // Announce the replacement session so the invocation layer rebinds the
          // session chain to the fresh sessionId. Without this, the next resume
          // would target the dead session and hit the zero-event path again.
          yield {
            type: 'session_init',
            catId: this.catId,
            sessionId: freshSessionId,
            ephemeralSession: false,
            metadata,
            timestamp: Date.now(),
          };

          // Consumer may abort during the yield above (mirrors Window 3)
          if (options?.signal?.aborted) {
            yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
            return;
          }

          // Build effective prompt with system prompt (fresh session has no memory)
          const retryPrompt = options?.systemPrompt
            ? `${options.systemPrompt}\n\n${prompt}`
            : options?.resumeFallbackSystemPrompt
              ? `${options.resumeFallbackSystemPrompt}\n\n${prompt}`
              : prompt;

          const retryState = createAcpSessionState();
          let retryEventCount = 0;
          log.info({ ...ctx, sessionId: freshSessionId }, '#1091: retry promptStream on fresh session');
          promptPhase = 'active_unacknowledged';
          for await (const event of this.promptStreamWithBusyRetry(
            client,
            freshSessionId,
            retryPrompt,
            promptStreamOpts,
            ctx,
            options?.signal,
            busyRetryHooks,
          )) {
            this.observeUsageTelemetry(event);
            // Skip synthetic events (capacity/idle/tool-wait warnings)
            if (event.update?.sessionUpdate === 'provider_capacity_signal') continue;
            if (event.update?.sessionUpdate === 'stream_idle_warning') continue;
            if (event.update?.sessionUpdate === 'stream_tool_wait_warning') continue;

            retryEventCount++;
            const result = transformAcpEvent(event, this.catId, metadata, retryState);
            if (!result) continue;
            if (Array.isArray(result)) {
              for (const msg of result) yield msg;
            } else {
              yield result;
            }
          }
          markPromptAcknowledged();
          log.info({ ...ctx, sessionId: freshSessionId, retryEventCount }, '#1091: retry promptStream completed');

          // Flush trailing thinking from retry
          const retryThinking = flushAcpThinking(retryState, this.catId, metadata);
          if (retryThinking) yield retryThinking;
          client.clearRecentCapacitySignal();
          yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
          return; // Exit — retry path handled completion
        } catch (retryErr) {
          if (sessionId && (retryErr instanceof AcpTimeoutError || retryErr instanceof AcpStreamIdleError)) {
            sealActivePromptSession(sessionId);
          }
          const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.error({ ...ctx, sessionId, err: retryErrMsg }, '#1091: retry with fresh session also failed');
          yield {
            type: 'error',
            catId: this.catId,
            error: `resume_empty_retry_failed: ${retryErrMsg}`,
            errorCode: 'prompt_failure',
            metadata,
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
          return; // Exit — error path handled completion
        }
      }

      // Flush any remaining accumulated thinking before done.
      const trailingThinking = flushAcpThinking(acpState, this.catId, metadata);
      if (trailingThinking) yield trailingThinking;
      // Successful prompt — provider has recovered; clear stale capacity signal
      client.clearRecentCapacitySignal();

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      if (sessionId && (err instanceof AcpTimeoutError || err instanceof AcpStreamIdleError)) {
        sealActivePromptSession(sessionId);
      }
      const waitedMs = promptStreamStartedAt ? Date.now() - promptStreamStartedAt : 0;
      // P1: stderr may arrive after timeout — give a grace window for late capacity signals
      if (!capacitySignal && err instanceof AcpTimeoutError) {
        await new Promise((r) => setTimeout(r, 2_000));
      }
      // F149: Zero-event stall with capacity signal — yield warning before error
      if (capacitySignal && !capacityWarningYielded) {
        capacityWarningYielded = true;
        log.info({ ...ctx }, 'ACP capacity warning yielded (catch path)');
        yield makeCapacityWarning(this.catId, this.providerName, capacitySignal, metadata);
      }
      // Flush any pending thinking accumulated before the error — don't lose user-visible content.
      const pendingThinking = flushAcpThinking(acpState, this.catId, metadata);
      if (pendingThinking) yield pendingThinking;

      const { errorCode, errorMsg } = classifyError(err, capacitySignal, client.recentCapacitySignal);
      log.error({ ...ctx, errorCode, err: errorMsg, sessionId, eventCount, waitedMs }, 'ACP prompt failure');
      yield {
        type: 'error',
        catId: this.catId,
        error: toUserFacingError(this.providerName, errorCode, errorMsg),
        errorCode,
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } finally {
      client.offCapacity(onCapacity);
      if (onAbort && options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      lease.release();
    }
  }
}

/** @deprecated Use AcpAgentService. Alias for backward compatibility during transition. */
export const GeminiAcpAdapter = AcpAgentService;
/** @deprecated Use AcpAgentServiceConfig. */
export type { AcpAgentServiceConfig as GeminiAcpAdapterConfig_Deprecated };

function resolveSessionModelConfigOption(
  session: { configOptions?: unknown },
  modelId: string,
): { configId: string } | null {
  const configOptions = session.configOptions;
  if (!Array.isArray(configOptions)) return null;
  const modelOption = configOptions.find(
    (option) => isRecord(option) && (option.id === 'model' || option.category === 'model'),
  );
  if (!isRecord(modelOption)) return null;
  const configId = typeof modelOption.id === 'string' ? modelOption.id.trim() : '';
  if (!configId) return null;
  if (modelOption.currentValue === modelId) return null;
  const optionValues = Array.isArray(modelOption.options)
    ? modelOption.options
        .map((option) => (isRecord(option) && typeof option.value === 'string' ? option.value.trim() : ''))
        .filter(Boolean)
    : [];
  if (optionValues.length > 0 && !optionValues.includes(modelId)) return null;
  return { configId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** F149: Build a provider_signal warning for realtime capacity display. */
function makeCapacityWarning(
  catId: CatId,
  providerName: string,
  signal: AcpCapacitySignal,
  metadata: MessageMetadata,
): AgentMessage {
  return {
    type: 'provider_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `${providerName} 服务端容量不足，正在重试 (${signal.message.slice(0, 100)})`,
    }),
    metadata,
    timestamp: Date.now(),
  };
}

/** Max age (ms) for client-level capacity signal to be used as fallback evidence. */
const RECENT_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;

/** Pattern for stream idle stall errors thrown by AcpClient idle watchdog. */
const STREAM_IDLE_RE = /Stream idle|STREAM_IDLE_STALL/i;

function classifyError(
  err: unknown,
  capacitySignal: AcpCapacitySignal | null | undefined,
  clientRecentSignal?: AcpCapacitySignal | null,
): { errorCode: string; errorMsg: string } {
  if (err instanceof AcpProtocolError) {
    // JSON-RPC data.error carries the real cause (e.g. Kimi wraps exceptions
    // as -32603 "Internal error" with the detail in data). Surface it.
    const dataDetail =
      typeof err.data === 'object' && err.data !== null && 'error' in (err.data as Record<string, unknown>)
        ? String((err.data as Record<string, unknown>).error)
        : null;
    const fullMsg = dataDetail ? `${err.message} — ${dataDetail}` : err.message;

    if (isAgentBusyError(err)) {
      // turn.agent_busy after busy-retry exhaustion — agent-internal turn still active
      return { errorCode: 'agent_busy', errorMsg: fullMsg };
    }
    if (err.code === -32000 || fullMsg.includes('capacity')) {
      return { errorCode: 'model_capacity', errorMsg: fullMsg };
    }
    if (/\bmcp\b/i.test(fullMsg)) {
      return { errorCode: 'mcp_pollution', errorMsg: fullMsg };
    }
    return { errorCode: 'prompt_failure', errorMsg: fullMsg };
  }
  if (err instanceof AcpTimeoutError) {
    // Priority 1: invoke-level listener captured signal in real time
    if (capacitySignal) {
      return {
        errorCode: 'model_capacity',
        errorMsg: `Provider capacity exhausted (upstream 429, evidence: invoke_signal). ${capacitySignal.message}`,
      };
    }
    // Priority 2: client-level signal within window — delayed stderr from CLI buffering
    if (clientRecentSignal && Date.now() - clientRecentSignal.timestamp < RECENT_SIGNAL_MAX_AGE_MS) {
      const ageS = Math.round((Date.now() - clientRecentSignal.timestamp) / 1000);
      return {
        errorCode: 'model_capacity',
        errorMsg: `Provider capacity exhausted (upstream 429, evidence: recent_process_signal, ${ageS}s ago). ${clientRecentSignal.message}`,
      };
    }
    return { errorCode: 'turn_budget_exceeded', errorMsg: err.message };
  }
  // F149: Stream idle stall — provider started responding then went silent
  const msg = err instanceof Error ? err.message : String(err);
  if (STREAM_IDLE_RE.test(msg) || (err instanceof Error && (err as { code?: string }).code === 'STREAM_IDLE_STALL')) {
    return { errorCode: 'stream_idle_stall', errorMsg: msg };
  }
  if (msg.includes('ENOENT') || msg.includes('spawn')) {
    return { errorCode: 'init_failure', errorMsg: msg };
  }
  return { errorCode: 'prompt_failure', errorMsg: msg };
}

/** Map internal error codes to user-friendly messages that clarify the failure source.
 *  Format: `{errorCode}: {errorMsg}\n{user-facing explanation}`
 *  The errorCode prefix is preserved for machine grep-ability (tests + invoke-helpers). */
function toUserFacingError(providerName: string, errorCode: string, errorMsg: string): string {
  const label = providerName === 'acp' ? 'ACP agent' : providerName;
  const base = `${errorCode}: ${errorMsg}`;
  switch (errorCode) {
    case 'agent_busy':
      return `${base}\n⚠️ ${label} 正在处理内部轮次（如后台任务完成通知），自动重试后仍被占用。非 Clowder AI 系统故障，稍后重试即可。`;
    case 'model_capacity':
      return `${base}\n⚠️ ${label} 服务端容量不足（服务器繁忙），非 Clowder AI 系统故障。`;
    case 'stream_idle_stall':
      return `${base}\n⚠️ ${label} 服务端响应中断（服务器可能繁忙或不稳定），非 Clowder AI 系统故障。`;
    case 'turn_budget_exceeded': {
      // #1186: Derive actual timeout from error message instead of hardcoding 15m.
      // AcpTimeoutError format: "...did not respond within ${ms}ms"
      const budgetMatch = errorMsg.match(/within (\d+)ms/);
      const budgetMinutes = budgetMatch ? Math.round(Number(budgetMatch[1]) / 60_000) : '?';
      return `${base}\n⚠️ 本轮对话时间预算用完（${budgetMinutes}分钟），agent 可能在执行复杂工具链。非故障，可重试。`;
    }
    case 'mcp_pollution':
      return `${base}\n⚠️ ${label} 工具调用异常（MCP 服务端错误）。`;
    case 'init_failure':
      return `${base}\n⚠️ ACP agent 启动失败（本地进程异常）。`;
    case 'prompt_failure':
      if (/Premature close|ECONNRESET|socket hang up/i.test(errorMsg)) {
        return `${base}\n⚠️ ${label} 与服务端连接中断（Premature close），非 Clowder AI 系统故障。`;
      }
      return base;
    default:
      return base;
  }
}
