/**
 * F202 Phase 2B: GitHub Schedule Factories
 *
 * Wraps GitHub poller TaskSpec factories as ScheduleFactory implementations
 * for registration in ScheduleFactoryRegistry. Each factory extracts typed deps from the
 * generic ScheduleFactoryDeps bag and delegates to the existing createXxxTaskSpec function.
 *
 * KD-3: All factories are white-listed by factoryId — no arbitrary script loading.
 * KD-7: Poller logic unchanged — factories only wire deps and override task ID.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import type { IConnectorThreadBindingStore } from '../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { ReconciliationDedup } from '../../infrastructure/connectors/github-repo-event/ReconciliationDedup.js';
import type { RepoIssueComment } from '../../infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import { repoCommentPollTaskSpec } from '../../infrastructure/connectors/github-repo-event/RepoCommentPollTaskSpec.js';
import type { GhIssueItem, GhPrItem } from '../../infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createRepoScanTaskSpec } from '../../infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import { createCiCdCheckTaskSpec } from '../../infrastructure/email/CiCdCheckTaskSpec.js';
import type { CiCdRouter, CiPollResult } from '../../infrastructure/email/CiCdRouter.js';
import type { ConflictAutoExecutor } from '../../infrastructure/email/ConflictAutoExecutor.js';
import { createConflictCheckTaskSpec } from '../../infrastructure/email/ConflictCheckTaskSpec.js';
import type { ConflictRouter } from '../../infrastructure/email/ConflictRouter.js';
import type { ConnectorInvokeTrigger } from '../../infrastructure/email/ConnectorInvokeTrigger.js';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
  ConnectorDeliveryResult,
} from '../../infrastructure/email/deliver-connector-message.js';
import type { IssueComment, IssueCommentRouter } from '../../infrastructure/email/IssueCommentRouter.js';
import { createIssueCommentTaskSpec } from '../../infrastructure/email/IssueCommentTaskSpec.js';
import type {
  PrFeedbackComment,
  PrReviewDecision,
  ReviewFeedbackRouter,
} from '../../infrastructure/email/ReviewFeedbackRouter.js';
import type { ReviewFeedbackPrMetadata } from '../../infrastructure/email/ReviewFeedbackTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../../infrastructure/email/ReviewFeedbackTaskSpec.js';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ICommunityEventLog } from '../community/CommunityEventLog.js';
import type { ScheduleFactory, ScheduleFactoryDeps, ScheduleFactoryRegistry } from './ScheduleFactoryRegistry.js';

/** Minimal projector interface for optional DI in factories — avoids importing concrete class. */
interface IFactoryProjectorMin {
  apply(event: Parameters<ICommunityEventLog['append']>[0]): Promise<void>;
}

/**
 * Typed dep extraction for GitHub schedule factories.
 *
 * Extends the generic ScheduleFactoryDeps with all services needed by the 4 pollers.
 * Assembled in index.ts where these services are created.
 */
