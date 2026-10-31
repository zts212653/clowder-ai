import type { Redis } from 'ioredis';
import type { FrictionAnalysisFindingInputV1 } from '../friction/friction-finding-artifact.js';
import type { FrictionVerdictHandoffPacketV3, VerdictHandoffPacket } from '../verdict-handoff.js';
import type { VerdictSourceRefs } from './verdict-source-types.js';

export type {
  A2aSnapshotAttributionRefs,
  AnchorTelemetrySourceSelector,
  MemoryRecallSourceSelector,
  SopTraceSourceSelector,
  TaskOutcomeSnapshotSourceRefs,
  VerdictSourceRefs,
} from './verdict-source-types.js';

/**
 * F192 Phase H — Verdict Publishing Pipeline types.
 * Extracted from publish-verdict.ts per AGENTS.md 350-line hard limit.
 */

export interface StageResult {
  /** Absolute paths under the isolated worktree to `git add`. */
  paths: string[];
  commitMessage: string;
  prTitle: string;
  prBody: string;
  /**
   * F192 Phase H 收尾 PR-3 (砚砚 R2): per-PR labels driven by `computePublishPolicy`.
   * GitPublisher passes each as `--label X` to `gh pr create`. Omit/empty → no labels.
   * Standard labels:
   *   - `evidence-only`: artifact-only PR; merge gate is artifact-only-pr-merge-gate (SOP),
   *     not full pnpm gate. NOT a regular code review request.
   *   - `no-action-needed`: keep_observe verdict with noFindingRecord — interim per-run PR;
   *     rollup mechanism deferred to future Phase.
   */
  labels?: string[];
  /** Exact-commit GitHub statuses emitted after every local publication contract passes. */
  statusChecks?: VerdictCommitStatus[];
  /**
   * Optional live side effect that runs after commit/push/PR creation succeeds
   * but before the publisher returns success. If it fails, the publisher must
   * clean up the newly exposed PR/branch before surfacing the error.
   */
  afterPublish?: () => void | Promise<void>;
}

export interface PublishOnIsolatedWorktreeOpts {
  branchName: string;
  sourceBase: string; // e.g. 'origin/main'
  /** Generator + artifact production happens inside the isolated worktree. */
  stage: (worktreeRoot: string) => Promise<StageResult>;
}

export interface RefreshPublishedVerdictPrOpts {
  branchName: string;
  verdictId: string;
  expectedHeadSha: string;
  generatedAt: string;
  refreshDerivedCensus: (worktreeRoot: string, generatedAt: string, cleanSource: string) => string;
}

export interface RefreshPublishedVerdictPrResult {
  outcome: 'updated' | 'already_current';
  previousHeadSha: string;
  commitSha: string;
  baseSha: string;
  prUrl: string;
}

export interface ResolvePublishedOnIsolatedWorktreeOpts {
  branchName: string;
  sourceMessageId: string;
  /** Exact repo-relative paths that the recovered one-commit publication may contain. */
  expectedPaths: string[];
  /** Domain validation over the immutable published commit, never the live worktree. */
  validate: (worktreeRoot: string) => Promise<void>;
}

export interface GitPublisher {
  publishOnIsolatedWorktree(opts: PublishOnIsolatedWorktreeOpts): Promise<{ commitSha: string; prUrl: string }>;
  resolvePublishedOnIsolatedWorktree?(
    opts: ResolvePublishedOnIsolatedWorktreeOpts,
  ): Promise<{ commitSha: string; prUrl: string } | undefined>;
  refreshPublishedVerdictPr?(opts: RefreshPublishedVerdictPrOpts): Promise<RefreshPublishedVerdictPrResult>;
}

/**
 * Resolved evidence source paths (a2a only — for backward-compat helpers in validation.ts).
 * 砚砚 R7 cloud: resolved INSIDE isolated worktree so paths live in-repo for provenance.
 *
 * cw adapter does NOT use this — it resolves selector → trials via provider port.
 */
export interface ResolvedSourceRefs {
  snapshotPath: string;
  attributionPath: string;
}

/**
 * Generator contract — produces verdict.md + bundle/ for the packet's domain.
 *
 * F192 Phase H 收尾 PR-2 (砚砚 R1 Q1): adapter is self-contained — receives RAW
 * `sourceRefs` (not pre-resolved) and both roots (live + isolated). Each adapter:
 * - a2a: validate basenames, resolve in live root, copy to isolated root, call generateA2aLiveVerdict
 * - capability-wakeup: validate selector, provider.resolve(selector) → trials, call generateCapabilityWakeupLiveVerdict
 *
 * Handler stays domain-agnostic (砚砚 R1 P1: route layer dispatches single generator
 * via eval-hub.ts opts.verdictGenerators[domainId]).
 */
