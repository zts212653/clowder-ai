/**
 * Review Router
 * When a GitHub review email is detected, route it to the correct cat + thread.
 *
 * Routing strategy (#668 simplified):
 *   1. PrTrackingStore lookup (唯一路径: repo+pr → catId+threadId)
 *   2. Not registered → log + skip (no thread creation, no noise)
 *
 * Previous Layer 2 (PR title cat tag fallback) and Layer 3 (Triage thread)
 * were removed in #668: they silently created garbage threads on every restart
 * and routed unregistered PR notifications into a black hole nobody watched.
 *
 * BACKLOG #81
 */

import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';
import type { GithubReviewEvent } from './GithubReviewWatcher.js';
import type { IProcessedEmailStore } from './ProcessedEmailStore.js';
import type { IPrTrackingStore } from './PrTrackingStore.js';
import type { IReviewContentFetcher, ReviewContent } from './ReviewContentFetcher.js';

export type RouteResult =
  | {
      kind: 'routed';
      threadId: string;
      catId: string;
      userId: string;
      source: 'registry';
      messageId: string;
      content: string;
    }
  | { kind: 'skipped'; reason: string };

export interface ReviewRouterOptions {
  readonly prTrackingStore: IPrTrackingStore;
  readonly processedEmailStore: IProcessedEmailStore;
  readonly threadStore: IThreadStore;
  readonly messageStore: IMessageStore;
  readonly socketManager?: {
    broadcastToRoom: (room: string, event: string, data: unknown) => void;
  };
  readonly log: FastifyBaseLogger;
  readonly defaultUserId?: string;
  /** Optional: fetches GitHub review content for severity extraction. */
  readonly reviewContentFetcher?: IReviewContentFetcher;
}

export class ReviewRouter {
  private readonly opts: ReviewRouterOptions;

  constructor(opts: ReviewRouterOptions) {
    this.opts = opts;
  }

  /** Resolve the userId for message/thread ownership (砚砚 R2 P1 fix). */
  private resolveUserId(trackingUserId?: string): string {
    return trackingUserId ?? this.opts.defaultUserId ?? 'default-user';
  }

  /**
   * Resolve message ownership for registry-routed notifications.
   * Prefer real thread owner when available so realtime/socket visibility
   * matches F5 history query filtering by current user.
   */
  private async resolveRegistryUserId(threadId: string, trackingUserId: string): Promise<string> {
    const fallbackUserId = this.resolveUserId(trackingUserId);
    const thread = await this.opts.threadStore.get(threadId);
    if (!thread || !thread.createdBy || thread.createdBy === 'system') {
      return fallbackUserId;
    }

    if (thread.createdBy !== fallbackUserId) {
      this.opts.log.warn(
        `[ReviewRouter] Tracking user mismatch for thread ${threadId}: tracking=${fallbackUserId} owner=${thread.createdBy}; using owner`,
      );
    }
    return thread.createdBy;
  }

  /**
   * Route a review event to the appropriate thread.
   * Returns the route result (routed/skipped).
   */
  async route(event: GithubReviewEvent): Promise<RouteResult> {
    const { processedEmailStore } = this.opts;

    // --- Dedup: skip if already processed ---
    const alreadyProcessed = await processedEmailStore.isProcessed(event.emailUid);
    if (alreadyProcessed) {
      return { kind: 'skipped', reason: `Email UID ${event.emailUid} already processed` };
    }

    return this.deliverAndMark(event);
  }

  /**
   * Internal: perform layer routing, deliver message, then mark processed.
   * PR dedup claim + rollback handled internally.
   */
  private async deliverAndMark(event: GithubReviewEvent): Promise<RouteResult> {
    const { prTrackingStore, processedEmailStore, log } = this.opts;

    // --- Layer 1: PrTrackingStore lookup ---
    const tracking = await prTrackingStore.get(event.repository, event.prNumber);
    if (!tracking) {
      log.warn(`[ReviewRouter] Skipping unregistered PR: ${event.repository}#${event.prNumber} (no tracking entry)`);
      await processedEmailStore.markProcessed(event.emailUid);
      return {
        kind: 'skipped',
        reason: `No tracking entry for PR ${event.repository}#${event.prNumber}`,
      };
    }

    // --- PR-level atomic dedup (only for registered PRs; Cloud Codex P1-2) ---
    // Covers concurrent race (two events for same PR dispatched simultaneously).
    // Must happen AFTER tracking check so unregistered PRs don't claim the window
    // and block delivery after late registration (#668 P1 fix).
    const prAlreadyClaimed = await processedEmailStore.checkAndMarkPrInvoked(event.repository, event.prNumber);
    if (prAlreadyClaimed) {
      await processedEmailStore.markProcessed(event.emailUid);
      return {
        kind: 'skipped',
        reason: `PR ${event.repository}#${event.prNumber} recently invoked (dedup window)`,
      };
    }

    try {
      const resolvedUserId = await this.resolveRegistryUserId(tracking.threadId, tracking.userId);
      log.info(
        `[ReviewRouter] Registry hit: PR ${event.repository}#${event.prNumber} → cat=${tracking.catId} thread=${tracking.threadId}`,
      );

      const posted = await this.postReviewMessage(tracking.threadId, tracking.catId, resolvedUserId, event);
      await processedEmailStore.markProcessed(event.emailUid);

      return {
        kind: 'routed',
        threadId: tracking.threadId,
        catId: tracking.catId,
        userId: resolvedUserId,
        source: 'registry',
        messageId: posted.messageId,
        content: posted.content,
      };
    } catch (err) {
      // Rollback PR claim so next poll retries (Cloud Codex P1-1 + P1-2)
      await processedEmailStore.unmarkPrInvoked(event.repository, event.prNumber);
      throw err;
    }
  }