export interface GitHubScheduleDeps extends ScheduleFactoryDeps {
  taskStore: ITaskStore;
  cicdRouter: CiCdRouter;
  fetchPrStatus?: (repoFullName: string, prNumber: number) => Promise<CiPollResult | null>;
  conflictRouter: ConflictRouter;
  reviewFeedbackRouter: ReviewFeedbackRouter;
  invokeTrigger: ConnectorInvokeTrigger;
  /** #949: Thread store for MR review thread rotation (create fresh threads when context overflows) */
  threadStore?: Pick<IThreadStore, 'create' | 'get'>;
  checkMergeable: (repo: string, pr: number) => Promise<{ mergeState: string; headSha: string }>;
  autoExecutor: ConflictAutoExecutor;
  fetchPrMetadata: (repo: string, pr: number) => Promise<ReviewFeedbackPrMetadata | null>;
  fetchComments: (repo: string, pr: number, sinceId?: number) => Promise<PrFeedbackComment[]>;
  fetchReviews: (repo: string, pr: number, sinceId?: number) => Promise<PrReviewDecision[]>;
  isEchoComment: (c: PrFeedbackComment) => boolean;
  isEchoReview: (r: PrReviewDecision) => boolean;
  isNoiseComment: (c: PrFeedbackComment) => boolean;
  // repo-scan deps — optional, not available when redis is not configured
  repoAllowlist?: string[];
  inboxCatId?: string;
  defaultUserId?: string;
  reconciliationDedup?: Pick<
    ReconciliationDedup,
    'isNotified' | 'markNotified' | 'isBaselineEstablished' | 'markBaselineEstablished'
  >;
  bindingStore?: Pick<IConnectorThreadBindingStore, 'getByExternal'>;
  deliverFn?: (deps: ConnectorDeliveryDeps, input: ConnectorDeliveryInput) => Promise<ConnectorDeliveryResult>;
  deliveryDeps?: ConnectorDeliveryDeps;
  fetchOpenPRs?: (repo: string) => Promise<GhPrItem[]>;
  fetchOpenIssues?: (repo: string) => Promise<GhIssueItem[]>;
  // F202 Phase 2D: issue comment tracking deps
  issueCommentRouter?: IssueCommentRouter;
  fetchIssueComments?: (repoFullName: string, issueNumber: number, sinceId?: number) => Promise<IssueComment[]>;
  fetchIssueState?: (repoFullName: string, issueNumber: number) => Promise<'open' | 'closed'>;
  isEchoIssueComment?: (c: IssueComment) => boolean;
  /**
   * F168 Phase A P1-1 fix: community event services.
   * Provided by index.ts when Redis is available; factories thread them to spec constructors.
   */
  eventLog?: ICommunityEventLog;
  projector?: IFactoryProjectorMin;
  /**
   * F168 Phase C C0.3: repo-level comment poller deps.
   * Assembled in index.ts inside the same Redis+allowlist block as repo-scan, so
   * availability is identical to repo-scan (redis-gated). Collection-only: needs the
   * event log + a Redis-backed per-repo cursor (read/write), NOT the delivery deps
   * (inbox / reconciliationDedup / bindingStore) that repo-scan uses.
   */
  fetchRepoComments?: (repo: string, sinceIso?: string) => Promise<RepoIssueComment[]>;
  readRepoCommentCursor?: (repo: string) => Promise<string | undefined>;
  writeRepoCommentCursor?: (repo: string, cursor: string) => Promise<void>;
}

/** Cast ScheduleFactoryDeps to GitHubScheduleDeps with runtime validation */
function asGitHub(deps: ScheduleFactoryDeps): GitHubScheduleDeps {
  const d = deps as GitHubScheduleDeps;
  if (!d.taskStore) throw new Error('[F202-2] GitHub schedule factory requires taskStore in deps');
  return d;
}

const cicdCheckFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.cicd-check',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createCiCdCheckTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      cicdRouter: d.cicdRouter,
      fetchPrStatus: d.fetchPrStatus,
      invokeTrigger: d.invokeTrigger,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

const conflictCheckFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.conflict-check',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createConflictCheckTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      checkMergeable: d.checkMergeable,
      conflictRouter: d.conflictRouter,
      invokeTrigger: d.invokeTrigger,
      autoExecutor: d.autoExecutor,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

const reviewFeedbackFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.review-feedback',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    return createReviewFeedbackTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      fetchPrMetadata: d.fetchPrMetadata,
      fetchComments: d.fetchComments,
      fetchReviews: d.fetchReviews,
      reviewFeedbackRouter: d.reviewFeedbackRouter,
      invokeTrigger: d.invokeTrigger,
      log: d.log,
      isEchoComment: d.isEchoComment,
      isEchoReview: d.isEchoReview,
      isNoiseComment: d.isNoiseComment,
      // F168 Phase A P1-1: thread community event services to spec
      eventLog: d.eventLog,
      projector: d.projector,
      // #949: thread rotation deps
      threadStore: d.threadStore,
    }) as TaskSpec_P1;
  },
};

const repoScanFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.repo-scan',
  createTaskSpec(instanceId, deps) {
    const d = deps as GitHubScheduleDeps;
    // repo-scan needs redis-dependent deps — validate before construction
    if (!d.repoAllowlist || !d.inboxCatId || !d.defaultUserId) {
      throw new Error(
        '[F202-2] github.repo-scan requires repoAllowlist, inboxCatId, defaultUserId in deps. ' +
          'Set GITHUB_REPO_ALLOWLIST and GITHUB_REPO_INBOX_CAT_ID environment variables.',
      );
    }
    if (!d.reconciliationDedup || !d.bindingStore || !d.deliverFn || !d.deliveryDeps) {
      throw new Error(
        '[F202-2] github.repo-scan requires redis-dependent deps (reconciliationDedup, bindingStore, deliverFn, deliveryDeps)',
      );
    }
    if (!d.fetchOpenPRs || !d.fetchOpenIssues) {
      throw new Error('[F202-2] github.repo-scan requires fetchOpenPRs and fetchOpenIssues in deps');
    }
    return createRepoScanTaskSpec({
      id: instanceId,
      repoAllowlist: d.repoAllowlist,
      inboxCatId: d.inboxCatId,
      defaultUserId: d.defaultUserId,
      reconciliationDedup: d.reconciliationDedup,
      bindingStore: d.bindingStore,
      deliverFn: d.deliverFn,
      deliveryDeps: d.deliveryDeps,
      invokeTrigger: d.invokeTrigger,
      fetchOpenPRs: d.fetchOpenPRs,
      fetchOpenIssues: d.fetchOpenIssues,
      log: d.log,
      // F168 Phase A P1-1: thread community event services to spec
      eventLog: d.eventLog,
      projector: d.projector,
    }) as TaskSpec_P1;
  },
};

const issueTrackingFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.issue-tracking',
  createTaskSpec(instanceId, deps) {
    const d = asGitHub(deps);
    if (!d.issueCommentRouter) {
      throw new Error('[F202-2] github.issue-tracking requires issueCommentRouter in deps');
    }
    if (!d.fetchIssueComments || !d.fetchIssueState) {
      throw new Error('[F202-2] github.issue-tracking requires fetchIssueComments and fetchIssueState in deps');
    }
    return createIssueCommentTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      issueCommentRouter: d.issueCommentRouter,
      fetchComments: d.fetchIssueComments,
      fetchIssueState: d.fetchIssueState,
      invokeTrigger: d.invokeTrigger,
      isEchoComment: d.isEchoIssueComment,
      log: d.log,
      // F168 Phase B Task 4: thread community event log for dual-cursor collection/delivery.
      // Without this, the dual-cursor code path in IssueCommentTaskSpec is never activated
      // and Task 4 is dead code in production. eventLog is optional — TaskSpec falls back
      // to single-cursor mode when undefined (backward-compat for tests without Redis).
      eventLog: d.eventLog,
      // Cloud R5 P1: thread projector so polled issue.commented events update the community
      // projection immediately (awaiting_external → in_progress, lastExternalActivityAt) —
      // matches ReviewFeedbackTaskSpec + repoScanFactory wiring.
      projector: d.projector,
    }) as TaskSpec_P1;
  },
};

/**
 * F168 Phase C C0.3: repo-level comment poller — closes the un-routed issue
 * follow-up-comment blind spot (IssueCommentTaskSpec only polls already-tracked
 * issues). Collection-only (append + project, never delivers), redis-gated (same
 * availability as repo-scan; deps assembled in the same index.ts block).
 */
