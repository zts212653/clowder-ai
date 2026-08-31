/**
 * Segment Lifecycle Types — F257 Phase D Enhancement
 *
 * Read-model types for the version lifecycle chain:
 *   v1 → tracing → eval → governance → v2 → tracing → ...
 *
 * The chain is assembled at query time from existing stores
 * (InjectionTraceStore + HookOverrideStore + GuardRejectionEventLog).
 * No new write-path — pure projection.
 */

import type { SegmentEnablementMatrix } from '../utils/segment-enablement.js';

// ---------------------------------------------------------------------------
// Lifecycle event kinds
// ---------------------------------------------------------------------------

/**
 * Events that appear on the lifecycle chain.
 *
 * - auto-iterate:     governance approve → natural version bump
 * - user-create:      user manually creates a new version
 * - version-activate: user switches the active version
 * - user-edit:        user edits content of an existing version
 * - eval-pass:        eval judgment: keep / alive
 * - eval-reject:      eval judgment: needs attention
 * - governance-approve: governance decision to approve
 * - governance-reject:  operator-initiated disable (AF-5: distinct from eval-reject)
 */
export type LifecycleEventKind =
  | 'auto-iterate'
  | 'user-create'
  | 'version-activate'
  | 'user-edit'
  | 'eval-pass'
  | 'eval-reject'
  | 'governance-approve'
  | 'governance-reject';

