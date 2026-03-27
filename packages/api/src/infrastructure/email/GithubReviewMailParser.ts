/**
 * GitHub Review Mail Parser
 * Parses GitHub PR review notification emails to extract PR info.
 *
 * GitHub email subject formats:
 * - "[owner/repo] PR Title (#123)" - general PR notification
 * - "Re: [owner/repo] PR Title (#123)" - reply/comment
 * - "[owner/repo] @user commented on pull request #123: Title"
 * - "[owner/repo] @user approved pull request #123: Title"
 * - "[owner/repo] @user requested changes on pull request #123: Title"
 */

export type ReviewType = 'commented' | 'reviewed' | 'approved' | 'changes_requested' | 'unknown';

export interface ParsedGithubReviewMail {
  readonly prNumber: number;
  readonly repository: string;
  readonly title: string;
  readonly reviewType: ReviewType;
  readonly reviewer: string | undefined;
}

export interface InferredReviewAction {
  readonly ignorable: boolean;
  readonly reviewType: ReviewType;
  readonly reviewer: string | undefined;
}

export function normalizeLegacyPrMarkerSubject(subject: string): string | null {
  // Legacy GitHub notification shape:
  //   Re: [owner/repo] some title (#123)
  // We normalize trailing "(#N)" -> "(PR #N)" so existing parser path can reuse guards.
  if (!/^Re:\s/i.test(subject)) return null;
  if (!REPO_REGEX.test(subject)) return null;
  if (!/\(#\d+\)\s*$/i.test(subject)) return null;
  return subject.replace(/\(#(\d+)\)\s*$/i, '(PR #$1)');
}

/**
 * Infer review action/reviewer from raw email source text.
 *
 * Why: Some GitHub notifications include only "(PR #N)" in subject and omit action keywords.
 * The actionable signal ("reviewed", "left a comment") appears in the email body.
 *
 * This is also where we can suppress Codex environment/setup guidance comments which are
 * not review content and were confusing cats as "fake reviews".
 */
export function inferReviewActionFromEmailSource(source: string): InferredReviewAction {
  // Extract body after the first header/body separator without truncating multi-paragraph bodies.
  const sep = source.match(/\r?\n\r?\n/);
  const bodyText = sep && typeof sep.index === 'number' ? source.slice(sep.index + sep[0].length) : source;

  const hasSetupSentence = /to use codex here,/i.test(bodyText) && /environment for this repo\b/i.test(bodyText);
  const hasCodexReviewTemplate = /(?<!@)\bCodex Review\b/i.test(bodyText) && /\bReviewed commit:/i.test(bodyText);
  const hasCodexReviewContent = /\bcodex review\b/i.test(bodyText);
  const hasCodexReviewTrigger = /^\s*@codex\s+review\b/im.test(bodyText);
  const hasOurCodexReviewTriggerTemplate =
    /规则：任何\s*P1\/P2\s*必须给可执行复现/i.test(bodyText) ||
    /rules:\s*any\s*p1\/p2\s*must\s*include/i.test(bodyText);

  // Prefer explicit action markers in body
  const reviewed = bodyText.match(/^(.+?)\s+reviewed\s+\(/im);
  const commented = bodyText.match(/^(.+?)\s+left a comment\s+\(/im);
  const approved = bodyText.match(/^(.+?)\s+approved\s+\(/im);
  const changesRequested = bodyText.match(/^(.+?)\s+requested changes\s+\(/im);

  let reviewType: ReviewType = 'unknown';
  let reviewer: string | undefined;

  if (reviewed) {
    reviewType = 'reviewed';
    reviewer = reviewed[1]?.trim();
  } else if (commented) {
    reviewType = 'commented';
    reviewer = commented[1]?.trim();
  } else if (approved) {
    reviewType = 'approved';
    reviewer = approved[1]?.trim();
  } else if (changesRequested) {
    reviewType = 'changes_requested';
    reviewer = changesRequested[1]?.trim();
  }

  // Suppress our own "@codex review" trigger comment emails — they are not review feedback.
  if (reviewType === 'commented' && hasCodexReviewTrigger && hasOurCodexReviewTriggerTemplate) {
    return { ignorable: true, reviewType: 'unknown', reviewer: undefined };
  }

  // If the email contains the Codex review template but lacks explicit action markers,
  // treat it as a real review (not setup noise).
  if (reviewType === 'unknown' && hasCodexReviewTemplate) {
    reviewType = 'reviewed';
    const bot = bodyText.match(/\bchatgpt-codex-connector(?:\[bot\])?\b/i)?.[0];
    reviewer = bot ? bot : reviewer;
  }

  // Codex bot setup guidance (not a real review/comment we want to route).
  //
  // IMPORTANT: Scope this to setup-only Codex bot emails.
  // The same sentence can appear quoted inside real human comments/reviews.
  const isCodexBot = reviewer ? /^chatgpt-codex-connector(?:\[bot\])?$/i.test(reviewer) : false;
  if (hasSetupSentence && !hasCodexReviewContent && (!reviewer || isCodexBot)) {
    return { ignorable: true, reviewType: 'unknown', reviewer: undefined };
  }

  return { ignorable: false, reviewType, reviewer };
}

function hasCodexReviewTemplate(source: string): boolean {
  return /(?<!@)\bCodex Review\b/i.test(source) && /\bReviewed commit:/i.test(source);
}

export function parseGithubReviewFromSubjectAndSource(subject: string, source: string): ParsedGithubReviewMail | null {
  const inferred = source ? inferReviewActionFromEmailSource(source) : null;
  if (inferred?.ignorable) return null;

  let parsed = parseGithubReviewSubject(subject);
  if (!parsed) {
    // #257: removed strict hasReviewSignal gate — PR conversation comments
    // use Re: format without body action markers. PR guard prevents
    // issue-thread emails (Re: [repo] Issue (#N)) from being misclassified.
    // Codex P2: match the exact PR number — a cross-referenced /pull/42 link
    // in an issue #456 email must not trigger normalization for #456.
    const normalized = normalizeLegacyPrMarkerSubject(subject);
    if (normalized) {
      const prNumMatch = subject.match(/\(#(\d+)\)\s*$/);
      if (prNumMatch && new RegExp(`/pull/${prNumMatch[1]}\\b`).test(source)) {
        parsed = parseGithubReviewSubject(normalized);
      }
    }
  }
  if (!parsed) return null;

  const reviewType =
    parsed.reviewType === 'unknown' && inferred?.reviewType && inferred.reviewType !== 'unknown'
      ? inferred.reviewType
      : parsed.reviewType;
  const reviewer = parsed.reviewer ?? inferred?.reviewer;
  return { ...parsed, reviewType, reviewer };
}

// Match PR number — prefer "pull request #N" or trailing "(#N)", not first #token
const PR_NUMBER_PULL_REQUEST_REGEX = /pull request #(\d+)/i;
const PR_NUMBER_TRAILING_PR_PARENS_REGEX = /\(PR #(\d+)\)\s*$/i;
const PR_NUMBER_TRAILING_PARENS_REGEX = /\(#(\d+)\)\s*$/;
const PR_NUMBER_FALLBACK_REGEX = /#(\d+)/;

// Match repository from subject: "[owner/repo]"
const REPO_REGEX = /\[([^\]]+\/[^\]]+)\]/;

// Match review action: "@user approved/commented/requested changes on pull request"
const REVIEW_ACTION_REGEX = /@(\S+)\s+(approved|commented on|requested changes on)\s+pull request/i;

// Match PR title after "#123:"
const TITLE_AFTER_NUMBER_REGEX = /#\d+:\s*(.+)$/;

// Match PR title in parens: "PR Title (#123)"
const TITLE_IN_PARENS_REGEX = /\]\s*(.+?)\s*\(#\d+\)/;
const TITLE_IN_PR_PARENS_REGEX = /\]\s*(.+?)\s*\(PR #\d+\)/i;

export function parseGithubReviewSubject(subject: string): ParsedGithubReviewMail | null {
  // Extract PR number: prefer "pull request #N" > trailing "(#N)" > first "#N"
  const prPullReq = subject.match(PR_NUMBER_PULL_REQUEST_REGEX);
  const prTrailingPr = subject.match(PR_NUMBER_TRAILING_PR_PARENS_REGEX);
  const prTrailing = subject.match(PR_NUMBER_TRAILING_PARENS_REGEX);
  const prFallback = subject.match(PR_NUMBER_FALLBACK_REGEX);
  const prNumStr = prPullReq?.[1] ?? prTrailingPr?.[1] ?? prTrailing?.[1] ?? prFallback?.[1];
  if (!prNumStr) {
    return null;
  }
  const prNumber = parseInt(prNumStr, 10);

  // Extract repository
  const repoMatch = subject.match(REPO_REGEX);
  const repository = repoMatch?.[1];
  if (!repository) {
    return null;
  }

  // Extract review type and reviewer
  let reviewType: ReviewType = 'unknown';
  let reviewer: string | undefined;

  const actionMatch = subject.match(REVIEW_ACTION_REGEX);
  if (actionMatch) {
    reviewer = actionMatch[1];
    const action = actionMatch[2]?.toLowerCase();
    if (action === 'approved') {
      reviewType = 'approved';
    } else if (action === 'commented on') {
      reviewType = 'commented';
    } else if (action === 'requested changes on') {
      reviewType = 'changes_requested';
    }
  }

  // Guard: only accept subjects that look like PR review notifications.
  // Reject issue/discussion/other GitHub traffic (Cloud Codex P1-6 + 砚砚 R3 P1-1).
  // "Re:" alone is NOT enough — issue replies also start with "Re:".
  // Accept if: explicit review action OR "pull request" keyword in subject.
  const isPullRequest = /pull request/i.test(subject);
  const hasExplicitPrMarker = /\(PR #\d+\)/i.test(subject);
  if (!actionMatch && !isPullRequest && !hasExplicitPrMarker) {
    return null;
  }

  // Extract title
  let title = '';
  const titleAfterMatch = subject.match(TITLE_AFTER_NUMBER_REGEX);
  const titleAfter = titleAfterMatch?.[1];
  if (titleAfter) {
    title = titleAfter.trim();
  } else {
    const titleInPrParensMatch = subject.match(TITLE_IN_PR_PARENS_REGEX);
    const titleInPrParens = titleInPrParensMatch?.[1];
    if (titleInPrParens) {
      title = titleInPrParens.trim();
    }

    const titleInParensMatch = subject.match(TITLE_IN_PARENS_REGEX);
    const titleInParens = titleInParensMatch?.[1];
    if (titleInParens) {
      title = titleInParens.trim();
    }
  }

  return {
    prNumber,
    repository,
    title,
    reviewType,
    reviewer,
  };
}

/**
 * Extract cat name from PR title.
 * Supports two signature formats (per CLAUDE.md 签名规范):
 * - Breed name: "[布偶猫🐾]", "[缅因猫🐾]", "[暹罗猫🐾]"
 * - Nickname:   "[宪宪/Opus-46🐾]", "[砚砚/Codex🐾]", "[烁烁🐾]", "[Spark🐾]"
 */
export type CatTag = '布偶猫' | '缅因猫' | '暹罗猫';

// Match any [...🐾] tag and capture the inner text before the paw emoji
const CAT_TAG_REGEX = /\[([^\]]+?)🐾\]/;

// Nickname prefix → breed mapping (CLAUDE.md 猫猫花名册)
const NICKNAME_TO_BREED: Record<string, CatTag> = {
  布偶猫: '布偶猫',
  缅因猫: '缅因猫',
  暹罗猫: '暹罗猫',
  宪宪: '布偶猫',
  砚砚: '缅因猫',
  烁烁: '暹罗猫',
  Spark: '缅因猫',
};

export function extractCatFromTitle(title: string): CatTag | null {
  const match = title.match(CAT_TAG_REGEX);
  if (!match) return null;

  const inner = match[1]!;
  // Try direct match first (e.g. "布偶猫", "烁烁", "Spark")
  if (NICKNAME_TO_BREED[inner]) return NICKNAME_TO_BREED[inner];

  // Try nickname prefix before "/" (e.g. "宪宪/Opus-46" → "宪宪")
  const slashIdx = inner.indexOf('/');
  if (slashIdx > 0) {
    const prefix = inner.slice(0, slashIdx);
    if (NICKNAME_TO_BREED[prefix]) return NICKNAME_TO_BREED[prefix];
  }

  return null;
}

/**
 * Map cat tag to cat ID used in the system.
 */
export function catTagToCatId(tag: CatTag): string {
  switch (tag) {
    case '布偶猫':
      return 'opus';
    case '缅因猫':
      return 'codex';
    case '暹罗猫':
      return 'gemini';
  }
}

/**
 * Check if an email is from GitHub notifications.
 * Matches exact addresses or angle-bracket format (e.g. "GitHub <notifications@github.com>").
 */
const GITHUB_SENDER_REGEX = /(?:^|<)(notifications@github\.com|noreply@github\.com)(?:>|$)/i;

export function isGithubNotification(from: string): boolean {
  return GITHUB_SENDER_REGEX.test(from);
}