const repoCommentPollFactory: ScheduleFactory = {
  pluginId: 'github',
  factoryId: 'github.repo-comment-poll',
  createTaskSpec(instanceId, deps) {
    const d = deps as GitHubScheduleDeps;
    if (!d.repoAllowlist || d.repoAllowlist.length === 0) {
      throw new Error(
        '[F168-C0.3] github.repo-comment-poll requires repoAllowlist in deps. Set GITHUB_REPO_ALLOWLIST.',
      );
    }
    if (!d.eventLog) {
      throw new Error('[F168-C0.3] github.repo-comment-poll requires eventLog (community event log) in deps');
    }
    if (!d.fetchRepoComments || !d.readRepoCommentCursor || !d.writeRepoCommentCursor) {
      throw new Error(
        '[F168-C0.3] github.repo-comment-poll requires fetchRepoComments + readRepoCommentCursor + writeRepoCommentCursor (Redis-backed cursor) in deps',
      );
    }
    return repoCommentPollTaskSpec({
      id: instanceId,
      eventLog: d.eventLog,
      projector: d.projector,
      fetchRepoComments: d.fetchRepoComments,
      repoAllowlist: d.repoAllowlist,
      readCursor: d.readRepoCommentCursor,
      writeCursor: d.writeRepoCommentCursor,
      log: d.log,
    }) as TaskSpec_P1;
  },
};

/** Register all 6 GitHub schedule factories in the registry. */
export function registerGitHubScheduleFactories(registry: ScheduleFactoryRegistry): void {
  registry.register(cicdCheckFactory);
  registry.register(conflictCheckFactory);
  registry.register(reviewFeedbackFactory);
  registry.register(repoScanFactory);
  registry.register(issueTrackingFactory);
  registry.register(repoCommentPollFactory);
}

/** Exported for testing — allows direct factory lookup without constructing a full registry. */
export const githubScheduleFactories = [
  cicdCheckFactory,
  conflictCheckFactory,
  reviewFeedbackFactory,
  repoScanFactory,
  issueTrackingFactory,
  repoCommentPollFactory,
] as const;

// --- F202-2B Migration helpers (P2-1 fix) ---

const MIGRATION_MARKER_PATH = '.cat-cafe/f202-phase2-github-schedule-migrated';

/**
 * Determine if the one-time GitHub schedule migration should run.
 *
 * Returns true only on first-ever startup after Phase B code is deployed.
 * Returns false if:
 * - A marker file exists (migration already ran)
 * - Any GitHub schedule entries already exist in capabilities (enabled or disabled)
 */
export function shouldRunGitHubScheduleMigration(
  projectRoot: string,
  existingCaps: CapabilitiesConfig | null,
): boolean {
  // If any GitHub schedule entries exist (enabled OR disabled), migration already ran
  const hasAnyGitHubSchedule = existingCaps?.capabilities.some((c) => c.type === 'schedule' && c.pluginId === 'github');
  if (hasAnyGitHubSchedule) return false;

  // One-time marker prevents re-enable after explicit disable
  const markerPath = join(projectRoot, MIGRATION_MARKER_PATH);
  return !existsSync(markerPath);
}

/** Write the one-time migration marker so migration won't re-run. */
export function markGitHubScheduleMigrationDone(projectRoot: string): void {
  const markerPath = join(projectRoot, MIGRATION_MARKER_PATH);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, new Date().toISOString());
}

/**
 * F168 C0.3 (cloud review R2 P1): one-time marker so backfillMissingGitHubScheduleEntries
 * runs exactly once per install. After it has run, a TARGET resource the operator later
 * disables is not resurrected on the next startup.
 */
const GITHUB_SCHEDULE_BACKFILL_MARKER_PATH = '.cat-cafe/f168-github-schedule-backfilled';

export function hasGitHubScheduleBackfillRun(projectRoot: string): boolean {
  return existsSync(join(projectRoot, GITHUB_SCHEDULE_BACKFILL_MARKER_PATH));
}

export function markGitHubScheduleBackfillDone(projectRoot: string): void {
  const markerPath = join(projectRoot, GITHUB_SCHEDULE_BACKFILL_MARKER_PATH);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, new Date().toISOString());
}

