/**
 * F222: Frustration Auto-Issue Store — Port interface.
 *
 * Lifecycle: draft → confirmed | skipped | false_positive (one-way, no CAS needed).
 * User-visible data → persistent by default (Iron Law #5, LL-048).
 */

import type { CreateFrustrationIssueInput, FrustrationIssue } from '@cat-cafe/shared';

// ── Input types ────────────────────────────────────────────────

export interface ConfirmIssueInput {
  issueId: string;
  userDescription?: string;
}

// ── Port interface ─────────────────────────────────────────────

export interface IFrustrationIssueStore {
  /** Create a draft issue from detected frustration signal. */
  create(input: CreateFrustrationIssueInput): Promise<FrustrationIssue>;

  /** Get issue by ID. Returns null if not found. */
  getById(issueId: string): Promise<FrustrationIssue | null>;

  /** User confirms the auto-issue. Sets status=confirmed + confirmedAt. */
  confirm(input: ConfirmIssueInput): Promise<FrustrationIssue | null>;

  /** User skips/dismisses the auto-issue. Sets status=skipped + skippedAt. */
  skip(issueId: string): Promise<FrustrationIssue | null>;

  /** User flags as false positive (UX-1). Sets status=false_positive + falsePositiveAt. */
  markFalsePositive(issueId: string): Promise<FrustrationIssue | null>;

  /** Set the card message ID (visibility marker). */
  setCardMessageId(issueId: string, cardMessageId: string): Promise<void>;

  /** Link a community issue draft to this frustration issue (F235). */
  setCommunityIssueDraftId(issueId: string, draftId: string): Promise<void>;

  /** List issues in a thread, sorted by createdAt desc. */
  listByThread(threadId: string): Promise<FrustrationIssue[]>;

  /** List confirmed issues for a user (for eval:task-outcome consumption). */
  listConfirmed(userId: string): Promise<FrustrationIssue[]>;

  /** List draft (pending) issues for a user. */
  listDraft(userId: string): Promise<FrustrationIssue[]>;

  /** List ALL issues for a user (draft + confirmed + skipped), sorted by createdAt desc. */
  listAll(userId: string): Promise<FrustrationIssue[]>;
}
