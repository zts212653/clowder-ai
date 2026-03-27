/**
 * F140: ReviewFeedbackRouter — format + deliver PR review feedback notifications.
 *
 * OQ-2: Aggregated three-section message (Review Decisions / Inline Comments / PR Conversation).
 * KD-8: PrFeedbackComment richer model (author, filePath, line, commentType).
 * KD-10: cursor commit after delivery success, trigger is best-effort.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

// ── Domain Types (KD-8: richer model) ──────────────────────────────

export interface PrFeedbackComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly commentType: 'inline' | 'conversation';
  readonly filePath?: string;
  readonly line?: number;
}

export interface PrReviewDecision {
  readonly id: number;
  readonly author: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'COMMENTED';
  readonly body: string;
  readonly submittedAt: string;
}

export interface ReviewFeedbackSignal {
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly newComments: readonly PrFeedbackComment[];
  readonly newDecisions: readonly PrReviewDecision[];
}

// ── Router ─────────────────────────────────────────────────────────

export type ReviewFeedbackRouteResult =
  | { kind: 'notified'; threadId: string; catId: string; messageId: string; content: string }
  | { kind: 'skipped'; reason: string };

export interface ReviewFeedbackRouterOptions {
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
}

export class ReviewFeedbackRouter {
  private readonly opts: ReviewFeedbackRouterOptions;

  constructor(opts: ReviewFeedbackRouterOptions) {
    this.opts = opts;
  }

  async route(
    signal: ReviewFeedbackSignal,
    tracking: { threadId: string; catId: string; userId: string },
  ): Promise<ReviewFeedbackRouteResult> {
    if (signal.newComments.length === 0 && signal.newDecisions.length === 0) {
      return { kind: 'skipped', reason: 'no new feedback' };
    }

    const content = buildReviewFeedbackContent(signal);

    const source: ConnectorSource = {
      connector: 'github-review-feedback',
      label: 'Review Feedback',
      icon: 'github',
      url: `https://github.com/${signal.repoFullName}/pull/${signal.prNumber}`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: tracking.threadId,
      userId: tracking.userId,
      catId: tracking.catId,
      content,
      source,
    });

    this.opts.log.info(
      `[ReviewFeedbackRouter] ${signal.repoFullName}#${signal.prNumber} → ${tracking.catId} ` +
        `(${signal.newDecisions.length} decisions, ${signal.newComments.length} comments)`,
    );

    return {
      kind: 'notified',
      threadId: tracking.threadId,
      catId: tracking.catId,
      messageId: result.messageId,
      content,
    };
  }
}

// ── Message Formatting (OQ-2: three-section aggregation) ───────────

export function buildReviewFeedbackContent(signal: ReviewFeedbackSignal): string {
  const lines: string[] = [`📋 **Review Feedback** — PR #${signal.prNumber} (${signal.repoFullName})`];

  // Section 1: Review Decisions
  if (signal.newDecisions.length > 0) {
    lines.push('', '--- Review Decisions ---');
    for (const d of signal.newDecisions) {
      const emoji = decisionEmoji(d.state);
      const bodySnippet = d.body ? ` — ${d.body.slice(0, 120)}` : '';
      lines.push(`${emoji} **${d.author}**: ${d.state}${bodySnippet}`);
    }
  }

  // Section 2: Inline Comments
  const inline = signal.newComments.filter((c) => c.commentType === 'inline');
  if (inline.length > 0) {
    lines.push('', `--- Inline Comments (${inline.length}) ---`);
    for (const c of inline) {
      const location = c.filePath ? `\`${c.filePath}${c.line ? `:${c.line}` : ''}\`` : '';
      const bodySnippet = c.body.slice(0, 120);
      lines.push(`💬 **${c.author}** ${location}: ${bodySnippet}`);
    }
  }

  // Section 3: PR Conversation
  const conversation = signal.newComments.filter((c) => c.commentType === 'conversation');
  if (conversation.length > 0) {
    lines.push('', `--- PR Conversation (${conversation.length}) ---`);
    for (const c of conversation) {
      const bodySnippet = c.body.slice(0, 120);
      lines.push(`💬 **${c.author}**: ${bodySnippet}`);
    }
  }

  // Phase B: Action hint for auto-response
  lines.push('', '---', '🔧 **自动处理**', `- 目标: ${signal.repoFullName}#${signal.prNumber}`);

  const hasChangesRequested = signal.newDecisions.some((d) => d.state === 'CHANGES_REQUESTED');
  const hasApproved = signal.newDecisions.some((d) => d.state === 'APPROVED');

  if (hasChangesRequested) {
    lines.push('- 操作: 加载 `receive-review` 模式，逐项处理 review 意见（Red→Green）');
  } else if (hasApproved) {
    lines.push('- 操作: PR 已被批准，检查 CI 和冲突状态，准备 merge');
  } else {
    lines.push('- 操作: 阅读评论内容，需要回复则回复，需要修改则按 `receive-review` 模式处理');
  }

  return lines.join('\n');
}

function decisionEmoji(state: PrReviewDecision['state']): string {
  switch (state) {
    case 'APPROVED':
      return '✅';
    case 'CHANGES_REQUESTED':
      return '🔄';
    case 'DISMISSED':
      return '🚫';
    case 'COMMENTED':
      return '💬';
  }
}