/** Repo-scan env deps that must be present for the schedule to actually run. */
const REPO_SCAN_REQUIRED_ENV = ['GITHUB_REPO_ALLOWLIST', 'GITHUB_REPO_INBOX_CAT_ID'] as const;
const REPO_SCAN_PENDING_REASON = 'deps-unavailable' as const;
/**
 * F168 C0.3: schedule resources whose factory construction needs Redis (+ repo env).
 * repo-scan and repo-comment-poll are assembled together in index.ts behind the same
 * `ghRepoAllowlist && ghInboxCatId && redisClient` guard, so their migration-time
 * availability is identical. Gated as pending until deps exist to avoid a ghost
 * "enabled" capability with no running task (P2-1).
 */
const REDIS_GATED_GITHUB_RESOURCES = new Set(['repo-scan', 'repo-comment-poll']);
/**
 * F168 C0.3 (cloud review R2 P1): schedule resources THIS version introduces and must
 * backfill into existing installs (the one-time migration already ran for them, so it
 * won't re-run). Deliberately excludes legacy resources — backfilling those would
 * resurrect a schedule the operator disabled before upgrading (disable physically removes
 * the capability row via removeCapabilityEntry). When a future version adds another
 * schedule, add it here AND bump the backfill marker so it backfills exactly once.
 */
const BACKFILL_TARGET_RESOURCES = new Set(['repo-comment-poll']);
const LEGACY_GITHUB_SCHEDULE_TASK_IDS = new Map([
  ['cicd-check', 'cicd-check'],
  ['conflict-check', 'conflict-check'],
  ['repo-scan', 'repo-scan'],
  ['review-feedback', 'review-feedback'],
]);

export interface GitHubMigrationScheduleEntry {
  id: string;
  type: 'schedule';
  enabled: boolean;
  source: 'cat-cafe';
  pluginId: 'github';
  scheduleTaskId: string;
  migrationPendingReason?: typeof REPO_SCAN_PENDING_REASON;
}

export interface GitHubMigrationTaskOverride {
  taskId: string;
  enabled: boolean;
  updatedBy: string;
}

export interface GitHubScheduleOverrideMigration {
  legacyTaskId: string;
  taskId: string;
  enabled: boolean;
  updatedBy: string;
}

export function buildGitHubMigrationEnv(
  pluginEnv: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    ...pluginEnv,
    GITHUB_REPO_ALLOWLIST: pluginEnv.GITHUB_REPO_ALLOWLIST ?? env.GITHUB_REPO_ALLOWLIST,
    GITHUB_REPO_INBOX_CAT_ID: pluginEnv.GITHUB_REPO_INBOX_CAT_ID ?? env.GITHUB_REPO_INBOX_CAT_ID,
  };
}

function hasRepoScanEnvDeps(env: Record<string, string | undefined>): boolean {
  return REPO_SCAN_REQUIRED_ENV.every((k) => !!env[k]);
}

function buildGitHubMigrationEntry(
  resourceName: string,
  opts: { enabled: boolean; migrationPendingReason?: typeof REPO_SCAN_PENDING_REASON } = { enabled: true },
): GitHubMigrationScheduleEntry {
  return {
    id: `plugin:github:${resourceName}`,
    type: 'schedule',
    enabled: opts.enabled,
    source: 'cat-cafe',
    pluginId: 'github',
    scheduleTaskId: `schedule:github:${resourceName}`,
    ...(opts.migrationPendingReason ? { migrationPendingReason: opts.migrationPendingReason } : {}),
  };
}

/**
 * Build capability entries for the one-time migration.
 *
 * Repo-scan is preserved as disabled/pending whenever required env/runtime deps
 * are incomplete, and enabled once all deps are available. This avoids a ghost
 * "enabled" UI while still allowing old installs to add env later and complete
 * after the one-time migration marker exists.
 */
