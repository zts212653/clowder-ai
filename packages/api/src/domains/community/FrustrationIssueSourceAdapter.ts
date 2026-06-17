/**
 * F235 KD-6: Source adapter — converts a confirmed FrustrationIssue into a
 * sanitized CommunityIssueDraft. Generic pipeline: other source types
 * (e.g. cat-initiated issues) plug in as new adapters in Phase B.
 */

import type { CommunityIssueDraft, FrustrationIssue, FrustrationSignalType } from '@cat-cafe/shared';
import type { ICommunityIssueDraftStore } from '../cats/services/stores/ports/CommunityIssueDraftStore.js';
import { sanitize } from './CommunityIssueSanitizer.js';

// ── Config ────────────────────────────────────────────────────

export interface SourceAdapterConfig {
  readonly defaultRepo: string;
  readonly repoAllowlist: readonly string[];
}

export interface SourceAdapterDeps {
  readonly draftStore: ICommunityIssueDraftStore;
  readonly config: SourceAdapterConfig;
}

// ── Title generators per signal type ──────────────────────────

const SIGNAL_TITLES: Record<FrustrationSignalType, (detail: Record<string, unknown>) => string> = {
  cancel_burst: (d) =>
    `Permission prompts too frequent (${d.cancelCount ?? '?'} cancels in ${Math.round(Number(d.windowMs ?? 0) / 1000)}s)`,
  cli_error: (d) => (d.publicSummary ? String(d.publicSummary) : `CLI error: ${d.reasonCode ?? 'unknown'}`),
  text_frustration: () => 'User reported frustration during conversation',
  a2a_timeout: () => 'Agent-to-agent communication timeout',
  retry_burst: () => 'Excessive retry attempts detected',
  user_report: () => 'User-reported issue',
};

// ── Body builder ──────────────────────────────────────────────

function buildBody(issue: FrustrationIssue): string {
  const sections: string[] = [];

  // Problem section
  if (issue.userDescription) {
    sections.push(`## Problem\n\n${issue.userDescription}`);
  } else {
    const titleFn = SIGNAL_TITLES[issue.signalType];
    sections.push(`## Problem\n\n${titleFn(issue.signalDetail)}`);
  }

  // Context section
  const contextLines: string[] = [];
  contextLines.push(`- **Signal type:** ${issue.signalType}`);

  const detail = issue.signalDetail;
  if (issue.signalType === 'cancel_burst' && detail.cancelCount) {
    contextLines.push(
      `- **Cancel count:** ${detail.cancelCount} in ${Math.round(Number(detail.windowMs ?? 0) / 1000)}s`,
    );
  }
  if (issue.signalType === 'cli_error') {
    if (detail.reasonCode) contextLines.push(`- **Error code:** ${detail.reasonCode}`);
    if (detail.publicHint) contextLines.push(`- **Hint:** ${detail.publicHint}`);
  }

  sections.push(`## Context\n\n${contextLines.join('\n')}`);

  // Conversation context note (B-lite: raw messages are NOT included in public drafts
  // to eliminate unbounded data-leakage surface. Full context is retained locally in the
  // FrustrationIssue record. Only structured, safe fields appear in the published issue.)
  if (issue.context.recentMessages?.length) {
    sections.push(
      `## Conversation Context\n\n*${issue.context.recentMessages.length} conversation messages were recorded locally but are not included in this public report for privacy.*`,
    );
  }

  // Footer
  sections.push('---\n*Reported via Clowder AI*');

  return sections.join('\n\n');
}

// ── Adapter entry point ───────────────────────────────────────

/**
 * Create a sanitized community issue draft from a confirmed FrustrationIssue.
 *
 * @throws if issue is not confirmed
 * @throws if store rejects (duplicate sourceId, etc.)
 */
export async function createDraftFromFrustrationIssue(
  issue: FrustrationIssue,
  deps: SourceAdapterDeps,
): Promise<CommunityIssueDraft> {
  // Guard: only confirmed issues can become community drafts
  if (issue.status !== 'confirmed') {
    throw new Error(`FrustrationIssue ${issue.issueId} is not confirmed (status: ${issue.status})`);
  }

  // Generate title
  const titleFn = SIGNAL_TITLES[issue.signalType] ?? SIGNAL_TITLES.user_report;
  const rawTitle = titleFn(issue.signalDetail);

  // Generate body
  const rawBody = buildBody(issue);

  // Sanitize (KD-4: deny-list + fail-closed post-check, defense-in-depth)
  // Primary safety: structured-only output (no raw conversation text).
  // Secondary safety: deny-list catches known dangerous patterns in userDescription.
  // Server re-sanitizes on publish (third layer).
  const sanitized = sanitize(rawTitle, rawBody);

  // Determine labels from signal type
  const labels = inferLabels(issue.signalType);

  // Create draft in store
  const draft = await deps.draftStore.create({
    sourceType: 'frustration_issue',
    sourceId: issue.issueId,
    title: sanitized.title,
    bodyMarkdown: sanitized.bodyMarkdown,
    targetRepo: deps.config.defaultRepo,
    labels,
    threadId: issue.threadId,
    userId: issue.userId,
  });

  return draft;
}

// ── Label inference ───────────────────────────────────────────

function inferLabels(signalType: FrustrationSignalType): string[] {
  const base = ['user-reported'];
  switch (signalType) {
    case 'cli_error':
      return [...base, 'bug'];
    case 'cancel_burst':
      return [...base, 'ux'];
    case 'text_frustration':
      return [...base, 'ux'];
    case 'a2a_timeout':
      return [...base, 'bug', 'performance'];
    case 'retry_burst':
      return [...base, 'bug'];
    case 'user_report':
      return [...base];
    default:
      return base;
  }
}
