/**
 * F167 Phase O PR-O2: Claim Grounding Types
 *
 * Runtime type definitions for the handoff claim grounding telemetry system.
 * Spec source: cat-cafe-skills/receive-handoff-grounding/refs/claim-schema.md
 *
 * PR-O2 scope: shadow telemetry (emit events + counters, never block).
 * PR-O3/O4 will add enforcement on top of this infrastructure.
 */

// ── Enums ──────────────────────────────────────────────────────

export type ClaimType = 'owner' | 'auth' | 'object' | 'wait' | 'route' | 'role' | 'freshness' | 'none';

export type AuthSubtype = 'cvo_signoff' | 'peer_instruction' | 'merge_approval';

export type IssuerStanding = 'cvo' | 'upstream_owner' | 'repo_admin' | 'pr_reviewer' | 'none';

export type SourceKind = 'cross_post' | 'mention' | 'reply_in_thread' | 'cvo_message' | 'webhook' | 'self';

export type ActionFamily =
  | 'read_intent'
  | 'wait'
  | 'register_tracking'
  | 'mutate_local'
  | 'merge'
  | 'cvo_claim'
  | 'takeover'
  | 'irreversible'
  | 'owner_reassignment';

export type ActionRisk = 'read_only' | 'mutate_local' | 'register_tracking' | 'hold_ball' | 'destructive';

export type SourceTier = 'T0' | 'T1' | 'T2';

/** Claim-level verdict (three-state terminal). */
export type Verdict = 'verified' | 'mismatch' | 'insufficient';

/** Per-resolver outcome; 'not_applicable' triggers next-resolver attempt (INV-O8). */
export type ResolverOutcome = Verdict | 'not_applicable';

// ── Source Reference ───────────────────────────────────────────

export interface SourceRef {
  kind: 'messageId' | 'pr_url' | 'issue_id' | 'feature_path' | 'task_id' | 'webhook_id' | 'commit_sha';
  value: string;
  status?: string;
  headSha?: string;
}

// ── WaitSourceRef (R3.1 OQ-5) ─────────────────────────────────

export interface WaitSourceRef {
  kind: 'github_issue' | 'github_comment' | 'thread_message' | 'task' | 'reporter_handle' | 'pending_input';
  value: string;
  /** REQUIRED when kind ∈ {'reporter_handle', 'pending_input'} */
  anchorRef?: string;
  expectedSignal: string;
  /** REQUIRED — no SLA = no hold, route to needs-info/sweep. */
  slaUntilMs: number;
}

// ── Per-resolver result ───────────────────────────────────────

export interface ResolverResult {
  resolver: string;
  outcome: ResolverOutcome;
  sourceTier: SourceTier;
  freshnessKey?: string;
  cacheHit: boolean;
  reason?: string;
}

// ── Claim Grounding Event ─────────────────────────────────────

export interface ClaimGroundingEvent {
  // Identity
  invocationId: string;
  catId: string;
  threadId: string;
  sourceThreadId?: string;

  // Claim (Q1)
  claimType: ClaimType;
  authSubtype?: AuthSubtype;
  sourceKind: SourceKind;
  sourceRef: SourceRef;
  claimSummary?: string;

  // Resolver (Q2) — per-resolver detail
  resolver: string;
  resolverSourceTier: SourceTier;
  freshnessKey?: string;
  cacheHit: boolean;

  // Verdict (Q3) — claim-level terminal
  verdict: Verdict;
  verdictReason?: string;

  // Action context
  actionFamily: ActionFamily;
  actionRisk: ActionRisk;
  tool: string;
  threadKind?: 'concierge' | 'gate-keeping' | null;

  // OQ-5 (wait actions)
  waitSourceRef?: WaitSourceRef;

  // OQ-6 (tracking actions, PR-O3 implement)
  ownershipState?: 'keeper_owned' | 'distributed' | 'unknown';

  // R4 (peer instruction / owner reassignment)
  issuerStanding?: IssuerStanding;

  // Soft trigger hint (OQ-4)
  keywordHintMatched?: string[];

  // Observability
  ts: number;
  resolverCallsRemaining: number;
}

// ── Grounding Check Context (input to checker) ────────────────

export interface GroundingCheckContext {
  invocationId: string;
  catId: string;
  threadId: string;
  sourceThreadId?: string;
  tool: string;
  actionFamily: ActionFamily;
  actionRisk: ActionRisk;
  threadKind?: 'concierge' | 'gate-keeping' | null;
  /** Claims extracted from the handoff context. */
  claims: ClaimInput[];
}

export interface ClaimInput {
  claimType: ClaimType;
  authSubtype?: AuthSubtype;
  sourceKind: SourceKind;
  sourceRef: SourceRef;
  claimSummary?: string;
  issuerStanding?: IssuerStanding;
  waitSourceRef?: WaitSourceRef;
}

// ── Grounding Check Result (output from checker) ──────────────

export interface GroundingCheckResult {
  /** Overall verdict across all claims. */
  overallVerdict: Verdict;
  /** Per-claim results. */
  claimResults: ClaimResult[];
  /** Shadow mode: what WOULD have happened if enforcement was on. */
  wouldBlock: boolean;
  /** Total resolver calls consumed. */
  resolverCallsConsumed: number;
  /** Events emitted (for sample storage). */
  events: ClaimGroundingEvent[];
}

export interface ClaimResult {
  claim: ClaimInput;
  resolverResults: ResolverResult[];
  verdict: Verdict;
  verdictReason?: string;
}

// ── Resolver Budget ───────────────────────────────────────────

export interface ResolverBudget {
  /** Total calls allowed per grounding check. */
  total: number;
  /** Calls consumed so far. */
  consumed: number;
  /** Remaining calls. */
  remaining(): number;
  /** Consume one call. Returns false if budget exhausted. */
  consume(): boolean;
  /** INV-O7: refund a consumed call (cache hits don't count against budget). */
  refund(): void;
}

// ── Resolver Cache Entry ──────────────────────────────────────

export interface ResolverCacheEntry {
  outcome: ResolverOutcome;
  sourceTier: SourceTier;
  freshnessKey?: string;
  cachedAt: number;
  ttlMs: number;
}
