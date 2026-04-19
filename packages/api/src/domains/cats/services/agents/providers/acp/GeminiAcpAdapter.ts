/**
 * GeminiAcpAdapter — AgentService implementation backed by ACP protocol.
 *
 * Phase C: Acquires a client lease from AcpProcessPool per invocation.
 * Pool handles lifecycle (spawn, init, idle TTL, eviction, zombie cleanup).
 *
 * Key behaviors:
 *   - Pool-backed: each invoke() acquires lease, releases in finally
 *   - Session per invocation: each invoke() calls newSession()
 *   - 4-window abort coverage (pre-invoke, post-newSession, post-yield, during-prompt)
 *   - Failure classification: init_failure / prompt_failure / model_capacity / mcp_pollution / stream_idle_stall / turn_budget_exceeded
 *   - System prompt: prepended to prompt text (same as GeminiAgentService)
 */

import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { createPromptDigest } from '../../../context/prompt-digest.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { type AcpCapacitySignal, AcpProtocolError, AcpTimeoutError } from './AcpClient.js';
import type { AcpLease, AcpProcessPool, PoolKey } from './AcpProcessPool.js';
import { transformAcpEvent } from './acp-event-transformer.js';
import { resolveUserProjectMcpServers } from './acp-mcp-resolver.js';
import { callbackEnvDiagnostic, materializeSessionMcpServers } from './acp-session-env.js';
import type { AcpMcpServer } from './types.js';

const log = createModuleLogger('gemini-acp');

export interface GeminiAcpAdapterConfig {
  catId: CatId;
  pool: AcpProcessPool;
  poolKey: PoolKey;
  /** Project root (monorepo root) — used as default session cwd */
  projectRoot: string;
  /** MCP servers to pass to each ACP session (resolved from mcpWhitelist) */
  mcpServers?: AcpMcpServer[];
}

export class GeminiAcpAdapter implements AgentService {
  readonly catId: CatId;
  private readonly pool: AcpProcessPool;
  private readonly poolKey: PoolKey;
  private readonly projectRoot: string;
  private readonly mcpServers: AcpMcpServer[];

  constructor(config: GeminiAcpAdapterConfig) {
    this.catId = config.catId;
    this.pool = config.pool;
    this.poolKey = config.poolKey;
    this.projectRoot = config.projectRoot;
    this.mcpServers = config.mcpServers ?? [];
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'google', model: 'gemini-acp' };
    // Diagnostic context: threadId + invocationId for correlating thread-specific failures
    const threadId = options?.auditContext?.threadId;
    const invocationId = options?.auditContext?.invocationId;
    const ctx = { catId: this.catId, threadId, invocationId };

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
      lease = await this.pool.acquire(this.poolKey);
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
      newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<{ sessionId: string }>;
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

    try {
      // F145 Phase E: merge user project MCP servers per-invoke (thread.projectPath → workingDirectory)
      let invokeServers = this.mcpServers;
      const userProjectRoot = options?.workingDirectory;
      if (userProjectRoot && userProjectRoot !== this.projectRoot) {
        const baseNames = new Set(this.mcpServers.map((s) => s.name));
        const userServers = resolveUserProjectMcpServers(userProjectRoot, baseNames);
        if (userServers.length > 0) {
          invokeServers = [...this.mcpServers, ...userServers];
        }
      }

      // Per-invocation: merge callbackEnv into cat-cafe* MCP servers so callback tools
      // (multi_mention, post_message, etc.) get CAT_CAFE_API_URL / token / invocationId.
      const sessionMcpServers = materializeSessionMcpServers(invokeServers, options?.callbackEnv);
      const envDiag = callbackEnvDiagnostic(options?.callbackEnv);
      log.info(
        { ...ctx, cwd, promptLen: prompt.length, mcpCount: sessionMcpServers.length, ...envDiag },
        'ACP newSession starting',
      );
      const session = await client.newSession(cwd, sessionMcpServers);
      sessionId = session.sessionId;
      metadata.sessionId = sessionId;
      log.info({ ...ctx, sessionId }, 'ACP newSession completed');

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
        ephemeralSession: true,
        metadata,
        timestamp: Date.now(),
      };

