/**
 * Agent Service Types
 * Agent 服务的共享类型定义
 */

import type { CatId, MessageContent, ReplyPreview } from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import type { CliDiagnostics } from '../../../utils/cli-diagnostics.js';
import type { CliSpawnOptions } from '../../../utils/cli-types.js';
import type { AntigravitySessionLifecycle } from './agents/providers/antigravity/antigravity-runtime-lifecycle.js';

/** F8: Unified token usage type across all three cats.
 *  inputTokens = TOTAL input tokens (new + cached). Normalised at extraction
 *  so that the field has the same semantics regardless of provider.
 *  cacheReadTokens = subset of inputTokens served from cache. */
export interface TokenUsage {
  inputTokens?: number; // Total input (normalised across providers) — AGGREGATED across turns
  outputTokens?: number;
  totalTokens?: number; // Gemini fallback (doesn't split in/out)
  cacheReadTokens?: number; // Subset of inputTokens from cache (Claude + Codex)
  cacheCreationTokens?: number; // Subset of inputTokens written to cache (Claude only)
  costUsd?: number; // Claude: exact from CLI; Codex: estimated from pricing table
  /** True when costUsd was calculated from a pricing table rather than reported by the CLI */
  costEstimated?: boolean;
  durationMs?: number; // Claude: total duration
  durationApiMs?: number; // Claude: pure API duration
  numTurns?: number; // Claude: number of turns
  contextWindowSize?: number; // F24: context window capacity (Claude: exact, others: fallback)
  /** F24-fix: Last API turn's total input tokens (= actual context fill).
   *  Unlike inputTokens which is aggregated across all turns, this value
   *  represents the single most recent API call's input size. */
  lastTurnInputTokens?: number;
  /** #679: true when inputTokens/totalTokens are cumulative across all turns
   *  (e.g. Gemini CLI stats) — not usable for single-turn context fill ratio. */
  isCumulativeUsage?: boolean;
  /** Codex session token_count: exact current context usage shown by CLI status. */
  contextUsedTokens?: number;
  /** Codex session token_count: reset timestamp (epoch ms) for display-only hint. */
  contextResetsAtMs?: number;
}

/** F8: Accumulate token usage — adds numeric fields from `incoming` into `existing` */
export function mergeTokenUsage(existing: TokenUsage | undefined, incoming: TokenUsage): TokenUsage {
  if (!existing) return { ...incoming };
  const result = { ...existing };
  const numericKeys = [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'costUsd',
    'durationMs',
    'durationApiMs',
    'numTurns',
  ] as const;
  for (const key of numericKeys) {
    const val = incoming[key];
    if (val != null) {
      result[key] = ((result[key] ?? 0) as number) + val;
    }
  }
  // Non-aggregating contextual fields should keep the most recent snapshot.
  const latestKeys = ['contextWindowSize', 'lastTurnInputTokens', 'contextUsedTokens', 'contextResetsAtMs'] as const;
  for (const key of latestKeys) {
    const val = incoming[key];
    if (val != null) {
      result[key] = val;
    }
  }
  if (incoming.isCumulativeUsage != null) {
    result.isCumulativeUsage = incoming.isCumulativeUsage;
  }
  if (incoming.costEstimated != null) {
    result.costEstimated = incoming.costEstimated;
  }
  return result;
}

/**
 * Metadata about the provider/model behind an agent message
 */
export interface MessageMetadata {
  provider: string;
  model: string;
  sessionId?: string;
  /**
   * F198 Bug #3: bg carrier surfaces the daemon's freshly-forked conversation
   * UUID after a `--bg --resume` turn (read from state.resumeSessionId). The
   * consumer persists it as the SessionRecord's latestResumeSessionId — the
   * next round's `--resume` target. bg-only; absent for other providers.
   */
  resumeSessionId?: string;
  usage?: TokenUsage;
  /** F061: false when provider cannot verify which model actually ran (e.g. CDP bridge) */
  modelVerified?: boolean;
  /** F061: diagnostic context attached when empty_response is triggered */
  diagnostics?: Record<string, unknown>;
  /** F061 Phase 3: structured upstream error classification for recovery decisions */
  upstreamError?: {
    kind: 'capacity' | 'network' | 'stream_interrupted' | 'invalid_tool_call' | 'unknown';
    transient: boolean;
    rawReason: string;
  };
  /** F212 Phase A: structured CLI error diagnostics (reasonCode + sanitized excerpt + debugRef).
   *  Populated by providers when isCliError/isCliTimeout fires, consumed by Phase B folded panel.
   *  Carries `__cliError.cliDiagnostics` / `__cliTimeout.cliDiagnostics` from cli-spawn. */
  cliDiagnostics?: CliDiagnostics;
}

