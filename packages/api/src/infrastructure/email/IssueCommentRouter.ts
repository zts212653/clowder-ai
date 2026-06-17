/**
 * F202 Phase 2D: IssueCommentRouter — format + deliver GitHub issue comment notifications.
 *
 * Mirrors ReviewFeedbackRouter pattern: route(signal, tracking) → connector message.
 * AC-D-security: External comment bodies wrapped in [UNTRUSTED EXTERNAL CONTENT].
 * AC-C2: trackingInstructions appended when present.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

// ── Domain Types ──────────────────────────────────────────────────

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  /** GitHub author_association field — present when fetched via GitHub API.
   * Undefined in legacy paths or when association cannot be determined.
   * Delivery policy uses this to silence OWNER/MEMBER activity (F168 Phase B). */
  readonly authorAssociation?: string;
}

export interface IssueCommentSignal {
  readonly repoFullName: string;
  readonly issueNumber: number;
  readonly newComments: readonly IssueComment[];
}

// ── Router ────────────────────────────────────────────────────────

export type IssueCommentRouteResult =
  | { kind: 'notified'; threadId: string; catId: string; messageId: string; content: string }
  | { kind: 'skipped'; reason: string };

export interface IssueCommentRouterOptions {
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly log: FastifyBaseLogger;
}

export class IssueCommentRouter {
  private readonly opts: IssueCommentRouterOptions;

  constructor(opts: IssueCommentRouterOptions) {
    this.opts = opts;
  }

  async route(
    signal: IssueCommentSignal,
    tracking: { threadId: string; catId: string; userId: string; trackingInstructions?: string },
  ): Promise<IssueCommentRouteResult> {
    if (signal.newComments.length === 0) {
      return { kind: 'skipped', reason: 'no new comments' };
    }

    const content = buildIssueCommentContent(signal, tracking.trackingInstructions);

    const source: ConnectorSource = {
      connector: 'github-issue-comment',
      label: 'Issue Comment',
      icon: 'github',
      url: `https://github.com/${signal.repoFullName}/issues/${signal.issueNumber}`,
    };

    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: tracking.threadId,
      userId: tracking.userId,
      catId: tracking.catId,
      content,
      source,
    });

    this.opts.log.info(
      `[IssueCommentRouter] ${signal.repoFullName}#${signal.issueNumber} → ${tracking.catId} ` +
        `(${signal.newComments.length} comments)`,
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

// ── Message Formatting ────────────────────────────────────────────

export function buildIssueCommentContent(signal: IssueCommentSignal, trackingInstructions?: string): string {
  const lines: string[] = [
    `💬 **Issue Comments** — Issue #${signal.issueNumber} (${signal.repoFullName})`,
    '',
    `--- New Comments (${signal.newComments.length}) ---`,
  ];

  for (const c of signal.newComments) {
    const bodySnippet = `[UNTRUSTED EXTERNAL CONTENT] ${c.body.slice(0, 200).replace(/[\r\n]+/g, ' ')}`;
    lines.push(`💬 **${c.author}**: ${bodySnippet}`);
  }

  lines.push('', '---', '🔧 **自动处理**');
  lines.push(`- 目标: ${signal.repoFullName}#${signal.issueNumber} (issue)`);
  lines.push('- 操作: 阅读评论内容，需要回复则回复');

  if (trackingInstructions) {
    lines.push('', '📌 **Tracking Instructions**', trackingInstructions);
  }

  return lines.join('\n');
}
