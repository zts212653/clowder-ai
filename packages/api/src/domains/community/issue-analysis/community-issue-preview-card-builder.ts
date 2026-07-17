/**
 * F235: Rich block builders for community issue preview cards.
 *
 * Two states:
 * - Draft preview: shows content + edit affordance (dispatched by frontend)
 * - Published: collapsed success card with GitHub issue link
 */

import type { CommunityIssueDraft, RichCardBlock } from '@cat-cafe/shared';

// ── Draft preview card ────────────────────────────────────────

/**
 * Build preview card for a draft community issue.
 * Frontend renders this with editable fields + submit/cancel buttons.
 */
export function buildCommunityIssuePreviewCard(draft: CommunityIssueDraft): RichCardBlock {
  const previewBody = [`**${draft.title}**`, '', draft.bodyMarkdown].join('\n');

  return {
    id: `community-preview-${draft.draftId}`,
    kind: 'card',
    v: 1,
    title: 'Publish to Community',
    bodyMarkdown: previewBody,
    tone: 'info',
    fields: [
      { label: 'Repository', value: draft.targetRepo },
      { label: 'Labels', value: draft.labels.join(', ') || 'none' },
      { label: 'Status', value: draft.status },
    ],
    meta: {
      kind: 'community_issue_preview',
      draftId: draft.draftId,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
    },
  };
}

// ── Published card ────────────────────────────────────────────

/**
 * Build success card for a published community issue.
 * Shows GitHub issue link in a collapsed success state.
 */
export function buildCommunityIssuePublishedCard(draft: CommunityIssueDraft): RichCardBlock {
  const publishedBody = [
    `Published as [#${draft.githubIssueNumber}](${draft.githubIssueUrl})`,
    '',
    `**${draft.title}**`,
    '',
    `[View on GitHub](${draft.githubIssueUrl})`,
  ].join('\n');

  return {
    id: `community-preview-${draft.draftId}`,
    kind: 'card',
    v: 1,
    title: 'Published to Community',
    bodyMarkdown: publishedBody,
    tone: 'success',
    fields: [
      { label: 'Repository', value: draft.targetRepo },
      { label: 'Issue', value: `#${draft.githubIssueNumber}` },
      { label: 'Status', value: 'published' },
    ],
    meta: {
      kind: 'community_issue_preview',
      draftId: draft.draftId,
      sourceType: draft.sourceType,
      sourceId: draft.sourceId,
    },
  };
}