/**
 * Correlation fields used by audit pipelines to connect service-level events.
 */
export interface AuditContext {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
}

/**
 * Types of messages that can be yielded from an agent
 */
export type AgentMessageType =
  | 'session_init'
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'done'
  | 'a2a_handoff'
  | 'system_info' // budget warnings, cancel feedback, extraction progress, thinking
  | 'provider_signal' // F149: upstream capacity/retry signals — skipped by invocation timeout & content flags
  | 'liveness_signal' // F149: stream idle watchdog — skipped by invocation timeout & content flags
  | 'status' // F198 Phase C: transient daemon progress detail — updates cat avatar tooltip, not a bubble
  | 'agent_loop'; // F153 Phase I: telemetry-only marker at LLM call boundary (provider stream parser emits; never user-visible)

/**
 * A message yielded from an agent during invocation
 */
export interface AgentMessage {
  /** The type of this message */
  type: AgentMessageType;
  /** Which cat (agent) produced this message */
  catId: CatId;
  /** Text content (for 'text' and 'tool_result' types) */
  content?: string;
  /** Machine-readable A2A target cat for 'a2a_handoff' events. */
  targetCatId?: CatId;
  /**
   * How the frontend should apply text content.
   * Default append preserves streaming semantics; replace is used when the
   * provider emits a full corrected snapshot instead of a pure suffix delta.
   */
  textMode?: 'append' | 'replace';
  /** Session ID (for 'session_init' type) */
  sessionId?: string;
  /** ACP transport: sessionId is per-invocation, not a persistent CLI session.
   *  When true, a different sessionId does NOT mean "session replaced" — skip seal. */
  ephemeralSession?: boolean;
  /** F211 A2: provider runtime lifecycle facts used by invocation to seal/create SessionRecords. */
  sessionLifecycle?: AntigravitySessionLifecycle;
  /** Tool name (for 'tool_use' and 'tool_result' types; required by F153 Phase J AC-J1) */
  toolName?: string;
  /** Tool input parameters (for 'tool_use' type) */
  toolInput?: Record<string, unknown>;
  /** F153 Phase J AC-J1: native provider tool call id; used to pair tool_use ↔ tool_result for real-duration spans.
   *  Provider transformers MUST inject this from raw payload when available (Claude tool_use.id, DARE tool_call_id,
   *  CatAgent tool_use_id, Codex item.id, etc). Providers without native id may omit; ToolSpanTracker treats
   *  missing id as fallback (no span open, no fake duration) per KD-41. */
  toolUseId?: string;
  /** F153 Phase J AC-J1: structured tool execution outcome (for 'tool_result' type).
   *  Provider transformers MUST map from raw payload (is_error / success / exitCode / status) instead of
   *  letting downstream guess from content string. Use 'unknown' when raw signal is genuinely absent. */
  toolResultStatus?: 'ok' | 'error' | 'unknown';
  /** F153 Phase J Slice J-B AC-J7: tool span trace context for hydrate-side real-duration
   *  span synthesis. Stamped by invoke-single-cat when ToolSpanTracker opens / has-open
   *  a span for this event (so route-helpers can carry it into StoredToolEvent.tracing).
   *  Distinct from `tracing` above (which carries the invocation/route span pointer);
   *  this one points at the tool span itself, and parentSpanId points at the invocation
   *  span so hydrate can re-parent the synthesized `cat_cafe.tool_use ...` span. */
  toolTracing?: { traceId: string; spanId: string; parentSpanId?: string };
  /** Error message (for 'error' type) */
  error?: string;
  /** Whether this is the final 'done' in a multi-cat invocation (for 'done' type) */
  isFinal?: boolean;
  /** Provider/model metadata (set by agent services) */
  metadata?: MessageMetadata;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** Backend stored-message ID (set for callback post-message, used for rich_block correlation) */
  messageId?: string;
  /** F52: Cross-thread origin metadata (set for cross-thread callback messages) */
  extra?: {
    crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
    targetCats?: string[];
    /** #814: True when message originated from an explicit post_message callback (not stream duplicate) */
    isExplicitPost?: boolean;
  };
  /** F121: ID of the message this message is replying to */
  replyTo?: string;
  /** F121: Hydrated preview of the replied-to message */
  replyPreview?: ReplyPreview;
  /** F061: Whether this message mentions the co-creator (@user/@co-creator/configured patterns) */
  mentionsUser?: boolean;
  /** F108: Invocation ID — allows frontend to distinguish messages from concurrent invocations.
   *  F194 Phase Z3 dual id: this is the chain/parent invocation id (legacy SoT for liveness/queue/cancel).
   *  Per-cat-turn id is `turnInvocationId` below — frontend uses turn for bubble identity stable key. */
  invocationId?: string;
  /** F194 Phase Z3 (砚砚 R P1-1): per-cat-turn invocation id, frontend uses for bubble identity
   *  stable key (prevents same-parent multi-turn-same-cat bubble merge). Stamped into
   *  `extra.stream.turnInvocationId` by useAgentMessages. */
  turnInvocationId?: string;
  /** F153-F: OTel span context for trace persistence (written to message extra.tracing) */
  tracing?: { traceId: string; spanId: string; parentSpanId?: string };
  /** F070: Structured error code for recoverable failures (e.g. GOVERNANCE_BOOTSTRAP_REQUIRED) */
  errorCode?: string;
  /**
   * F183 Phase C — thread-scoped monotonic sequence number (KD-9).
   * Set by `SocketManager.broadcastAgentMessage` from `ThreadSequencer.next()`
   * before WebSocket emit. Caller-supplied seq>0 is preserved as a transport
   * hint (e.g. test fixtures); production callers leave undefined and let
   * sequencer assign. Optional — direct emit paths that bypass SocketManager
   * won't set it; client treats absence as no-op (graceful degradation for
   * legacy producers).
   */
  seq?: number;
  /**
   * F183 Phase C (砚砚 R1 P1 fix) — server seq epoch (sequencer instance UUID).
   * Generated at API boot, stable for sequencer lifetime. Client compares to
   * `lastSeqEpochByThread[threadId]`; mismatch = server restart → reset lastSeq
   * + trigger catch-up. Without epoch, restart silently breaks gap detection
   * until server catches back up to client's high-water lastSeq.
   */
  seqEpoch?: string;
  /** When this message was created */
  timestamp: number;
}

