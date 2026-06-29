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
import { type AcpCapacitySignal, AcpProtocolError, AcpTimeoutError } from './AcpClient.js';
import type { AcpLease, AcpProcessPool, PoolKey } from './AcpProcessPool.js';
import { createAcpSessionState, flushAcpThinking, transformAcpEvent } from './acp-event-transformer.js';
import { resolveAcpMcpServers, resolveDisabledServerIds, resolveUserProjectMcpServers } from './acp-mcp-resolver.js';
import { callbackEnvDiagnostic, materializeSessionMcpServers } from './acp-session-env.js';
import type { AcpMcpServer, AcpNewSessionResult } from './types.js';

const log = createModuleLogger('acp-agent');

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
  /** When false, disables ALL MCP servers (base + per-project) for this member. */
  mcpSupport?: boolean;
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
  private readonly mcpSupportEnabled: boolean;

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
    this.mcpSupportEnabled = config.mcpSupport !== false;
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
      promptStream(sessionId: string, text: string): AsyncGenerator<import('./types.js').AcpSessionUpdate>;
      onCapacity(fn: (signal: AcpCapacitySignal) => void): void;
      offCapacity(fn: (signal: AcpCapacitySignal) => void): void;
      readonly recentCapacitySignal: AcpCapacitySignal | null;
      clearRecentCapacitySignal(): void;
    };
    const cwd = options?.workingDirectory ?? this.projectRoot;
    let sessionId: string | undefined;

    // Per-invoke capacity listener — covers the entire invoke lifecycle (newSession + prompt + grace).
    // This is intentionally invoke-level, not prompt-level: capacity is a provider-level property
    // (same process = same API key = same quota), so signals from any phase are relevant.
    let capacitySignal: AcpCapacitySignal | null = null;
    let capacityWarningYielded = false; // F149: dedup — at most one warning per invoke
    let idleWarningYielded = false; // F149: dedup — at most one idle warning per invoke
    const onCapacity = (signal: AcpCapacitySignal) => {
      capacitySignal = signal;
    };
    client.onCapacity(onCapacity);

    // Abort handler: cancels the specific session, not the shared client
    const onAbort = options?.signal
      ? () => {
          log.info({ ...ctx, sessionId }, 'ACP session cancelled via abort signal');
          if (sessionId && client) {
            client.cancelSession(sessionId);
          }
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
      const sessionMcpServers = materializeSessionMcpServers(invokeServers, options?.callbackEnv);
      const envDiag = callbackEnvDiagnostic(options?.callbackEnv);
      // Session reuse: if options.sessionId is provided (from session chain), try to
      // reuse the existing ACP session for multi-turn memory. The agent keeps conversation
      // history server-side, so reusing the session avoids "amnesia" across turns.
      const resumeSessionId = options?.sessionId;
      let isResumedSession = false;
      let resumeSessionLoadFailed = false;

      if (resumeSessionId) {
        try {
          log.info(
            { ...ctx, sessionId: resumeSessionId, cwd, mcpCount: sessionMcpServers.length, ...envDiag },
            'ACP session resume: loading existing session',
          );
          const session = await client.loadSession(resumeSessionId, cwd, sessionMcpServers);
          sessionId = session.sessionId || resumeSessionId;
          this.pool.rememberSession?.(this.poolKey, sessionId, lease);
          if (sessionId !== resumeSessionId) this.pool.rememberSession?.(this.poolKey, resumeSessionId, lease);
          metadata.sessionId = sessionId;
          isResumedSession = true;
          log.info({ ...ctx, sessionId, requestedSessionId: resumeSessionId }, 'ACP session resume completed');
        } catch (err) {
          resumeSessionLoadFailed = true;
          const errorMsg = err instanceof Error ? err.message : String(err);
          log.warn(
            { ...ctx, sessionId: resumeSessionId, cwd, err: errorMsg },
            'ACP session resume failed; creating a fresh session',
          );
        }
      }

      if (!isResumedSession) {
        log.info(
          { ...ctx, cwd, promptLen: prompt.length, mcpCount: sessionMcpServers.length, ...envDiag },
          'ACP newSession starting',
        );
        const session = await client.newSession(cwd, sessionMcpServers);
        sessionId = session.sessionId;
        this.pool.rememberSession?.(this.poolKey, sessionId, lease);
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
        client.cancelSession(sessionId);
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
        client.cancelSession(sessionId);
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Prepend system prompt (ACP agents have no system prompt flag).
      // If a resume load failed, the outer invocation skipped identity because it
      // expected session memory; the fresh fallback session must receive it once.
      const fallbackSystemPrompt =
        resumeSessionLoadFailed && options?.resumeFallbackSystemPrompt ? options.resumeFallbackSystemPrompt : undefined;
      const effectivePrompt = options?.systemPrompt
        ? `${options.systemPrompt}\n\n${prompt}`
        : fallbackSystemPrompt
          ? `${fallbackSystemPrompt}\n\n${prompt}`
          : prompt;

      // Window 4: onAbort listener covers the duration of promptStream
      promptStreamStartedAt = Date.now();
      // Prompt digest: length + hash only (snippets gated by AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS)
      const promptDigest = createPromptDigest(effectivePrompt);
      log.info({ ...ctx, sessionId, promptDigest }, 'ACP promptStream starting');
      eventCount = 0;
      for await (const event of client.promptStream(sessionId, effectivePrompt)) {
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
        if (event.update?.sessionUpdate === 'stream_idle_warning') {
          if (!idleWarningYielded) {
            idleWarningYielded = true;
            log.info(
              { ...ctx, sessionId, idleSinceMs: event.update.idleSinceMs },
              'Stream idle warning yielded to frontend',
            );
            yield makeIdleWarning(this.catId, this.providerName, event, metadata);
          }
          continue; // Not a real ACP event — don't count, don't transform
        }
        // Tool wait warning — agent is waiting for MCP tool result, idle is expected
        if (event.update?.sessionUpdate === 'stream_tool_wait_warning') {
          log.info(
            { ...ctx, sessionId, idleSinceMs: event.update.idleSinceMs },
            'Stream tool wait warning (idle suppressed — tool executing)',
          );
          yield makeToolWaitWarning(this.catId, this.providerName, event, metadata);
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
            client.cancelSession(sessionId);
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
      log.info({ ...ctx, sessionId, eventCount }, 'ACP promptStream completed');
      // Flush any remaining accumulated thinking before done.
      const trailingThinking = flushAcpThinking(acpState, this.catId, metadata);
      if (trailingThinking) yield trailingThinking;
      // Successful prompt — provider has recovered; clear stale capacity signal
      client.clearRecentCapacitySignal();

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
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

/** F149: Build a liveness_signal warning for stream idle watchdog. */
function makeIdleWarning(
  catId: CatId,
  providerName: string,
  event: import('./types.js').AcpSessionUpdate,
  metadata: MessageMetadata,
): AgentMessage {
  const idleSinceMs = (event.update?.idleSinceMs as number) ?? 0;
  return {
    type: 'liveness_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `${providerName} 已开始回复但后续停滞 (idle ${Math.round(idleSinceMs / 1000)}s)`,
    }),
    metadata,
    timestamp: Date.now(),
  };
}

/** Build a liveness_signal info for tool wait — agent is executing MCP tool, idle is expected. */
function makeToolWaitWarning(
  catId: CatId,
  providerName: string,
  event: import('./types.js').AcpSessionUpdate,
  metadata: MessageMetadata,
): AgentMessage {
  const idleSinceMs = (event.update?.idleSinceMs as number) ?? 0;
  return {
    type: 'liveness_signal',
    catId,
    content: JSON.stringify({
      type: 'info',
      message: `${providerName} 正在等待工具返回 (${Math.round(idleSinceMs / 1000)}s)`,
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
    if (err.code === -32000 || err.message.includes('capacity')) {
      return { errorCode: 'model_capacity', errorMsg: err.message };
    }
    if (/\bmcp\b/i.test(err.message)) {
      return { errorCode: 'mcp_pollution', errorMsg: err.message };
    }
    return { errorCode: 'prompt_failure', errorMsg: err.message };
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
    case 'model_capacity':
      return `${base}\n⚠️ ${label} 服务端容量不足（服务器繁忙），非 Clowder AI 系统故障。`;
    case 'stream_idle_stall':
      return `${base}\n⚠️ ${label} 服务端响应中断（服务器可能繁忙或不稳定），非 Clowder AI 系统故障。`;
    case 'turn_budget_exceeded':
      return `${base}\n⚠️ 本轮对话时间预算用完（${Math.round(900 / 60)}分钟），agent 可能在执行复杂工具链。非故障，可重试。`;
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