export function buildGitHubMigrationEntries(
  manifest: { resources: { type: string; name?: string }[] },
  env: Record<string, string | undefined> = process.env,
  opts?: { repoScanDepsAvailable?: boolean },
): GitHubMigrationScheduleEntry[] {
  const repoScanEnvDepsAvailable = hasRepoScanEnvDeps(env);
  // Gate on both env vars AND runtime deps (Redis).
  // Without Redis, repo-scan factory construction fails at rehydration,
  // leaving capabilities.json with "enabled" but no running task (P2-1).
  const hasRepoScanDeps = repoScanEnvDepsAvailable && opts?.repoScanDepsAvailable !== false;

  return manifest.resources.flatMap((r) => {
    const resourceName = r.name;
    if (r.type !== 'schedule' || !resourceName) return [];
    if (!REDIS_GATED_GITHUB_RESOURCES.has(resourceName)) return [buildGitHubMigrationEntry(resourceName)];
    if (hasRepoScanDeps) return [buildGitHubMigrationEntry(resourceName)];
    return [
      buildGitHubMigrationEntry(resourceName, {
        enabled: false,
        migrationPendingReason: REPO_SCAN_PENDING_REASON,
      }),
    ];
  });
}

export function promotePendingGitHubMigrationEntries(
  config: CapabilitiesConfig,
  manifest: { resources: { type: string; name?: string }[] },
  env: Record<string, string | undefined> = process.env,
  opts?: { repoScanDepsAvailable?: boolean },
): { changed: boolean; config: CapabilitiesConfig } {
  const pendingResourceNames = manifest.resources
    .filter((r) => r.type === 'schedule' && !!r.name && REDIS_GATED_GITHUB_RESOURCES.has(r.name))
    .map((r) => r.name as string);
  if (pendingResourceNames.length === 0 || !hasRepoScanEnvDeps(env) || opts?.repoScanDepsAvailable === false) {
    return { changed: false, config };
  }

  const next = structuredClone(config);
  let changed = false;
  for (const resourceName of pendingResourceNames) {
    const entry = next.capabilities.find(
      (e) =>
        e.id === `plugin:github:${resourceName}` &&
        e.type === 'schedule' &&
        e.pluginId === 'github' &&
        (e as GitHubMigrationScheduleEntry).migrationPendingReason === REPO_SCAN_PENDING_REASON,
    ) as GitHubMigrationScheduleEntry | undefined;
    if (!entry) continue;
    entry.enabled = true;
    entry.scheduleTaskId = entry.scheduleTaskId ?? `schedule:github:${resourceName}`;
    delete entry.migrationPendingReason;
    changed = true;
  }
  return { changed, config: changed ? next : config };
}

/**
 * F168 C0.3 (cloud review): backfill the NEW manifest schedule resource(s) this version
 * introduces (BACKFILL_TARGET_RESOURCES) into existing installs.
 *
 * shouldRunGitHubScheduleMigration returns false as soon as ANY github schedule entry
 * exists, so a NEW manifest resource (repo-comment-poll, added after the one-time migration
 * already ran) would never be added — the poller silently never starts and the un-routed
 * comment blind spot is never closed on existing installs.
 *
 * Three guards prevent resurrecting disabled schedules (disable physically removes the
 * capability row via removeCapabilityEntry, so "absent" alone is NOT safe to recreate —
 * cloud review R2/R3 P1). Complete backfill precondition: plugin-active ∧ first-run ∧
 * TARGET ∧ absent. Failure-mode audit of every "absent" cause:
 *  1. plugin-active (R3 P1): only backfill when ≥1 github schedule row exists. If the
 *     operator disabled the whole GitHub plugin before upgrading, capabilities has NO
 *     github rows but the f202 marker still suppresses migration — backfilling would
 *     resurrect part of a disabled plugin. (Also covers the all-schedules-disabled case.)
 *  2. TARGET only (R2 P1): never backfill legacy resources — a legacy schedule disabled
 *     before upgrading is never re-created.
 *  3. one-time via opts.alreadyBackfilled (R2 P1): a TARGET resource disabled AFTER backfill
 *     ran is not resurrected (backfill never runs again; a TARGET is new so it can't have
 *     been disabled before its first backfill).
 * Redis-gated resources are backfilled as pending until deps are available, then enabled by
 * promotePendingGitHubMigrationEntries.
 */