export interface GeneratedFindingArtifact {
  candidateRef: string;
  findingKey: string;
  artifactRef: string;
  artifactSha256: string;
  resolutionStatus: 'resolved' | 'blocked';
  blockerReason?: 'owner_unresolved' | 'owner_ambiguous' | 'target_mismatch';
}

export interface GeneratedVerdictChildArtifact {
  verdictId: string;
  findingKey: string;
  verdictPath: string;
  bundleDir: string;
  findingArtifactRef: string;
  findingArtifactSha256: string;
  packet: FrictionVerdictHandoffPacketV3;
}

export interface GeneratedVerdictArtifact {
  verdictPath: string;
  bundleDir: string;
  findingArtifacts?: GeneratedFindingArtifact[];
  childArtifacts?: GeneratedVerdictChildArtifact[];
  extraStagedPaths?: string[];
  afterPublish?: () => void | Promise<void>;
}

export type VerdictGenerator = (
  packet: VerdictHandoffPacket,
  sourceRefs: VerdictSourceRefs,
  deps: GeneratorDeps,
) => Promise<GeneratedVerdictArtifact>;

export interface GeneratorDeps {
  /** ISOLATED worktree's docs/harness-feedback — where generator writes verdict.md + bundle. */
  harnessFeedbackRoot: string;
  /** LIVE checkout's docs/harness-feedback — a2a needs this to read raw snapshot/attribution YAML
   *  that are gitignored from origin/main (砚砚 R17 P1 cloud). cw doesn't use it. */
  liveHarnessFeedbackRoot: string;
  /** Server-owned clock sampled once per publish request and shared with timestamp validation. */
  publicationTime: string;
  /** Server-trusted callback principal userId for owner-scoped evidence reads. */
  ownerUserId?: string;
  /** Runtime-configured task-outcome DB path (trusted server config, may be absolute). */
  taskOutcomeDbPath?: string;
  /** Runtime-configured event-memory DB path (trusted server config, may be absolute). */
  eventMemoryDbPath?: string;
  /** Parsed eval:friction judgments. Other generators never receive this field. */
  analysisFindings?: readonly FrictionAnalysisFindingInputV1[];
}

export interface PublishVerdictDeps {
  signal?: AbortSignal;
  harnessFeedbackRoot: string;
  /** AC-H2 + 砚砚 R1 P1 #1: isolated publish worktree (default throws). */
  gitPublisher?: GitPublisher;
  /** AC-H2: domain-specific generator (default throws — route-layer must inject per-domain). */
  generator?: VerdictGenerator;
  /** 砚砚 R6 P1: Redis client for OQ-20 eval-cat overrides (symmetric with trigger-now). */
  redis?: Redis;
  /** Runtime-configured task-outcome DB path (trusted server config, may be absolute). */
  taskOutcomeDbPath?: string;
  /** Runtime-configured event-memory DB path (trusted server config, may be absolute). */
  eventMemoryDbPath?: string;
  /** Test seam for the single server publication clock. */
  now?: () => Date;
  /**
   * Domain-specific replay identity preflight (R3). Scans live-tree bundles for
   * window collision with source-equivalence discrimination. When provided,
   * replays are caught BEFORE publishOnIsolatedWorktree → zero side effects.
   * Domains without this function fall through to the publisher + catch block.
   */
  replayPreflight?: ReplayPreflight;
  /**
   * Domain-specific source equivalence check for catch-block defense layer (R3).
   * When the contract runner throws verdict_window_already_published and the
   * preflight missed it (stale live tree), this function verifies whether the
   * incoming sourceRefs match the stored verdict's source identity. Without this
   * function, all window collisions fail closed as 409.
   */
  checkStoredSourceEquivalence?: SourceEquivalenceCheck;
  /**
   * R6: Optional pre-created FreshMainReader for testing. When provided, the
   * handler uses this instead of creating one from resolveRepoRoot. Production
   * callers omit this (handler creates internally); tests inject a mock.
   */
  mainReader?: FreshMainReader;
  /**
   * R8: Optional factory for post-collision re-resolution. Publisher collision
   * is evidence that origin/main may have advanced after the pre-publish snapshot.
   * Production callers omit this (handler creates from resolveRepoRoot); tests
   * inject a mock to simulate origin/main advancing during publish.
   */
  createFreshMainReader?: () => FreshMainReader | undefined | Promise<FreshMainReader | undefined>;
}

