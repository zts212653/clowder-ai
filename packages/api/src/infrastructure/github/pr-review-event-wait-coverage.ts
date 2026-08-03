import type { PrEventWaitUncoveredReason } from '@cat-cafe/shared';
import { buildGhCliEnv, withHiddenGhCliWindow } from './gh-cli-env.js';

interface ExecFileOptions {
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  windowsHide: boolean;
}

interface VerifyPrReviewEventWaitCoverageOptions {
  ghToken?: string;
  now?: () => number;
  execFileAsync?: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;
}

export interface VerifyPrReviewEventWaitCoverageInput {
  repoFullName: string;
  prNumber: number;
  triggerCommentId: number;
}

export type PrReviewEventWaitCoverageResult =
  | { covered: true; triggerCommentId: number; observedAt: number }
  | {
      covered: false;
      reason: PrEventWaitUncoveredReason;
      triggerCommentId: number;
      observedAt: number;
    };

interface GithubIssueComment {
  id?: unknown;
  body?: unknown;
  issue_url?: unknown;
  created_at?: unknown;
}

const CODEX_CONNECTOR_LOGIN = 'chatgpt-codex-connector[bot]';
const CODEX_EYES_JQ = `[.[] | select(.content == "eyes" and ((.user.login // "") | ascii_downcase) == "${CODEX_CONNECTOR_LOGIN}" and .user.type == "Bot")] | length`;
const CODEX_FEEDBACK_JQ =
  '.[] | [(.user.login // ""), (.user.type // ""), (.submitted_at // .created_at // "")] | @tsv';

function issueUrlMatchesPr(issueUrl: string, repoFullName: string, prNumber: number): boolean {
  try {
    const path = new URL(issueUrl).pathname.toLowerCase();
    return path === `/repos/${repoFullName.toLowerCase()}/issues/${prNumber}`;
  } catch {
    return false;
  }
}

function uncovered(
  input: VerifyPrReviewEventWaitCoverageInput,
  reason: PrEventWaitUncoveredReason,
  observedAt: number,
): PrReviewEventWaitCoverageResult {
  return {
    covered: false,
    reason,
    triggerCommentId: input.triggerCommentId,
    observedAt,
  };
}

/**
 * Verify that one exact GitHub review trigger is callback-covered for the requested PR.
 *
 * Transport errors intentionally throw so the authenticated callback route can return 503
 * before writing a route grant. Semantic mismatches return an uncovered verdict.
 */
export async function verifyPrReviewEventWaitCoverage(
  input: VerifyPrReviewEventWaitCoverageInput,
  options: VerifyPrReviewEventWaitCoverageOptions = {},
): Promise<PrReviewEventWaitCoverageResult> {
  const execFn =
    options.execFileAsync ??
    (async (file: string, args: string[], execOptions: ExecFileOptions) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      return promisify(execFile)(file, args, execOptions);
    });
  const execOptions = {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: buildGhCliEnv({ token: options.ghToken }),
  };
  const observedAt = (options.now ?? Date.now)();

  const { stdout: commentJson } = await execFn(
    'gh',
    [
      'api',
      `repos/${input.repoFullName}/issues/comments/${input.triggerCommentId}`,
      '--jq',
      '{id,body,issue_url,created_at}',
    ],
    withHiddenGhCliWindow(execOptions),
  );
  const comment = JSON.parse(commentJson) as GithubIssueComment;
  if (
    comment.id !== input.triggerCommentId ||
    typeof comment.issue_url !== 'string' ||
    !issueUrlMatchesPr(comment.issue_url, input.repoFullName, input.prNumber)
  ) {
    return uncovered(input, 'subject_mismatch', observedAt);
  }
  if (typeof comment.body !== 'string' || comment.body.trim() !== '@codex review') {
    return uncovered(input, 'not_review_trigger', observedAt);
  }
  if (typeof comment.created_at !== 'string' || !Number.isFinite(Date.parse(comment.created_at))) {
    throw new Error('GitHub review trigger query returned an invalid created_at');
  }

  // EYES is necessary acceptance provenance, but it is not sufficient pending-work proof:
  // the connector may remove it after (rather than atomically with) review submission.
  const { stdout: reactionCounts } = await execFn(
    'gh',
    [
      'api',
      `repos/${input.repoFullName}/issues/comments/${input.triggerCommentId}/reactions?content=eyes&per_page=100`,
      '--paginate',
      '--jq',
      CODEX_EYES_JQ,
    ],
    withHiddenGhCliWindow(execOptions),
  );
  const pageCounts = reactionCounts.trim().split(/\s+/).filter(Boolean).map(Number);
  if (pageCounts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('GitHub reaction provenance query returned an invalid count');
  }
  const acceptedByCodexConnector = pageCounts.reduce((sum, count) => sum + count, 0) > 0;
  if (!acceptedByCodexConnector) {
    return uncovered(input, 'review_not_accepted', observedAt);
  }

  const triggerCreatedAt = Date.parse(comment.created_at);
  const feedbackEndpoints = [
    `repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100`,
    `repos/${input.repoFullName}/pulls/${input.prNumber}/comments?per_page=100`,
    `repos/${input.repoFullName}/issues/${input.prNumber}/comments?per_page=100`,
  ];
  const feedbackResults = await Promise.all(
    feedbackEndpoints.map((endpoint) =>
      execFn('gh', ['api', endpoint, '--paginate', '--jq', CODEX_FEEDBACK_JQ], withHiddenGhCliWindow(execOptions)),
    ),
  );
  const connectorFeedbackAlreadyPosted = feedbackResults.some(({ stdout }) =>
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .some((row) => {
        const [login, type, postedAt] = row.split('\t');
        if (login?.toLowerCase() !== CODEX_CONNECTOR_LOGIN || type !== 'Bot') return false;
        const postedAtMs = Date.parse(postedAt ?? '');
        if (!Number.isFinite(postedAtMs)) {
          throw new Error('GitHub connector feedback query returned an invalid timestamp');
        }
        return postedAtMs >= triggerCreatedAt;
      }),
  );
  if (connectorFeedbackAlreadyPosted) {
    return uncovered(input, 'feedback_already_posted', observedAt);
  }
  return {
    covered: true,
    triggerCommentId: input.triggerCommentId,
    observedAt,
  };
}
