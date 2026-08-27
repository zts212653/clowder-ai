/**
 * Agent Service Types
 * Agent 服务的共享类型定义
 */

import type {
  A2ARoutingProjection,
  CatId,
  CliEffortPreset,
  CodexSpeedValue,
  CrossThreadCoordination,
  FreshnessCarrierCapability,
  MessageContent,
  QueueTerminalConsumptionWitness,
  ReplyPreview,
  RequestGenerationRetryReason,
  RequestGenerationSourceRef,
  SanitizedRequestedRuntimeConfigV1,
} from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import type { CliDiagnostics } from '../../../utils/cli-diagnostics.js';
import type { CliSpawnOptions } from '../../../utils/cli-types.js';
import type { AntigravitySessionLifecycle } from './agents/providers/antigravity/antigravity-runtime-lifecycle.js';
import type { CodexSessionReplacementProvenance } from './runtime-session/CodexSessionReplacementProvenance.js';
import type { TurnExecutionMessageProjection } from './stores/ports/TurnExecutionStore.js';

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
   *  (e.g. Gemini CLI stats) — not usable for single-turn context fill ratio.
   *  This does not taint a separately extracted lastTurnInputTokens value. */
  isCumulativeUsage?: boolean;
  /** Codex session token_count: exact current context usage shown by CLI status. */
  contextUsedTokens?: number;
  /** Codex session token_count: reset timestamp (epoch ms) for display-only hint. */
  contextResetsAtMs?: number;
}

/** Resolve the only token signals that represent the current context rather than aggregate spend. */
export function resolveCurrentContextUsage(
  usage: TokenUsage,
): { usedTokens: number; usedFrom: 'context' | 'last_turn' } | undefined {
  if (usage.contextUsedTokens != null && Number.isFinite(usage.contextUsedTokens) && usage.contextUsedTokens > 0) {
    return { usedTokens: usage.contextUsedTokens, usedFrom: 'context' };
  }
  if (
    usage.lastTurnInputTokens != null &&
    Number.isFinite(usage.lastTurnInputTokens) &&
    usage.lastTurnInputTokens > 0
  ) {
    return { usedTokens: usage.lastTurnInputTokens, usedFrom: 'last_turn' };
  }
  return undefined;
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
  /** Stable active-execution owner used by read-model projections; may be the parent invocation. */
  executionId?: string;
  threadId: string;
  userId: string;
  catId: CatId;
}

/**
 * Exact Clowder AI task identity available to provider-local bounded recovery.
 * This is correlation truth, not a natural-language task classifier.
 */
