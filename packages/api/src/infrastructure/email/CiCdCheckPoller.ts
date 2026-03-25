import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { CiBucket, CiCdRouter, CiCheckDetail, CiPollResult } from './CiCdRouter.js';
import type { ConnectorInvokeTrigger, ConnectorTriggerPolicy } from './ConnectorInvokeTrigger.js';
import type { IPrTrackingStore, PrTrackingEntry } from './PrTrackingStore.js';

const execFileAsync = promisify(execFile);

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const GH_TIMEOUT_MS = 15_000;

export interface CiCdCheckPollerOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly cicdRouter: CiCdRouter;
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  readonly log: FastifyBaseLogger;
  readonly pollIntervalMs?: number;
}

export class CiCdCheckPoller {
  private readonly opts: CiCdCheckPollerOptions;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(opts: CiCdCheckPollerOptions) {
    this.opts = opts;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.opts.log.info(`[CiCdCheckPoller] Starting (interval: ${this.pollIntervalMs / 1000}s)`);
    this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
    this.pollAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.opts.log.info('[CiCdCheckPoller] Stopped');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const entries = await this.opts.prTrackingStore.listAll();
      const active = entries.filter((e) => e.ciTrackingEnabled !== false);

      for (const entry of active) {
        try {
          await this.pollOne(entry);
        } catch (err) {
          this.opts.log.warn(`[CiCdCheckPoller] Error polling ${entry.repoFullName}#${entry.prNumber}: ${String(err)}`);
        }
      }
    } catch (err) {
      this.opts.log.error(`[CiCdCheckPoller] Error listing PRs: ${String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async pollOne(entry: PrTrackingEntry): Promise<void> {
    const { cicdRouter, invokeTrigger, log } = this.opts;

    const pollResult = await this.fetchPrStatus(entry.repoFullName, entry.prNumber);
    if (!pollResult) return;

    const routeResult = await cicdRouter.route(pollResult);

    if (routeResult.kind === 'notified' && routeResult.bucket === 'fail' && invokeTrigger) {
      const policy: ConnectorTriggerPolicy = { priority: 'normal', reason: 'github_ci_failure' };
      invokeTrigger.trigger(
        routeResult.threadId,
        routeResult.catId as CatId,
        entry.userId,
        routeResult.content,
        routeResult.messageId,
        undefined,
        policy,
      );
      log.info(`[CiCdCheckPoller] Triggered ${routeResult.catId} for CI failure`);
    }
  }

  async fetchPrStatus(repoFullName: string, prNumber: number): Promise<CiPollResult | null> {
    const { log } = this.opts;

    let prViewJson: string;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(prNumber), '-R', repoFullName, '--json', 'headRefOid,state,mergedAt,statusCheckRollup'],
        { timeout: GH_TIMEOUT_MS },
      );
      prViewJson = stdout;
    } catch (err) {
      log.warn(`[CiCdCheckPoller] gh pr view failed for ${repoFullName}#${prNumber}: ${String(err)}`);
      return null;
    }

    let prView: {
      headRefOid: string;
      state: string;
      mergedAt: string | null;
      statusCheckRollup: Array<{ name: string; status: string; conclusion: string; __typename: string }>;
    };
    try {
      prView = JSON.parse(prViewJson);
    } catch {
      log.warn(`[CiCdCheckPoller] Failed to parse gh pr view output for ${repoFullName}#${prNumber}`);
      return null;
    }

    const prState = normalizePrState(prView.state, prView.mergedAt);
    if (prState === 'merged' || prState === 'closed') {
      return {
        repoFullName,
        prNumber,
        headSha: prView.headRefOid,
        prState,
        aggregateBucket: 'pending',
        checks: [],
      };
    }

    const rollup = prView.statusCheckRollup ?? [];
    const aggregateBucket = computeAggregateBucket(rollup);

    let checks: CiCheckDetail[] = [];
    if (aggregateBucket !== 'pending') {
      checks = await this.fetchCheckDetails(repoFullName, prNumber);
    }

    return {
      repoFullName,
      prNumber,
      headSha: prView.headRefOid,
      prState,
      aggregateBucket,
      checks,
    };
  }

  private async fetchCheckDetails(repoFullName: string, prNumber: number): Promise<CiCheckDetail[]> {
    const { log } = this.opts;

    // Try --required first, fallback to all checks if empty or no failures found in required set
    for (const requiredFlag of ['--required', '']) {
      try {
        const args = [
          'pr',
          'checks',
          String(prNumber),
          '-R',
          repoFullName,
          '--json',
          'name,bucket,link,workflow,description',
        ];
        if (requiredFlag) args.push(requiredFlag);

        const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS });
        const parsed: Array<{ name: string; bucket: string; link?: string; workflow?: string; description?: string }> =
          JSON.parse(stdout);

        if (parsed.length > 0) {
          const mapped = parsed.map((c) => ({
            name: c.name,
            bucket: normalizeBucket(c.bucket),
            link: c.link,
            workflow: c.workflow,
            description: c.description,
          }));

          // Required checks all passed — fall through to all checks to find the actual failures
          if (requiredFlag && !mapped.some((c) => c.bucket === 'fail')) {
            log.debug('[CiCdCheckPoller] Required checks have no failures, falling back to all checks');
            continue;
          }

          return mapped;
        }

        if (!requiredFlag) {
          return parsed.map((c) => ({
            name: c.name,
            bucket: normalizeBucket(c.bucket),
            link: c.link,
            workflow: c.workflow,
            description: c.description,
          }));
        }
      } catch (err) {
        if (requiredFlag) {
          log.debug(`[CiCdCheckPoller] gh pr checks --required failed, falling back to all: ${String(err)}`);
          continue;
        }
        log.warn(`[CiCdCheckPoller] gh pr checks failed for ${repoFullName}#${prNumber}: ${String(err)}`);
        return [];
      }
    }
    return [];
  }
}

function normalizePrState(state: string, mergedAt: string | null): 'open' | 'merged' | 'closed' {
  if (mergedAt || state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return 'open';
}

function normalizeBucket(bucket: string): CiBucket {
  const lower = bucket.toLowerCase();
  if (lower === 'pass' || lower === 'success') return 'pass';
  if (lower === 'fail' || lower === 'failure' || lower === 'error') return 'fail';
  return 'pending';
}

function computeAggregateBucket(rollup: Array<{ status: string; conclusion: string; __typename: string }>): CiBucket {
  if (rollup.length === 0) return 'pending';

  let hasFailure = false;
  let hasPending = false;

  for (const item of rollup) {
    if (item.__typename === 'StatusContext') {
      const state = item.status?.toLowerCase();
      if (state === 'failure' || state === 'error') hasFailure = true;
      else if (state !== 'success') hasPending = true;
    } else {
      const conclusion = item.conclusion?.toLowerCase();
      const status = item.status?.toLowerCase();
      if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled') hasFailure = true;
      else if (status !== 'completed' || !conclusion || conclusion === '' || conclusion === 'neutral')
        hasPending = true;
      else if (conclusion !== 'success' && conclusion !== 'skipped') hasPending = true;
    }
  }

  if (hasFailure) return 'fail';
  if (hasPending) return 'pending';
  return 'pass';
}

export { computeAggregateBucket, normalizeBucket, normalizePrState };
