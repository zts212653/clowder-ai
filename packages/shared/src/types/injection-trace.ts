/**
 * F237 — Injection Trace types (v0)
 *
 * Observability layer for prompt injection — captures what was injected,
 * when, and through which delivery channel. Does NOT depend on hook
 * pipeline infrastructure (HookManifest, HookRegistry, etc.).
 */

/** Injection stage — maps to existing builder functions. */
export type InjectionStage = 'session-init' | 'per-turn';

/** Delivery channel for injected content. */
export type DeliveryChannel = 'message-prepend' | 'native-l0' | 'pack-only' | 'always-delivered';

/** Per-segment observation record. */
export interface ObservedSegment {
  segmentId: string;
  stage: InjectionStage;
  status: 'observed' | 'absent';
  contentHash: string | null;
  charCount: number;
  /** Approximate token count (tiktoken cl100k_base). */
  tokenEstimate: number;

  // F257 Phase A Line B: optional pipeline-rich fields (backward compatible).
  // v0 collector leaves these undefined; pipeline bridge populates them.
  /** Hook manifest version (fired events only). */
  version?: number;
  /** Fine-grained pipeline status: 'fired' | 'skipped' | 'disabled' | 'observed'. */
  pipelineStatus?: string;
  /** Skip reason code (skipped events only). */
  reasonCode?: string;
  /** Human-readable skip reason (skipped events only). */
  reason?: string;
  /** Who disabled the hook: 'manifest' | 'operator' | 'auto-eval' (disabled events only). */
  disabledBy?: string;

  // F257 Console 判据④：真现场回放 provenance（可选，旧数据兼容）。
  /** Actual rendered content at event time — only for fired/observed segments. */
  content?: string | null;
  /** How the content was actually produced at event time. */
  contentSourceKind?: import('./segment-lifecycle.js').SegmentContentSourceKind;
  /** Template source identifier (templateId or template path) for variable-segment provenance. */
  templateRef?: string | null;
  /** Variable bindings snapshot at event time for variable-segment provenance. */
  templateVars?: Record<string, string> | null;
}

/**
 * Delivery decision for a stage.
 *
 * `contentAssembled` indicates whether the route assembled content for this
 * stage — NOT whether it was actually delivered to the model. Actual delivery
 * depends on downstream factors the route cannot observe (session-chain resume
 * state, native L0 provider behavior). Consumers should treat this as
 * "content was prepared and passed to the invocation layer".
 */
export interface StageDeliveryDecision {
  stage: InjectionStage;
  contentAssembled: boolean;
  channel: DeliveryChannel;
  reason: string;
}

/** Compact per-turn summary — persistent (TTL=0). */
export interface InjectionTraceSummary {
  turnId: string;
  /** Optional — only populated when invocation-level session ID is available. */
  sessionId?: string;
  threadId: string;
  catId: string;
  timestamp: number;
  segments: ObservedSegment[];
  delivery: StageDeliveryDecision[];
  totalCharCount: number;
  /** Approximate total token count across all assembled content. */
  totalTokenEstimate: number;
  totalSegmentsObserved: number;
  totalSegmentsAbsent: number;
  durationMs: number;
}

/** Full trace detail — debug layer (TTL=7d). */
export interface InjectionTraceDetail {
  turnId: string;
  threadId: string;
  catId: string;
  timestamp: number;
  sessionContentHash: string | null;
  turnContentHash: string | null;
  sessionCharCount: number;
  sessionTokenEstimate: number;
  turnCharCount: number;
  turnTokenEstimate: number;
  segments: ObservedSegment[];
}

/** Stable join coordinates for one complete invocation trace episode. */
export interface TraceEpisodeRef {
  traceTurnId: string;
  invocationId: string;
  ownerUserId: string;
  threadId: string;
  catId: string;
  /** Incoming user/A2A message. Null is an explicit provenance gap. */
  inputMessageId: string | null;
  /** Persisted terminal cat message. Null for failed/cancelled/no-output turns. */
  outputMessageId: string | null;
}

export interface TraceToolCall {
  toolName: string;
  callId?: string;
  outcome: 'ok' | 'error' | 'unknown';
  /** Bounded provider/tool result excerpt used only by explicit structured rules. */
  resultDetail?: string;
}

/**
 * Immutable terminal sidecar for an InjectionTraceSummary.
 *
 * Prompt tracing is persisted before the provider invocation. This sidecar is
 * written after the terminal response/message seam and joins the two halves by
 * exact IDs. It deliberately contains no Objective/Metric judgment.
 */
export interface TraceTerminalExtension extends TraceEpisodeRef {
  terminalAt: number;
  terminalKind: 'completed' | 'failed' | 'cancelled';
  toolCalls: TraceToolCall[];
}

/** Read model: prompt exposure plus its exact invocation terminal sidecar. */
export interface TraceEpisode {
  summary: InjectionTraceSummary;
  terminal: TraceTerminalExtension;
}
