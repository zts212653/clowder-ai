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
import type { ScheduleFactory, ScheduleFactoryDeps, ScheduleFactoryRegistry } from './ScheduleFactoryRegistry.js';

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
    }) as TaskSpec_P1;
  },
};

/** Register all 5 GitHub schedule factories in the registry. */
export function registerGitHubScheduleFactories(registry: ScheduleFactoryRegistry): void {
  registry.register(cicdCheckFactory);
  registry.register(conflictCheckFactory);
  registry.register(reviewFeedbackFactory);
  registry.register(repoScanFactory);
  registry.register(issueTrackingFactory);
}

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

/** Repo-scan env deps that must be present for the schedule to actually run. */
const REPO_SCAN_REQUIRED_ENV = ['GITHUB_REPO_ALLOWLIST', 'GITHUB_REPO_INBOX_CAT_ID'] as const;
const REPO_SCAN_PENDING_REASON = 'deps-unavailable' as const;
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
    if (resourceName !== 'repo-scan') return [buildGitHubMigrationEntry(resourceName)];
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
  const manifestHasRepoScan = manifest.resources.some((r) => r.type === 'schedule' && r.name === 'repo-scan');
  if (!manifestHasRepoScan || !hasRepoScanEnvDeps(env) || opts?.repoScanDepsAvailable === false) {
    return { changed: false, config };
  }

  const next = structuredClone(config);
  const repoScan = next.capabilities.find(
    (entry) =>
      entry.id === 'plugin:github:repo-scan' &&
      entry.type === 'schedule' &&
      entry.pluginId === 'github' &&
      (entry as GitHubMigrationScheduleEntry).migrationPendingReason === REPO_SCAN_PENDING_REASON,
  ) as GitHubMigrationScheduleEntry | undefined;

  if (!repoScan) return { changed: false, config };

  repoScan.enabled = true;
  repoScan.scheduleTaskId = repoScan.scheduleTaskId ?? 'schedule:github:repo-scan';
  delete repoScan.migrationPendingReason;
  return { changed: true, config: next };
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