  private async postReviewMessage(
    threadId: string,
    catId: string,
    userId: string,
    event: GithubReviewEvent,
  ): Promise<{ messageId: string; content: string }> {
    const { messageStore, log } = this.opts;
    const reviewTypeLabel = formatReviewType(event.reviewType);

    // Plan A: proactively fetch review content for severity extraction
    let reviewContent: ReviewContent | null = null;
    if (this.opts.reviewContentFetcher) {
      try {
        reviewContent = await this.opts.reviewContentFetcher.fetch(event.repository, event.prNumber);
      } catch (err) {
        log.warn(
          `[ReviewRouter] Failed to fetch review content for ${event.repository}#${event.prNumber}: ${String(err)}`,
        );
      }
    }

    const content = buildReviewMessageContent(event, reviewTypeLabel, reviewContent);

    const source: ConnectorSource = {
      connector: 'github-review',
      label: 'GitHub Review',
      icon: 'github',
      url: `https://github.com/${event.repository}/pull/${event.prNumber}`,
    };

    const stored = await messageStore.append({
      threadId,
      userId,
      catId: null,
      content,
      source,
      mentions: [catId as CatId],
      timestamp: Date.now(),
    });

    this.emitConnectorMessage(threadId, stored);

    return { messageId: stored.id, content };
  }

  private emitConnectorMessage(
    threadId: string,
    message: {
      id: string;
      content: string;
      timestamp: number;
      source?: ConnectorSource;
    },
  ): void {
    this.opts.socketManager?.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
      threadId,
      message: {
        id: message.id,
        type: 'connector',
        content: message.content,
        ...(message.source ? { source: message.source } : {}),
        timestamp: message.timestamp,
      },
    });
  }
}

function formatReviewType(type: string): string {
  switch (type) {
    case 'approved':
      return 'Approved';
    case 'changes_requested':
      return 'Changes Requested';
    case 'commented':
      return 'Commented';
    case 'reviewed':
      return 'Reviewed';
    default:
      return type;
  }
}

/**
 * Build review notification content with optional severity findings.
 * Exported for testing.
 */
export function buildReviewMessageContent(
  event: Pick<GithubReviewEvent, 'prNumber' | 'title' | 'repository' | 'reviewType' | 'reviewer'>,
  reviewTypeLabel: string,
  reviewContent: ReviewContent | null,
): string {
  const severityHeader =
    reviewContent?.maxSeverity &&
    (reviewContent.maxSeverity === 'P0' || reviewContent.maxSeverity === 'P1' || reviewContent.maxSeverity === 'P2')
      ? `**Review 检测到 ${reviewContent.maxSeverity}**`
      : null;

  const lines: string[] = [];

  if (severityHeader) {
    lines.push(severityHeader, '');
  }

  lines.push(
    `**GitHub Review 通知**`,
    ``,
    `PR #${event.prNumber}: ${event.title}`,
    `仓库: ${event.repository}`,
    `Review 类型: ${reviewTypeLabel}`,
  );

  if (event.reviewer) {
    lines.push(`Reviewer: @${event.reviewer}`);
  }

  // Append findings summary (P0/P1/P2 only — P3 is informational)
  if (reviewContent && reviewContent.findings.length > 0) {
    const actionable = reviewContent.findings.filter(
      (f) => f.severity === 'P0' || f.severity === 'P1' || f.severity === 'P2',
    );
    if (actionable.length > 0) {
      lines.push('', `--- Findings (${actionable.length}) ---`);
      for (const f of actionable) {
        const loc = f.source === 'inline_comment' && f.path ? ` (${f.path})` : '';
        lines.push(`**${f.severity}**${loc}: ${f.excerpt.slice(0, 200)}`);
      }
    }
  }

  // P1-2 fix: warn when fetch failed — "no findings" is NOT confirmed safe (砚砚 review)
  if (reviewContent?.fetchFailed) {
    lines.push('', '⚠️ 未能完整拉取 review 内容，severity 状态未确认。请手动检查 PR 页面。');
  }

  // Incremental window indicator — so cats know scope of the scan
  if (reviewContent?.since) {
    lines.push('', `_基于最新 review（${reviewContent.since}）的增量扫描_`);
  }

  lines.push('', `请处理 review 意见。完成后通知铲屎官确认合入。`);

  return lines.join('\n');
}