/**
 * Override factory: replaces spawnCli() for tmux-based execution.
 * Same event contract — callers iterate events identically.
 */
export type SpawnCliOverride = (options: CliSpawnOptions) => AsyncGenerator<unknown, void, undefined>;

/**
 * Options for invoking an agent
 */
export interface AgentServiceOptions {
  /** Session ID to resume (optional) */
  sessionId?: string;
  /** Working directory for the agent */
  workingDirectory?: string;
  /** Env vars to pass to CLI process for MCP callback auth */
  callbackEnv?: Record<string, string>;
  /** F171: User-defined env vars from account config.
   *  Applied LAST to subprocess env — overrides provider-injected values. */
  accountEnv?: Record<string, string>;
  /** Rich content blocks (e.g. images) to pass to the CLI agent */
  contentBlocks?: readonly MessageContent[];
  /** Upload directory for resolving image paths */
  uploadDir?: string;
  /** AbortSignal to cancel the invocation */
  signal?: AbortSignal;
  /** Correlation context for audit logging and raw trace linking */
  auditContext?: AuditContext;
  /** Static identity prompt (Claude: --append-system-prompt, others: prepend to prompt) */
  systemPrompt?: string;
  /** F089: Override spawnCli with tmux-based spawner (set per-invocation) */
  spawnCliOverride?: SpawnCliOverride;
  /** F210-H1b: Override AGY --log-file path (test seam for the trajectory progress observer). */
  agyLogPathOverride?: string;
  /** F118: Invocation ID for diagnostic enrichment of __cliTimeout */
  invocationId?: string;
  /** F118: CLI session ID for diagnostic enrichment of __cliTimeout */
  cliSessionId?: string;
  /** F118 Phase B: Liveness probe config (undefined = disabled) */
  livenessProbe?: {
    sampleIntervalMs?: number;
    softWarningMs?: number;
    stallWarningMs?: number;
    boundedExtensionFactor?: number;
    minCpuGrowthMs?: number;
    /** #774: Auto-kill on idle-silent suspected_stall instead of waiting for full timeout */
    stallAutoKill?: boolean;
  };
  /** F127: Extra --config key=value pairs to pass to the CLI. */
  cliConfigArgs?: readonly string[];
  /** F153 Phase B: Parent OTel span for creating CLI session child span */
  parentSpan?: Span;
}