/** A single event on the lifecycle chain. */
export interface LifecycleEvent {
  eventId: string;
  kind: LifecycleEventKind;
  timestamp: number;
  actorId: string;
  /** Short human-readable detail (e.g. "v1 → v2", "switched to v1"). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Stage summaries within a version epoch
// ---------------------------------------------------------------------------

/** Tracing stage summary: observation counts and time range. */
export interface TracingStageSummary {
  /**
   * Observed rows in the CURRENT query window (all pipelineStatus, incl.
   * observe-only). EXACT full-window aggregate (sol R6): the route scans all
   * matching rows for counting — only the DETAIL row list is capped
   * (see SegmentLifecycleResponse observationsCapped), never the counts.
   */
  observationCount: number;
  /**
   * 判据② P1 (sol R5): producer-semantics fired count — same predicate as
   * segment-judgment-engine isFired (pipelineStatus 'fired' or legacy missing).
   * NEVER conflate with observationCount: observe-only rows are observations,
   * not injections. EXACT (same full-window scan as observationCount).
   */
  firedCount: number;
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * 判据② P2 (sol R5): why a provenance field is null.
 * 'legacy-missing' = pre-6c cache entry never had the field;
 * 'invalid-present' = field was present but malformed (forgery-grade input,
 * failed closed at the read seam). The UI must not mislabel one as the other.
 */
export type ProvenanceGapKind = 'legacy-missing' | 'invalid-present';

// ---------------------------------------------------------------------------
// Segment verdict vocabulary (judgment-schema-v1 §2, frozen)
// ---------------------------------------------------------------------------

/**
 * Canonical per-segment eval verdict vocabulary — single source of truth shared by
 * the judgment engine (producer) and the Console (renderer). A new verdict fails
 * closed at compile time (`satisfies Record<SegmentVerdict, …>` / exhaustive switch)
 * instead of silently rendering with no explanation.
 *
 * Domain note: this is the SEGMENT verdict (judgment-schema-v1 §2). It is DISTINCT
 * from the Eval Hub verdict-handoff vocabulary (fix | build | keep_observe |
 * delete_sunset) — do not conflate the two.
 */
export const SEGMENT_VERDICTS = [
  'alive',
  'dormant',
  'unmeasurable',
  'observability-debt',
  'needs-denominator',
  'retire-candidate',
] as const;
export type SegmentVerdict = (typeof SEGMENT_VERDICTS)[number];

/** Eval stage summary: latest judgment result or null if not yet evaluated. */
export interface EvalStageSummary {
  verdict: SegmentVerdict | null;
  injectionCount: number;
  violationCount: number;
  evaluatedAt: number | null;
  /**
   * 判据② (F257 #6 slice 6c): the judgment's OWN eval sampling window
   * [startMs, endMs) — NEVER the lifeline query window. `evaluatedAt` is a
   * point in time, not a window substitute.
   * null = legacy cached judgment without provenance (fail-visible "评估窗口未知").
   */
  evalWindow: { startMs: number; endMs: number } | null;
  /** 判据② P2: why evalWindow is null (legacy vs corrupted). null when evalWindow is present. */
  evalWindowGap: ProvenanceGapKind | null;
  /**
   * 判据②: denominator semantics of injectionCount/violationCount.
   * null = legacy cached judgment (fail-visible "分母未知").
   */
  denominatorKind: 'fired-count' | 'session-count' | 'none' | null;
  /** 判据② P2: why denominatorKind is null (legacy vs corrupted). null when present. */
  denominatorGap: ProvenanceGapKind | null;
}

/** Governance stage summary: decision state. */
export interface GovernanceStageSummary {
  decision: 'approved' | 'pending' | null;
  decidedAt: number | null;
  actorId: string | null;
}

// ---------------------------------------------------------------------------
// Version epoch — one node in the chain
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of a version epoch.
 *
 * idle:               segment exists but has no trace data yet
 * tracing:            actively being observed (has observations)
 * eval-pending:       tracing complete, awaiting eval
 * eval-pass:          eval passed
 * eval-reject:        eval rejected → will re-enter tracing
 * governance-pending: eval passed, awaiting governance
 * governance-approved: governance approved → may produce next version
 */
export type VersionEpochStatus =
  | 'idle'
  | 'tracing'
  | 'eval-pending'
  | 'eval-pass'
  | 'eval-reject'
  | 'governance-pending'
  | 'governance-approved';

/** How this version was created. */
export type VersionOrigin = 'manifest' | 'auto-iterate' | 'user-create';

/** A single version epoch in the lifecycle chain. */
export interface VersionEpoch {
  version: number;
  origin: VersionOrigin;
  startedAt: number;
  status: VersionEpochStatus;
  isActive: boolean;
  tracing: TracingStageSummary | null;
  eval: EvalStageSummary | null;
  governance: GovernanceStageSummary | null;
  events: LifecycleEvent[];
}

// ---------------------------------------------------------------------------
// API response
// ---------------------------------------------------------------------------

/** Per-guard event count attributed to an epoch via activation timeline. */
export interface GuardMetric {
  guardId: string;
  count: number;
}

// ---------------------------------------------------------------------------
// 判据① — activeStage / actionableStage (cycle read model, F257 #6 slice 6b)
// ---------------------------------------------------------------------------

/**
 * The REAL stage of the lifecycle loop for the ACTIVE version (判据①).
 *
 * The loop is NOT a one-way pipeline: an eval that cannot conclude
 * (`unmeasurable` / `observability-debt` / `needs-denominator`) or rejects
 * (`retire-candidate`) returns the cycle to `tracing`. Only a conclusive
 * `alive` / `dormant` verdict parks the cycle at `governance` (informational —
 * being AT governance implies no operator action by itself).
 */
export type ActiveStage = 'tracing' | 'governance';

/**
 * Actionable derivation (判据①): a stage is actionable ONLY when real pending
 * governance Candidates exist — never inferred from a synthesized
 * `governance.decision === 'pending'` (that false signal caused the original
 * incident: operator saw "pending" with no candidate to review).
 *
 * `source: 'unavailable'` is the honest provenance gap: the Candidate
 * projection is not wired yet, so `candidateCount` is null (UNKNOWN, not 0)
 * and the UI must say "cannot determine" instead of guessing.
 */
export interface ActionableInfo {
  /** Stage awaiting an operator decision; null when 0 candidates or unknown. */
  stage: 'governance' | null;
  /** Real pending Candidate count; null = candidate projection unavailable. */
  candidateCount: number | null;
  /** Provenance of this derivation. */
  source: 'candidate-count' | 'unavailable';
}

/** A single raw observation returned alongside the lifecycle chain. */
export interface SegmentObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

/** A single guard rejection event correlated to the query window. */
export interface SegmentGuardEvent {
  eventId: string;
  kind: string;
  threadId: string;
  catId: string;
  timestamp: number;
  guardId: string;
  /** Window-correlated, not causally linked. */
  attribution?: 'window-correlated';
}

/** Full lifecycle response for GET /api/segment-lifeline/:segmentId. */
export interface SegmentLifecycleResponse {
  segmentId: string;
  segmentName: string;
  activeVersion: number;
  chain: VersionEpoch[];
  /** Backward-compat status summary. */
  currentStatus: 'idle' | 'tracing' | 'evaluated';
  /** 判据①: real loop stage of the active version (unmeasurable → tracing). */
  activeStage: ActiveStage;
  /** 判据①: actionable only via real pending Candidates (honest gap when unwired). */
  actionable: ActionableInfo;
  /**
   * The CURRENT lifeline QUERY window [startMs, endMs) — used for tracing
   * observations/guard events. 判据②: distinct coordinate from each epoch's
   * `eval.evalWindow` (the judgment's OWN historical sampling window); the UI
   * must label them separately, never as one context.
   */
  window: { startMs: number; endMs: number };
  /** Raw observations in the query window (detail list, capped separately). */
  observations: SegmentObservation[];
  /** True when the detail list was truncated; aggregate counts remain exact. */
  observationsCapped?: boolean;
  /** Guard events in the query window. */
  guardEvents: SegmentGuardEvent[];
  /** Current runtime override state (null = manifest baseline). */
  overrideState: { hookId: string; enabled: boolean; contentVersion: number | null } | null;
  /** Guard events attributed to each epoch via activation timeline (R16). */
  epochGuardMetrics: Record<number, GuardMetric[]>;
  /** F257 Console 判据⑥: unified enablement matrix for CTA states and blocked reasons. */
  enablementMatrix: SegmentEnablementMatrix;
}

// ---------------------------------------------------------------------------
// 判据④ — Tracing 真现场回放 (F257 Console)
// ---------------------------------------------------------------------------

/** Provenance gap taxonomy for replay fields. */
export type ReplayProvenanceGap = 'legacy-missing' | 'invalid-present' | 'unavailable';

/** How the rendered segment content was actually produced at event time. */
export type SegmentContentSourceKind =
  | 'template'
  | 'override'
  | 'content-var'
  | 'file-fallback'
  | 'native-l0'
  | 'aggregate'
  | null;

/**
 * Durable, owner-scoped replay snapshot for F257 Console criterion ④.
 *
 * Separated from the compact InjectionTraceSummary so that summary stays
 * small (counts/hashes/anchors) while replay retains event-time content and
 * context. TTL=0 by default — user-visible recoverable data.
 */
export interface ReplaySnapshot {
  segmentId: string;
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  stage: 'session-init' | 'per-turn';
  pipelineStatus: string;
  version: number | null;

