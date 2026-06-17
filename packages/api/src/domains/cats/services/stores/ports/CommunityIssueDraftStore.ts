/**
 * F235: Community Issue Draft Store — Port interface.
 *
 * Lifecycle: draft → published | cancelled (terminal, no further transitions).
 * User-visible data → persistent by default (Iron Law #5, LL-048).
 */

import type { CommunityIssueDraft, CreateCommunityIssueDraftInput } from '@cat-cafe/shared';

// ── Publish result ────────────────────────────────────────────

export interface PublishDraftInput {
  readonly draftId: string;
  readonly githubIssueNumber: number;
  readonly githubIssueUrl: string;
}

// ── Port interface ────────────────────────────────────────────

export interface ICommunityIssueDraftStore {
  /** Create a draft from sanitized content. Throws if sourceId already has a non-cancelled draft (INV-3). */
  create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft>;

  /** Get draft by ID. Returns null if not found. */
  getById(draftId: string): Promise<CommunityIssueDraft | null>;

  /** Get active (non-cancelled) draft by source ID. Returns null if no active draft. */
  getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null>;

  /** Mark as published with GitHub issue result. Throws if not draft (INV-1). */
  publish(input: PublishDraftInput): Promise<CommunityIssueDraft>;

  /** Mark as cancelled. Throws if not draft (INV-1). */
  cancel(draftId: string): Promise<CommunityIssueDraft>;

  /** Update title and body (user edits in preview card). Throws if not draft. */
  updateContent(draftId: string, title: string, bodyMarkdown: string): Promise<CommunityIssueDraft>;
}
