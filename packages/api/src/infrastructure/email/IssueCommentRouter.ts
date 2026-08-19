/**
 * F202 Phase 2D: IssueCommentRouter — format + deliver GitHub issue comment notifications.
 *
 * Mirrors ReviewFeedbackRouter pattern: route(signal, tracking) → connector message.
 * AC-D-security: External comment bodies wrapped in [UNTRUSTED EXTERNAL CONTENT].
 * AC-C2: the Phase-C issue continuation note is appended when present.
 */
import type { ConnectorSource } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import { selectIssueFixReadiness } from '../../domains/community/issue-analysis/issue-fix-evidence.js';
import type { ConnectorDeliveryDeps } from './deliver-connector-message.js';
import { deliverConnectorMessage } from './deliver-connector-message.js';

// ── Domain Types ──────────────────────────────────────────────────

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  /** GitHub REST `user.type`; absent when the upstream actor cannot be classified reliably. */
  readonly actorType?: string;
  readonly body: string;
  readonly createdAt: string;
  /** GitHub author_association field. Context only; never used as actor identity. */
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
    tracking: { threadId: string; catId: string; userId: string },
  ): Promise<IssueCommentRouteResult> {
    if (signal.newComments.length === 0) {
      return { kind: 'skipped', reason: 'no new comments' };
    }

    const content = buildIssueCommentContent(signal);

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

export function buildIssueCommentContent(signal: IssueCommentSignal): string {
  const lines: string[] = [
    `💬 **Issue Comments** — Issue #${signal.issueNumber} (${signal.repoFullName})`,
    '',
    `--- New Comments (${signal.newComments.length}) ---`,
  ];

  for (const c of signal.newComments) {
    const bodySnippet = `[UNTRUSTED EXTERNAL CONTENT] ${c.body.slice(0, 200).replace(/[\r\n]+/g, ' ')}`;
    lines.push(`💬 **${c.author}**: ${bodySnippet}`);
  }

  const fixReadiness = selectIssueFixReadiness({
    events: signal.newComments.map((comment) => ({
      sourceEventId: `issue-comment:${comment.id}`,
      subjectKey: `issue:${signal.repoFullName}#${signal.issueNumber}`,
      kind: 'issue.commented',
      classification: 'informational',
      payload: { body: comment.body },
      at: Date.parse(comment.createdAt),
    })),
  });
  if (fixReadiness.kind === 'ready') {
    const evidence =
      fixReadiness.evidence.kind === 'pull_request'
        ? fixReadiness.evidence.url
        : fixReadiness.evidence.kind === 'commit'
          ? (fixReadiness.evidence.url ?? fixReadiness.evidence.sha)
          : fixReadiness.evidence.kind === 'release'
            ? fixReadiness.evidence.url
            : fixReadiness.evidence.evidence;
    lines.push('', '🚦 **Fix evidence — ready for re-review**', `- Evidence: ${evidence}`);
  } else if (fixReadiness.kind === 'waiting') {
    lines.push(
      '',
      '⏳ **Fix claim detected — evidence missing**',
      '- Keep awaiting evidence; do not mark re-review ready.',
    );
  }

  lines.push('', '---', '🔧 **自动处理**');
  lines.push(`- 目标: ${signal.repoFullName}#${signal.issueNumber} (issue)`);
  lines.push('- 操作: 阅读评论内容，需要回复则回复');

  return lines.join('\n');
}