  // Content + source truth (P1-3)
  content: string | null;
  contentSourceKind: SegmentContentSourceKind;
  contentSourceRef: string | null;
  templateVars: Record<string, string> | null;

  // Event-time conversation anchors (P1-1)
  /** The incoming message this segment was injected for (user msg or A2A trigger). */
  messageAnchorId: string | null;
  /** Message IDs of the surrounding context captured at event time. */
  surroundingMessageIds: string[];
  /**
   * Structured completeness gap for the captured context. Persisted alongside the
   * IDs so the replay route can honestly surface unavailable/legacy-missing context
   * instead of faking a complete empty set.
   */
  surroundingMessagesGap: ReplayProvenanceGap | null;

  // Ownership (P1-2)
  ownerUserId: string;
}

/** A single message in the surrounding conversation context. */
export interface ReplaySurroundingMessage {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  catId?: string | null;
  contentPreview: string;
  timestamp: number;
}

/** Guard event in the replay scene. */
export interface ReplayGuardEvent {
  eventId: string;
  kind: string;
  guardId: string;
  catId: string;
  timestamp: number;
  /** Window-correlated, not causally linked. */
  attribution: 'window-correlated';
}

/** Full replay response for GET /api/segment-lifeline/:segmentId/replay. */
export interface SegmentReplayResponse {
  segmentId: string;
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  stage: 'session-init' | 'per-turn';
  pipelineStatus: string;
  version: number | null;
  versionGap: ReplayProvenanceGap | null;
  content: string | null;
  contentGap: ReplayProvenanceGap | null;
  contentSourceKind: SegmentContentSourceKind;
  contentSourceKindGap: ReplayProvenanceGap | null;
  templateRef: string | null;
  templateRefGap: ReplayProvenanceGap | null;
  templateVars: Record<string, string> | null;
  templateVarsGap: ReplayProvenanceGap | null;
  messageAnchorId: string | null;
  messageAnchorIdGap: ReplayProvenanceGap | null;
  surroundingMessages: ReplaySurroundingMessage[] | null;
  surroundingMessagesGap: ReplayProvenanceGap | null;
  guardEvents: ReplayGuardEvent[];
  guardEventsGap: ReplayProvenanceGap | null;
}
