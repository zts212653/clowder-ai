/**
 * Review Router
 * When a GitHub review email is detected, route it to the correct cat + thread.
 *
 * Routing strategy (砚砚 R1/R2 design):
 *   1. PrTrackingStore lookup (主路径: repo+pr → catId+threadId)
 *   2. Fallback: PR title [猫名🐾] → cat's Review Inbox thread
 *   3. Triage: no cat identified → 铲屎官 Triage thread
 *
 * BACKLOG #81
 */

import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { IMessageStore } from '../../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../../domains/cats/services/stores/ports/ThreadStore.js';
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
      source: 'registry' | 'fallback';
      messageId: string;
      content: string;
    }
  | { kind: 'triage'; threadId: string; reason: string }
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
  readonly triageThreadId?: string;
  readonly defaultUserId?: string;
  /** Optional: fetches GitHub review content for severity extraction. */
  readonly reviewContentFetcher?: IReviewContentFetcher;
}

/** Cached Review Inbox thread IDs per cat (in-memory, lost on restart). */
const reviewInboxThreads = new Map<string, string>();

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
   * Returns the route result (routed/triage/skipped).
   */
  async route(event: GithubReviewEvent): Promise<RouteResult> {
    const { processedEmailStore } = this.opts;

    // --- Dedup: skip if already processed ---
    const alreadyProcessed = await processedEmailStore.isProcessed(event.emailUid);
    if (alreadyProcessed) {
      return { kind: 'skipped', reason: `Email UID ${event.emailUid} already processed` };
    }

    // --- PR-level atomic dedup (check+mark in one call; Cloud Codex P1-2) ---
    // Covers both sequential re-poll (PR already invoked within window) and
    // concurrent race (two events for same PR dispatched simultaneously).
    const prAlreadyClaimed = await processedEmailStore.checkAndMarkPrInvoked(event.repository, event.prNumber);
    if (prAlreadyClaimed) {
      await processedEmailStore.markProcessed(event.emailUid);
      return {
        kind: 'skipped',
        reason: `PR ${event.repository}#${event.prNumber} recently invoked (dedup window)`,
      };
    }

    // Deliver, then mark processed. If delivery fails, rollback PR claim
    // so next poll retries (Cloud Codex P1-1 + P1-2 combined fix).
    try {
      return await this.deliverAndMark(event);
    } catch (err) {
      // Rollback: allow retry on next poll cycle
      await processedEmailStore.unmarkPrInvoked(event.repository, event.prNumber);
      throw err;
    }
  }

  /**
   * Internal: perform layer routing, deliver message, then mark processed.
   * Caller must rollback PR claim on failure.
   */
  private async deliverAndMark(event: GithubReviewEvent): Promise<RouteResult> {
    const { prTrackingStore, processedEmailStore, log } = this.opts;

    // --- Layer 1: PrTrackingStore lookup ---
    const tracking = await prTrackingStore.get(event.repository, event.prNumber);
    if (tracking) {
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
    }

    // --- Layer 2: Fallback via PR title cat tag ---
    if (event.catTag && event.catId) {
      const userId = this.resolveUserId();
      const catId = event.catId;
      const inboxThreadId = await this.getOrCreateReviewInboxThread(catId);

      log.info(
        `[ReviewRouter] Fallback: PR ${event.repository}#${event.prNumber} → cat=${catId} inbox=${inboxThreadId}`,
      );

      const posted = await this.postReviewMessage(inboxThreadId, catId, userId, event);
      await processedEmailStore.markProcessed(event.emailUid);

      return {
        kind: 'routed',
        threadId: inboxThreadId,
        catId,
        userId,
        source: 'fallback',
        messageId: posted.messageId,
        content: posted.content,
      };
    }

    // --- Layer 3: Triage (no cat identified) ---
    const triageThreadId = await this.getOrCreateTriageThread();

    log.warn(
      `[ReviewRouter] Triage: PR ${event.repository}#${event.prNumber} — no tracking entry and no cat tag in title`,
    );

    await this.postTriageMessage(triageThreadId, event);
    await processedEmailStore.markProcessed(event.emailUid);

    return {
      kind: 'triage',
      threadId: triageThreadId,
      reason: `No tracking entry and no cat tag for PR ${event.repository}#${event.prNumber}`,
    };
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

  private async postTriageMessage(threadId: string, event: GithubReviewEvent): Promise<void> {
    const { messageStore } = this.opts;
    const userId = this.resolveUserId();

    const content = [
      `**GitHub Review 需要分派**`,
      ``,
      `PR #${event.prNumber}: ${event.title}`,
      `仓库: ${event.repository}`,
      `Review 类型: ${formatReviewType(event.reviewType)}`,
      event.reviewer ? `Reviewer: @${event.reviewer}` : '',
      ``,
      `无法自动路由：注册表无匹配 + PR title 无猫名标签。`,
      `请铲屎官手动指派或补注册。`,
    ]
      .filter(Boolean)
      .join('\n');

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
      mentions: [],
      timestamp: Date.now(),
    });

    this.emitConnectorMessage(threadId, stored);
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

  private async getOrCreateReviewInboxThread(catId: string): Promise<string> {
    const cached = reviewInboxThreads.get(catId);
    if (cached) return cached;

    const userId = this.resolveUserId();
    const thread = (await this.opts.threadStore.create(userId, `${catId} Review Inbox`)) as Thread;

    reviewInboxThreads.set(catId, thread.id);
    return thread.id;
  }

  private async getOrCreateTriageThread(): Promise<string> {
    if (this.opts.triageThreadId) {
      return this.opts.triageThreadId;
    }

    const cached = reviewInboxThreads.get('__triage__');
    if (cached) return cached;

    const userId = this.resolveUserId();
    const thread = (await this.opts.threadStore.create(userId, 'Review Triage (未匹配)')) as Thread;

    reviewInboxThreads.set('__triage__', thread.id);
    return thread.id;
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