/**
 * Interface that all agent services must implement
 */
export interface AgentService {
  /**
   * Invoke the agent with a prompt and stream back messages
   * @param prompt The user's prompt/message
   * @param options Optional configuration
   * @returns An async iterable of agent messages
   */
  invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage>;

  /**
   * F203 Phase C — whether this provider injects the L0 static identity into
   * its native system role (e.g. Claude `--system-prompt-file`, Codex
   * `-c developer_instructions`). When true, the routing layer passes a
   * pack-only `systemPrompt` (non-pack identity travels the native channel,
   * compression-immune); when false/undefined the routing layer keeps the
   * full static identity in `params.systemPrompt` so cats with no native
   * channel still receive identity/家规 via user-message prepend.
   *
   * Optional — defaults to false for back-compat with non-native services.
   */
  injectsL0Natively?(): boolean;

  /**
   * F198 Bug #3 — whether this carrier resumes a conversation that has NO
   * stable per-conversation sessionId (the bg daemon forks a fresh UUID every
   * `--bg --resume` round). When true, invoke-single-cat derives a stable
   * chainKey = `bg:${threadId}:${catId}` and routes sessionId resolution,
   * the resume mutex key, session_init record reuse, and done bookkeeping
   * through it — bypassing the cliSessionId-based seal+create path that would
   * otherwise inflate one conversation into N sealed records.
   *
   * Optional — defaults to false. Only ClaudeBgCarrierService returns true;
   * every other provider (incl. `-p` ClaudeAgentService) keeps the stable
   * cliSessionId path unchanged.
   */
  usesChainKeyResume?(): boolean;

  /**
   * F177 Phase H (KD-13) — true iff this service runs in a harness that does
   * NOT honor the Claude Code F177-G Stop hook (e.g. CodexAgentService via
   * `codex exec --json`, which does not dispatch ~/.codex/hooks.json — H0 spike
   * 2026-06-11). When true, the serial route layer applies a server-side
   * routing guard: one inline remedial invoke when the turn ends with no valid
   * routing exit. Optional — defaults to false (Claude-family is already
   * covered by the Stop hook).
   */
  needsServerRoutingGuard?(): boolean;
}

/**
 * F203 Phase I — L0 compiler function signature.
 * Same as `compileL0ViaSubprocess` but injectable for testing.
 */
export type L0CompilerFn = (options: { catId: string; outPath?: string }) => Promise<string>;

/**
 * F203 Phase I — AgentService that carries an injectable L0 compiler seam.
 * OpenCodeAgentService implements this; Claude/Codex services keep their own
 * private l0CompilerFn (different lifecycle — they compile L0 internally).
 */
export interface L0InjectableAgentService extends AgentService {
  readonly l0CompilerFn?: L0CompilerFn;
}

/** Type guard: does this service expose an injectable L0 compiler? */
export function hasL0CompilerSeam(service: AgentService): service is L0InjectableAgentService {
  return 'l0CompilerFn' in service && typeof (service as L0InjectableAgentService).l0CompilerFn === 'function';
}
