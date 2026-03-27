/**
 * GitHub Review Watcher Bootstrap
 * Starts the email watcher if configured, wires up ReviewRouter for routing.
 * Phase 3b: After routing, triggers cat invocation for automatic review handling.
 *
 * BACKLOG #81, #97
 */

import type { CatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorInvokeTrigger } from './ConnectorInvokeTrigger.js';
import { GithubReviewWatcher, loadWatcherConfigFromEnv } from './GithubReviewWatcher.js';
import type { GitHubFeedbackFilter } from './github-feedback-filter.js';
import type { ReviewRouter } from './ReviewRouter.js';

let watcher: GithubReviewWatcher | null = null;

export interface GithubReviewBootstrapOptions {
  readonly log: FastifyBaseLogger;
  readonly reviewRouter?: ReviewRouter;
  /** Phase 3b: trigger cat invocation after successful routing */
  readonly invokeTrigger?: ConnectorInvokeTrigger;
  /** Rule C: shared feedback filter — skip self-authored + authoritative bot reviews */
  readonly feedbackFilter?: GitHubFeedbackFilter;
}

/**
 * Start the GitHub review email watcher if env vars are configured.
 * Returns true if started, false if not configured.
 */
export async function startGithubReviewWatcher(options: GithubReviewBootstrapOptions): Promise<boolean> {
  const config = loadWatcherConfigFromEnv();

  if (!config) {
    options.log.info('[GithubReviewWatcher] Not configured (missing GITHUB_REVIEW_IMAP_USER/PASS), skipping');
    return false;
  }

  watcher = new GithubReviewWatcher(config, options.log);

  // Use acknowledged handler so watcher defers IMAP cursor advancement
  // until routing succeeds (Cloud Codex P1-3: no notification loss on failure)
  if (options.reviewRouter) {
    const router = options.reviewRouter;
    const trigger = options.invokeTrigger;
    watcher.onReviewAck(async (event) => {
      // Rule C + Rule A only: email watcher skips self-authored reviews.
      // Rule B does NOT apply here — email IS the authoritative source for bot reviews.
      if (options.feedbackFilter && event.reviewer) {
        if (options.feedbackFilter.isSelfAuthored(event.reviewer)) {
          options.log.info(`[GithubReviewWatcher] Skipped self-authored review from ${event.reviewer}`);
          return;
        }
      }

      const result = await router.route(event);
      options.log.info(`[GithubReviewWatcher] Route result: ${result.kind}`);

      // Phase 3b: auto-invoke cat after successful routing
      if (result.kind === 'routed' && trigger) {
        trigger.trigger(
          result.threadId,
          result.catId as CatId,
          result.userId,
          result.content,
          result.messageId,
          undefined,
          { priority: 'urgent', reason: 'github_review' },
        );
        options.log.info(`[GithubReviewWatcher] Triggered ${result.catId} invocation in thread ${result.threadId}`);
      }
    });
  }

  watcher.on('error', (error) => {
    options.log.error(`[GithubReviewWatcher] Error: ${error.message}`);
  });

  watcher.on('connected', () => {
    options.log.info('[GithubReviewWatcher] Connected to IMAP server');
  });

  watcher.on('disconnected', () => {
    options.log.info('[GithubReviewWatcher] Disconnected from IMAP server');
  });

  const MAX_START_RETRIES = 3;
  const BASE_RETRY_DELAY_MS = 10_000;

  for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt++) {
    try {
      await watcher.start();
      options.log.info(`[GithubReviewWatcher] Started (polling every ${config.pollIntervalMs / 1000}s)`);
      return true;
    } catch (error) {
      const isLast = attempt >= MAX_START_RETRIES;
      options.log.error(`[GithubReviewWatcher] Start attempt ${attempt}/${MAX_START_RETRIES} failed: ${String(error)}`);
      if (isLast) {
        options.log.error('[GithubReviewWatcher] All start attempts exhausted — watcher disabled until next restart');
        watcher = null;
        return false;
      }
      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      options.log.info(`[GithubReviewWatcher] Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return false;
}

/**
 * Stop the GitHub review watcher if running.
 */
export async function stopGithubReviewWatcher(): Promise<void> {
  if (watcher) {
    await watcher.stop();
    watcher = null;
  }
}

/**
 * Check if the watcher is currently running.
 */
export function isGithubReviewWatcherRunning(): boolean {
  return watcher !== null;
}