export interface InvocationRecoveryAnchor {
  threadId: string;
  invocationId: string;
  promptMessageIds: readonly string[];
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
  /**
   * F296: provider-authored compaction edge; never inferred from message text.
   *
   * Claude derives the event identity from its session record. The Codex
   * app-server instead carries the identity on the wire, so it supplies the
   * minted event directly rather than having one reconstructed from a counter.
   */
  contextCompaction?:
    | {
        readonly eventSource: 'claude_compact_boundary';
        readonly preTokens?: number;
      }
    | {
        readonly eventSource: 'codex_app_server_context_compaction';
        readonly event: ProviderCompactionObservation;
      };
  /** Which cat (agent) produced this message */
  catId: CatId;
  /** Text content (for 'text' and 'tool_result' types) */
  content?: string;
  /** Machine-readable A2A target cat for 'a2a_handoff' events. */
  targetCatId?: CatId;
  /**
   * F086/F216: structured scheduling mode for 'a2a_handoff' events.
   * Carries serial-vs-parallel explicitly so no consumer has to infer it from the number
   * of targets or their ordering. Absent only on legacy/replayed events.
   */
  routing?: A2ARoutingProjection;
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
  /** F118/F211: explicit cause and evidence for a Codex native-session replacement. */
  sessionReplacement?: CodexSessionReplacementProvenance;
  /** Tool name (for 'tool_use' and 'tool_result' types; required by F153 Phase J AC-J1) */
  toolName?: string;
  /** Canonical execution carrier. Consumers must display unknown instead of inferring from toolName. */
  toolSource?: 'host_cli' | 'mcp' | 'plugin_connector' | 'unknown';
  /** Canonical model-output channel when the provider reports one; otherwise unknown. */
  toolChannel?: 'analysis' | 'commentary' | 'final' | 'unknown';
  /** Tool input parameters (for 'tool_use' type) */
  toolInput?: Record<string, unknown>;
  /** F153 Phase J AC-J1: native provider tool call id; used to pair tool_use ↔ tool_result for real-duration spans.
   *  Provider transformers MUST inject this from raw payload when available (Claude tool_use.id,
   *  CatAgent tool_use_id, Codex item.id, etc). Providers without native id may omit; ToolSpanTracker treats
   *  missing id as fallback (no span open, no fake duration) per KD-41. */
  toolUseId?: string;
  /** F153 Phase J AC-J1: structured tool execution outcome (for 'tool_result' type).
   *  Provider transformers MUST map from raw payload (is_error / success / exitCode / status) instead of
   *  letting downstream guess from content string. Use 'unknown' when raw signal is genuinely absent. */
  toolResultStatus?: 'ok' | 'error' | 'unknown';
  /** Host-grounded failure provenance for approval-gated tool results. Never infer
   *  user_rejected when the carrier has no interactive confirmation surface. */
  toolResultErrorCode?: 'user_rejected' | 'confirmation_unavailable';
  /** F153 Phase J Slice J-B AC-J7: tool span trace context for hydrate-side real-duration
   *  span synthesis. Stamped by invoke-single-cat when ToolSpanTracker opens / has-open
   *  a span for this event (so route-helpers can carry it into StoredToolEvent.tracing).
   *  Distinct from `tracing` above (which carries the invocation/route span pointer);
   *  this one points at the tool span itself, and parentSpanId points at the invocation
   *  span so hydrate can re-parent the synthesized `cat_cafe.tool_use ...` span. */
  toolTracing?: { traceId: string; spanId: string; parentSpanId?: string };
  /** Error message (for 'error' type) */
  error?: string;
  /** Whether an error event is a recoverable diagnostic or a terminal disposition.
   *  Omitted means terminal for backward compatibility; terminal `done.errorCode`
   *  remains the authoritative aggregate failure signal. */
  errorDisposition?: 'transient' | 'terminal';
  /** Whether this is the final 'done' in a multi-cat invocation (for 'done' type) */
  isFinal?: boolean;
  /** Provider/model metadata (set by agent services) */
  metadata?: MessageMetadata;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** Canonical stored-message ID once persistence has completed. */
  messageId?: string;
  /** F52: Cross-thread origin metadata (set for cross-thread callback messages) */
  extra?: {
    crossPost?: {
      sourceThreadId: string;
      sourceInvocationId?: string;
      /** F246 Phase B: effect-class label for receiving-side behavior constraints */
      effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    };
    coordination?: CrossThreadCoordination;
    targetCats?: string[];
    causal?: { kind: 'invocation_reply'; triggerMessageId: string };
    /** Immutable child identity for live/F5 execution-kind parity. */
    turnExecution?: TurnExecutionMessageProjection;
    /** Bodyless child executions attached to the visible child they assisted. */
    auxiliaryTurnExecutions?: TurnExecutionMessageProjection[];
    /** #814: True when message originated from an explicit post_message callback (not stream duplicate) */
    isExplicitPost?: boolean;
    /** F272: durable proactive visit that owns this canonical home message. */
    proactive?: { visitId: string; intentId: string; source: 'private_time' };
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
  /** Exact durable child start time carried only by the typed invocation-created
   *  lifecycle event. Consumers must not recover it by parsing `content`. */
  turnExecutionStartedAt?: number;
  /** Typed F167 Phase T proof that this exact child consumed a terminal
   *  coordination wake and correctly produced no reply. */
  turnCustodyTerminalWitness?: QueueTerminalConsumptionWitness;
  /** Exact per-source proofs when one child adopted multiple queued custody
   *  obligations through prompt exposure before provider startup. */
  turnCustodyTerminalWitnesses?: readonly QueueTerminalConsumptionWitness[];
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

/** F254 D2 duplex JSON carrier used by provider app-server protocols. */
export interface AgentCarrierSession {
  read(): AsyncIterable<unknown>;
  write(message: Record<string, unknown>): Promise<void>;
  /** True only when a resume lease was acquired from its still-healthy affinity host. */
  reusedSessionHost?: boolean;
  /** Bind a provider session id to this reusable carrier host after start/resume. */
  rememberSession?(sessionId: string): void;
  /**
   * Force the transport process/pane to stop after a provider-native interrupt
   * grace window expires.  Cooperative cancellation belongs to the protocol
   * client; this method is only the bounded OS-level fallback.
   */
  terminate?(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentCarrierSessionOptions {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | null>;
  signal?: AbortSignal;
  invocationId: string;
  /** Existing provider session id used for warm-host affinity. */
  sessionId?: string;
}

export type AgentCarrierSessionFactory = (options: AgentCarrierSessionOptions) => Promise<AgentCarrierSession>;

/** F254 D2 carrier truth used to bind provider-native freshness telemetry. */
export type AgentFreshnessCarrierCapability = FreshnessCarrierCapability;

/** #1208: capability truth for the concrete provider/carrier used by an invocation. */
export interface AgentContextCapability {
  readonly provider: string;
  readonly carrier: string;
  readonly reportsRuntimeWindow: boolean;
  readonly authoritativeUsage: boolean;
  /**
   * Whether authoritative current-context usage has actually been proven for
   * this concrete carrier. `conditional` is used by generic transports such as
   * ACP until the active agent emits the standard usage signal at least once.
   */
  readonly usageTelemetry: 'available' | 'conditional' | 'unavailable';
  readonly nativeWindowControl: boolean;
  readonly nativeCompressionControl: boolean;
  readonly observesCompression: boolean;
  readonly reason: string;
}

/** F296 B0: concrete provider transport identity, independent of route/origin. */
export type ProviderCarrier =
  | { readonly provider: 'claude'; readonly carrier: 'print_sdk' | 'bg_daemon' | 'interactive_pty' | 'api_key' }
  | { readonly provider: 'codex'; readonly carrier: 'exec_json' | 'app_server' }
  | { readonly provider: 'gemini'; readonly carrier: 'gemini_cli' | 'antigravity_adapter' }
  | { readonly provider: 'antigravity'; readonly carrier: 'cdp_bridge' }
  | { readonly provider: 'kimi'; readonly carrier: 'stream_json' }
  | { readonly provider: 'opencode'; readonly carrier: 'run_json' }
  | { readonly provider: 'acp'; readonly carrier: 'acp'; readonly backend: 'opencode' | 'unknown' }
  | { readonly provider: 'catagent'; readonly carrier: 'direct_api' }
  | { readonly provider: 'a2a'; readonly carrier: 'remote' }
  | {
      readonly provider: 'unknown';
      readonly carrier: 'unknown';
      readonly rawProvider?: string;
      readonly rawCarrier?: string;
    };

export type InvocationOrigin = 'interactive' | 'headless' | 'scheduled' | 'connector' | 'cloud' | 'unknown';
export type RouteTopology = 'serial' | 'parallel' | 'independent';

export interface ContextCoordinate {
  readonly providerCarrier: ProviderCarrier;
  readonly invocationOrigin: InvocationOrigin;
  readonly routeTopology: RouteTopology;
}

export type FreshReason = 'no_prior_session' | 'resume_rejected' | 'resume_failed' | 'carrier_forces_fresh';
export type UnknownReason = 'carrier_unsupported' | 'signal_unavailable' | 'binding_mismatch';

export type ContinuityDisposition =
  | {
      readonly state: 'fresh';
      readonly reason: FreshReason;
      readonly evidenceRef: string;
      readonly runtimeSessionId?: string;
    }
  | {
      readonly state: 'resumed';
      readonly reason: 'resume_confirmed';
      readonly evidenceRef: string;
      readonly runtimeSessionId: string;
    }
  | {
      readonly state: 'replaced';
      readonly reason: 'runtime_replaced';
      readonly evidenceRef: string;
      readonly previousRuntimeSessionId?: string;
      readonly runtimeSessionId: string;
    }
  | {
      readonly state: 'unknown';
      readonly reason: UnknownReason;
      readonly evidenceRef: string;
    };

export interface ContextContinuityHandshake {
  readonly coordinate: ContextCoordinate;
  readonly disposition: ContinuityDisposition;
}

/**
 * F296 B4a: the raw continuity fact a provider adapter observed, before any
 * normalization into a {@link ContinuityDisposition}.
 *
 * Only the adapter that issued the underlying provider call may construct this.
 * Every variant is derived from an actual provider response — never from a
 * persisted binding, a token drop, a scratchpad, or an equality check between
 * what we asked for and what we stored. Gate 0 (2026-08-20, codex-cli 0.147.0)
 * proved each variant is dynamically observable on `codex/app_server`.
 */
export type ProviderContinuityEvidence =
  /** A new provider runtime was created and returned its id. */
  | { readonly kind: 'started'; readonly runtimeSessionId: string }
  /** Resume succeeded and the provider echoed back exactly the requested id. */
  | {
      readonly kind: 'resumed';
      readonly requestedRuntimeSessionId: string;
      readonly runtimeSessionId: string;
    }
  /** Resume was rejected by the provider; a fallback start created a new runtime. */
  | {
      readonly kind: 'replaced';
      readonly requestedRuntimeSessionId: string;
      readonly runtimeSessionId: string;
    }
  /**
   * Resume "succeeded" but the provider returned a different id. This is never
   * coerced to `resumed`; it normalizes to `unknown/binding_mismatch`.
   */
  | {
      readonly kind: 'mismatched';
      readonly requestedRuntimeSessionId: string;
      readonly runtimeSessionId: string;
    }
  /** The adapter reached a verdict point but the provider gave no usable signal. */
  | { readonly kind: 'unavailable'; readonly reason: UnknownReason };

/** The prompt bytes an adapter is allowed to send, plus the generation they belong to. */
export interface ProviderContinuityPrompt {
  readonly prompt: string;
  /** Content hash of {@link prompt}; the ledger generation these bytes were reserved under. */
  readonly promptGenerationId: string;
}

/**
 * F296 B4b: an authoritative compaction the adapter observed on the wire,
 * reduced to a stable coordinate. Gate 0 proved the coordinate for
 * `codex/app_server` is `(envelope.threadId, envelope.turnId, item.id)` — the
 * `contextCompaction` item body itself carries no thread or turn identity.
 */
export interface ProviderCompactionObservation {
  /** Stable, replay-suppressible identity for this compaction. */
  readonly eventId: string;
  /** The runtime this compaction actually applies to. Never inferred from a binding. */
  readonly runtimeSessionId: string;
  readonly evidenceRef: string;
}

/**
 * F296 B4a preflight fence. The invocation hands this to a preflight-capable
 * adapter instead of a frozen prompt string.
 */
export interface ProviderContinuityPreflight {
  /** The runtime the invocation wants resumed, if any. The adapter requests it; it proves nothing on its own. */
  readonly requestedRuntimeSessionId?: string;
  /**
   * Called exactly once, by the adapter, after the continuity verdict is minted
   * from the actual provider response and after buffered authoritative
   * compaction events for the bound runtime have been drained — and strictly
   * before any prompt bytes leave the process.
   *
   * Resolving this runs the epoch owner, the context prompt factory, the
   * presentation mapper and the ledger reservation, in that order, and returns
   * the only prompt bytes the adapter is permitted to send.
   */
  settle(input: {
    readonly evidence: ProviderContinuityEvidence;
    /** Compactions observed for the bound runtime before these bytes were built. */
    readonly compactions?: readonly ProviderCompactionObservation[];
  }): Promise<ProviderContinuityPrompt>;
}

/** The invocation-owned capacity snapshot passed to provider-native controls. */
export interface AgentContextCapacity {
  readonly windowTokens: number;
  readonly inputCeilingTokens: number;
  readonly actionable: boolean;
}

/**
 * Concrete proof of the model/window attached to one carrier instance or
 * per-invocation native configuration. This is a pure runtime projection and
 * must never be persisted or inferred from capability flags alone.
 */
export interface AgentContextBinding {
  readonly model?: string;
  readonly windowTokens?: number;
  readonly source: 'service_spawn' | 'invocation_config';
}

/** ADR-042 automatic supplement execution: provider + callback layers must enforce this, not prompt prose. */
export interface ToolExecutionPolicy {
  readonly mode: 'read_only';
  readonly replayDeniedToolNames: readonly string[];
}

/**
 * Options for invoking an agent
 */
export interface AgentServiceOptions {
  /** Session ID to resume (optional) */
  sessionId?: string;
  /** #1208: same capacity snapshot used by prompt assembly and lifecycle health. */
  contextCapacity?: AgentContextCapacity;
  /**
   * #1381: raw/native provider window owned by member config (manual/catalog),
   * captured before any session pin or carrier report shrinks the effective
   * capacity. Providers with nativeWindowControl inject THIS as their native
   * window (e.g. Codex `model_context_window`), never the effective/pinned
   * `contextCapacity.windowTokens` — Codex reports back
   * `native * effective_context_window_percent`, so feeding the effective value
   * back recursed (258400 → 245480 → 233206 → …).
   * `null` explicitly means "no config-owned native window; do not inject".
   * `undefined` is a legacy caller: fall back to `contextCapacity.windowTokens`.
   */
  contextNativeWindowTokens?: number | null;
  /** F262: Raw per-thread member effort. Providers validate against the effective model before applying it. */
  reasoningEffortOverride?: CliEffortPreset;
  /** F291: Resolved Codex OAuth requested tier. Undefined means inherit Codex user config. */
  requestedServiceTier?: CodexSpeedValue;
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
  /** Exact task identity used when a provider can safely resume an interrupted turn. */
  recoveryAnchor?: InvocationRecoveryAnchor;
  /** Static identity prompt (Claude: --append-system-prompt, others: prepend to prompt) */
  systemPrompt?: string;
  /** Static identity prompt used only if a resumed carrier creates a fresh fallback session. */
  resumeFallbackSystemPrompt?: string;
  /** F089: Override spawnCli with tmux-based spawner (set per-invocation) */
  spawnCliOverride?: SpawnCliOverride;
  /** F254 D2: optional tmux/direct duplex carrier factory for app-server mode. */
  agentCarrierSessionFactory?: AgentCarrierSessionFactory;
  /** F254 D2: per-invocation two-phase provider-native freshness controller. */
  activeInvocationFreshness?: import('./freshness/FreshnessNoticeBroker.js').ActiveInvocationFreshnessController;
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
  /** ADR-042 hard execution boundary for automatic supplement checks. */
  toolExecutionPolicy?: ToolExecutionPolicy;
  /**
   * F299 Phase D: fail-closed recorder invoked by the concrete adapter after
   * its final message/native channels are immutable and immediately before
   * those same values cross the provider boundary.
   */
  beforeProviderLaunch?: (request: PreparedProviderRequestV1) => Promise<ProviderRequestGenerationCommitV1>;
}

export interface PreparedProviderRequestV1 {
  readonly v: 1;
  /** Bounded invocation-local reason when this is an adapter-owned follow-up launch. */
  readonly boundaryReason?: RequestGenerationRetryReason;
  readonly message:
    | {
        readonly accuracy?: 'exact';
        readonly body: string;
        readonly sourceRefs?: readonly RequestGenerationSourceRef[];
        readonly injectionDecision?: string;
      }
    | {
        readonly accuracy: 'unsupported' | 'unknown';
        readonly sourceRefs?: readonly RequestGenerationSourceRef[];
        readonly injectionDecision?: string;
      };
  readonly nativeInstructions: readonly {
    readonly body: string;
    readonly sourceRefs?: readonly RequestGenerationSourceRef[];
    readonly injectionDecision?: string;
  }[];
  readonly runtime: SanitizedRequestedRuntimeConfigV1;
  /**
   * Ephemeral tool evidence. Raw schemas and server names are consumed by the
   * transcript owner to mint keyed set digests and are never persisted.
   */
  readonly tools: PreparedProviderToolSurfaceV1;
  readonly providerNativeVisibility: 'unsupported' | 'unknown';
}

export interface PreparedProviderToolSurfaceV1 {
  readonly finalSurface: 'exact' | 'declared_only' | 'unsupported' | 'unknown';
  /** Secret-free server identifiers actually declared to the carrier. */
  readonly declaredServerNames?: readonly string[];
  /** Clowder AI-owned schemas actually placed on the request boundary. */
  readonly catCafeSchemas?: readonly unknown[];
  /** Schemas reported back by a provider-owned negotiation surface. */
  readonly providerObservedSchemas?: readonly unknown[];
}

export function requireExactPreparedProviderMessage(request: PreparedProviderRequestV1): string {
  if ('body' in request.message) return request.message.body;
  throw new Error('prepared_provider_request_message_not_exact');
}

export interface ProviderRequestGenerationCommitV1 {
  readonly requestGenerationId: string;
  readonly generationOrdinal: number;
  readonly sessionId: string;
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
   * F296 B4a: invoke a carrier that owns a real pre-prompt continuity seam.
   *
   * There is deliberately no `prompt` parameter. The final prompt bytes exist
   * only as the return value of {@link ProviderContinuityPreflight.settle},
   * which the adapter can call only after it has minted a continuity verdict
   * from an actual provider response. This makes "freeze the prompt first, then
   * notify that we resumed" structurally unrepresentable rather than merely
   * discouraged.
   *
   * Declared only by services whose adapter has been dynamically proven to
   * expose the seam (F296 B4 Gate 0). Callers must fall back to {@link invoke}
   * when it is absent.
   */
  invokeWithContinuityPreflight?(
    preflight: ProviderContinuityPreflight,
    options?: AgentServiceOptions,
  ): AsyncIterable<AgentMessage>;

  /** True only when this concrete carrier applies the requested policy before model launch. */
  supportsToolExecutionPolicy?(policy: ToolExecutionPolicy): boolean;

  /** F254 D2: effective carrier capability for this concrete service instance. */
  freshnessCarrierCapability?(): AgentFreshnessCarrierCapability;

  /** #1208: effective context capability for this concrete service/carrier. */
  contextCapability?(): AgentContextCapability;

  /** #1208: model/window already applied to this concrete service instance. */
  contextBinding?(): AgentContextBinding | undefined;

  /**
   * #1208: concrete model/window this service will deterministically apply
   * from the invocation-owned capacity before model launch. This is a pure
   * projection of provider-native configuration, not a capability inference.
   */
  contextBindingForCapacity?(capacity: AgentContextCapacity): AgentContextBinding | undefined;

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
}

/**
 * F203 Phase I — L0 compiler function signature.
 * Same as `compileL0ViaSubprocess` but injectable for testing.
 */
export type L0CompilerFn = (options: {
  catId: string;
  userId?: string;
  dataDir?: string;
  outPath?: string;
}) => Promise<string>;

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