export function backfillMissingGitHubScheduleEntries(
  config: CapabilitiesConfig,
  manifest: { resources: { type: string; name?: string }[] },
  env: Record<string, string | undefined> = process.env,
  opts?: { repoScanDepsAvailable?: boolean; alreadyBackfilled?: boolean },
): { changed: boolean; config: CapabilitiesConfig } {
  // Guard 3 — one-time (cloud R2 P1): once backfill has run, never run again.
  if (opts?.alreadyBackfilled) return { changed: false, config };

  // Guard 1 — plugin-active (cloud R3 P1): if the GitHub plugin was disabled before this
  // upgrade, capabilities has no github schedule rows (physically removed) while the f202
  // marker still suppresses migration. Backfilling would resurrect a disabled plugin. Only
  // backfill when the plugin is active (≥1 github schedule row exists).
  const githubPluginActive = config.capabilities.some((c) => c.type === 'schedule' && c.pluginId === 'github');
  if (!githubPluginActive) return { changed: false, config };

  const existingIds = new Set(config.capabilities.map((c) => c.id));
  const hasRepoScanDeps = hasRepoScanEnvDeps(env) && opts?.repoScanDepsAvailable !== false;

  const missing = manifest.resources.flatMap((r) => {
    const resourceName = r.name;
    if (r.type !== 'schedule' || !resourceName) return [];
    // Only backfill resources this version introduces — never legacy ones (a legacy
    // schedule disabled before upgrade is physically removed; backfilling resurrects it).
    if (!BACKFILL_TARGET_RESOURCES.has(resourceName)) return [];
    if (existingIds.has(`plugin:github:${resourceName}`)) return []; // already present
    if (!REDIS_GATED_GITHUB_RESOURCES.has(resourceName)) return [buildGitHubMigrationEntry(resourceName)];
    if (hasRepoScanDeps) return [buildGitHubMigrationEntry(resourceName)];
    return [
      buildGitHubMigrationEntry(resourceName, {
        enabled: false,
        migrationPendingReason: REPO_SCAN_PENDING_REASON,
      }),
    ];
  });

  if (missing.length === 0) return { changed: false, config };
  return {
    changed: true,
    config: { ...config, capabilities: [...config.capabilities, ...missing] },
  };
}

function resourceNameFromMigrationEntry(entry: Pick<GitHubMigrationScheduleEntry, 'id' | 'scheduleTaskId'>): string {
  const idPrefix = 'plugin:github:';
  if (entry.id.startsWith(idPrefix)) return entry.id.slice(idPrefix.length);

  const taskPrefix = 'schedule:github:';
  if (entry.scheduleTaskId.startsWith(taskPrefix)) return entry.scheduleTaskId.slice(taskPrefix.length);

  return '';
}

export function buildGitHubScheduleOverrideMigrations(
  entries: readonly Pick<GitHubMigrationScheduleEntry, 'id' | 'scheduleTaskId'>[],
  overrides: readonly GitHubMigrationTaskOverride[] = [],
): GitHubScheduleOverrideMigration[] {
  const overridesByTaskId = new Map(overrides.map((override) => [override.taskId, override]));
  const migrations: GitHubScheduleOverrideMigration[] = [];

  for (const entry of entries) {
    if (overridesByTaskId.has(entry.scheduleTaskId)) continue;

    const resourceName = resourceNameFromMigrationEntry(entry);
    const legacyTaskId = LEGACY_GITHUB_SCHEDULE_TASK_IDS.get(resourceName);
    if (!legacyTaskId) continue;

    const legacyOverride = overridesByTaskId.get(legacyTaskId);
    if (!legacyOverride) continue;

    migrations.push({
      legacyTaskId,
      taskId: entry.scheduleTaskId,
      enabled: legacyOverride.enabled,
      updatedBy: legacyOverride.updatedBy,
    });
  }

  return migrations;
}