      // Window 3: consumer may abort during the yield above
      if (options?.signal?.aborted) {
        client.cancelSession(sessionId);
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      // Prepend system prompt (Gemini CLI/ACP has no system prompt flag)
      const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;

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
            yield makeCapacityWarning(this.catId, capacitySignal, metadata);
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
            yield makeIdleWarning(this.catId, event, metadata);
          }
          continue; // Not a real ACP event — don't count, don't transform
        }
        // Tool wait warning — Gemini is waiting for MCP tool result, idle is expected
        if (event.update?.sessionUpdate === 'stream_tool_wait_warning') {
          log.info(
            { ...ctx, sessionId, idleSinceMs: event.update.idleSinceMs },
            'Stream tool wait warning (idle suppressed — tool executing)',
          );
          yield makeToolWaitWarning(this.catId, event, metadata);
          continue;
        }
        // F149: Fallback — capacity signal captured before promptStream started
        // (e.g. during newSession), surfaced on first real event
        if (capacitySignal && !capacityWarningYielded) {
          capacityWarningYielded = true;
          log.info({ ...ctx, sessionId }, 'ACP capacity warning yielded to frontend (pre-stream fallback)');
          yield makeCapacityWarning(this.catId, capacitySignal, metadata);
        }
        eventCount++;
        if (eventCount === 1) {
          const firstEventLatencyMs = Date.now() - promptStreamStartedAt;
          log.info({ ...ctx, sessionId, firstEventLatencyMs }, 'ACP first event received');
        }
        const msg = transformAcpEvent(event, this.catId, metadata);
        if (msg) yield msg;
      }
      log.info({ ...ctx, sessionId, eventCount }, 'ACP promptStream completed');
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
        yield makeCapacityWarning(this.catId, capacitySignal, metadata);
      }
      const { errorCode, errorMsg } = classifyError(err, capacitySignal, client.recentCapacitySignal);
      log.error({ ...ctx, errorCode, err: errorMsg, sessionId, eventCount, waitedMs }, 'ACP prompt failure');
      yield {
        type: 'error',
        catId: this.catId,
        error: toUserFacingError(errorCode, errorMsg),
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

/** F149: Build a provider_signal warning for realtime capacity display. */
function makeCapacityWarning(catId: CatId, signal: AcpCapacitySignal, metadata: MessageMetadata): AgentMessage {
  return {
    type: 'provider_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `Gemini 服务端容量不足，正在重试 (${signal.message.slice(0, 100)})`,
    }),
    metadata,
    timestamp: Date.now(),
  };
}

/** F149: Build a liveness_signal warning for stream idle watchdog. */
function makeIdleWarning(
  catId: CatId,
  event: import('./types.js').AcpSessionUpdate,
  metadata: MessageMetadata,
): AgentMessage {
  const idleSinceMs = (event.update?.idleSinceMs as number) ?? 0;
  return {
    type: 'liveness_signal',
    catId,
    content: JSON.stringify({
      type: 'warning',
      message: `Gemini 已开始回复但后续停滞 (idle ${Math.round(idleSinceMs / 1000)}s)`,
    }),
    metadata,
    timestamp: Date.now(),
  };
}

/** Build a liveness_signal info for tool wait — Gemini is executing MCP tool, idle is expected. */
function makeToolWaitWarning(
  catId: CatId,
  event: import('./types.js').AcpSessionUpdate,
  metadata: MessageMetadata,
): AgentMessage {
  const idleSinceMs = (event.update?.idleSinceMs as number) ?? 0;
  return {
    type: 'liveness_signal',
    catId,
    content: JSON.stringify({
      type: 'info',
      message: `Gemini 正在等待工具返回 (${Math.round(idleSinceMs / 1000)}s)`,
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
function toUserFacingError(errorCode: string, errorMsg: string): string {
  const base = `${errorCode}: ${errorMsg}`;
  switch (errorCode) {
    case 'model_capacity':
      return `${base}\n⚠️ Gemini 服务端容量不足（Google 服务器繁忙），非 Clowder AI 系统故障。`;
    case 'stream_idle_stall':
      return `${base}\n⚠️ Gemini 服务端响应中断（Google 服务器可能繁忙或不稳定），非 Clowder AI 系统故障。`;
    case 'turn_budget_exceeded':
      return `${base}\n⚠️ 本轮对话时间预算用完（${Math.round(900 / 60)}分钟），烁烁可能在执行复杂工具链。非故障，可重试。`;
    case 'mcp_pollution':
      return `${base}\n⚠️ Gemini 工具调用异常（MCP 服务端错误）。`;
    case 'init_failure':
      return `${base}\n⚠️ Gemini CLI 启动失败（本地进程异常）。`;
    case 'prompt_failure':
      if (/Premature close|ECONNRESET|socket hang up/i.test(errorMsg)) {
        return `${base}\n⚠️ Gemini 与 Google 服务端连接中断（Premature close），非 Clowder AI 系统故障。`;
      }
      return base;
    default:
      return base;
  }
}