export interface VerdictCommitStatus {
  context: string;
  state: 'success';
  description: string;
}

export interface PublishVerdictInput {
  packet: unknown; // user-supplied — strict validation via VerdictHandoffPacket
  domain: string; // must match packet.domainId
  /** AC-H3: catId derived from callback auth at MCP server layer. */
  catId: string;
  /** Server-trusted callback principal userId (not user-supplied). */
  ownerUserId?: string;
  /**
   * Invocation-authenticated source thread ID. Derived from CallbackPrincipal.threadId
   * at the route layer — NEVER from client body (prevents forgery). Stamped into
   * provenance.json and PR body for traceability. Absent for agent_key principals.
   */
  sourceThreadId?: string;
  /** 砚砚 R1 P1 #2: explicit evidence refs (sanitized YAML basenames OR replayable selector). Tool NEVER fabricates. */
  sourceRefs: VerdictSourceRefs;
  /** eval:friction only: caller judgments plus feature/component hints; routing truth is server-resolved. */
  analysisFindings?: unknown;
}

export interface PublishedVerdictChildArtifact {
  verdictId: string;
  findingKey: string;
  verdictPath: string;
  bundleDir: string;
  findingArtifactRef: string;
  findingArtifactSha256: string;
  lifecycleRootSha256: string;
}

export interface PublishVerdictSuccess {
  ok: true;
  verdictPath: string;
  bundleDir: string;
  commitSha: string;
  prUrl: string;
  findingArtifacts: GeneratedFindingArtifact[];
  childArtifacts: PublishedVerdictChildArtifact[];
}

/**
 * F192 typed success for exact replay: the same verdict (by packet ID or by
 * window+source identity) already exists on origin/main. Zero side effects
 * (no worktree, no commit, no push, no PR). Callers distinguish this from
 * errors by `ok: true`.
 */
export interface PublishVerdictNoNewWindow {
  ok: true;
  outcome: 'no_new_window';
  canonicalVerdictId: string;
}

/**
 * Domain-specific replay identity preflight. Scans live-tree bundles for a
 * window collision, then compares source identity to distinguish exact replays
 * from real conflicts.
 *
 * Returns 'replay' with the stored verdict ID for exact replays (same source,
 * same window → no_new_window, publisher skipped entirely).
 * Returns 'conflict' for different-source same-window collisions (→ 409).
 * Returns null if no collision detected on the live tree (proceed to publish).
 *
 * Domains that cannot produce a comparable canonical identity omit this
 * function; the handler falls through to the publisher and fails closed
 * via the contract runner's assertWindowsUnpublished (→ 409).
 */
export type ReplayPreflightResult =
  | { kind: 'replay'; storedVerdictId: string }
  | { kind: 'conflict'; storedVerdictId: string; detail: string };

export type ReplayPreflight = (
  sourceRefs: VerdictSourceRefs,
  ctx: { harnessFeedbackRoot: string; domainId: string; mainReader?: FreshMainReader },
) => ReplayPreflightResult | null | Promise<ReplayPreflightResult | null>;

/**
 * Domain-specific source equivalence check for the catch-block defense layer.
 * When the contract runner throws verdict_window_already_published (live tree
 * missed the collision), this function reads the stored bundle on the live tree
 * and compares source identity against the incoming sourceRefs.
 *
 * Returns true for exact replays (same source). Returns false for different
 * source (real conflict). Throws if the stored bundle is incomplete/orphan
 * (fail closed → 409).
 */
export type SourceEquivalenceCheck = (
  storedVerdictId: string,
  incomingSourceRefs: VerdictSourceRefs,
  ctx: { harnessFeedbackRoot: string; mainReader?: FreshMainReader },
) => boolean | Promise<boolean>;

/**
 * R4: Optional reader for origin/main bundle data. When provided, preflight
 * and equivalence checks scan both live tree and freshly fetched origin/main,
 * enabling stale-live-tree replay detection without entering the publisher.
 */
export interface FreshMainReader {
  /** List bundle directory names under docs/harness-feedback/bundles/ on origin/main. */
  listBundleEntries(): string[] | Promise<string[]>;
  /** Read a file relative to docs/harness-feedback/ on origin/main. Returns null if not found. */
  readFile(relativePath: string): string | null | Promise<string | null>;
}

export interface HandlerError {
  status: number;
  error: string;
  detail?: string;
}
