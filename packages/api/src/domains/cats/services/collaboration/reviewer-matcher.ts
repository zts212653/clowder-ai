/**
 * Reviewer Matcher
 * F032: Dynamic reviewer selection based on roster, availability, and thread activity.
 *
 * Rules (铲屎官 confirmed):
 * 1. Must be different from author
 * 2. Must have 'peer-reviewer' role
 * 3. Must be available (有猫粮！40 美刀教训)
 * 4. Prefer different family
 * 5. Prefer lead
 * 6. Prefer active in current thread
 * 7. Degrade to same-family lead if no cross-family reviewer available
 */

import type { CatId, ReviewPolicy, Roster } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { getDefaultCatId, getReviewPolicy, getRoster } from '../../../../config/cat-config-loader.js';
import { createModuleLogger } from '../../../../infrastructure/logger.js';

const log = createModuleLogger('reviewer-matcher');

export interface ReviewerMatchOptions {
  /** The author who needs a reviewer */
  author: CatId;
  /** Thread ID for activity lookup (optional — Phase C) */
  threadId?: string;
  /** Override default policy */
  policy?: Partial<ReviewPolicy>;
  /**
   * F032 Phase C: Thread activity scores (lastMessageAt per cat).
   * Caller should populate from threadStore.getParticipantsWithActivity().
   * Map: catId → lastMessageAt timestamp
   */
  threadActivity?: Record<string, number>;
}

export interface ReviewerMatchResult {
  /** Selected reviewer catId */
  reviewer: CatId;
  /** Whether this is a degraded match (same family) */
  isDegraded: boolean;
  /** Reason for degradation (if any) */
  degradeReason?: string;
  /** All candidates considered (for debugging) */
  candidates: readonly CatId[];
}

/**
 * F032 Phase C: Get thread activity scores from options.
 * Activity data should be populated by caller from threadStore.getParticipantsWithActivity().
 */
function getThreadActivity(options: ReviewerMatchOptions): Record<string, number> {
  // Return provided activity data, or empty object if not available
  return options.threadActivity ?? {};
}

/**
 * Resolve the best reviewer for an author.
 * Considers: roles, availability, family, lead status, thread activity.
 */
export async function resolveReviewer(options: ReviewerMatchOptions): Promise<ReviewerMatchResult> {
  const roster = getRoster();
  const defaultPolicy = getReviewPolicy();
  const policy: ReviewPolicy = { ...defaultPolicy, ...options.policy };

  const authorId = options.author as string;
  const authorEntry = roster[authorId];

  // If author not in roster, we can't determine family → use default cat
  if (!authorEntry) {
    return {
      reviewer: getDefaultCatId(),
      isDegraded: false,
      candidates: [],
    };
  }

  // 1. Find all cats with peer-reviewer role
  const allReviewers = Object.entries(roster).filter(
    ([id, entry]) => id !== authorId && entry.roles.includes('peer-reviewer'),
  );

  // 2. Filter by availability (铲屎官 40 美刀教训！)
  const availableReviewers = policy.excludeUnavailable
    ? allReviewers.filter(([_, entry]) => entry.available !== false)
    : allReviewers;

  // 3. Separate by family
  const differentFamily = availableReviewers.filter(([_, entry]) => entry.family !== authorEntry.family);
  const sameFamily = availableReviewers.filter(([_, entry]) => entry.family === authorEntry.family);

  // 4. Get thread activity for sorting (F032 Phase C)
  const activity = policy.preferActiveInThread ? getThreadActivity(options) : {};

  // Sort function: activity desc, then lead first
  const sortCandidates = (candidates: Array<[string, Roster[string]]>): Array<[string, Roster[string]]> => {
    return [...candidates].sort((a, b) => {
      // First by activity (higher = better)
      const activityDiff = (activity[b[0]] ?? 0) - (activity[a[0]] ?? 0);
      if (activityDiff !== 0) return activityDiff;

      // Then by lead status (lead first)
      if (policy.preferLead) {
        if (b[1].lead && !a[1].lead) return 1;
        if (a[1].lead && !b[1].lead) return -1;
      }

      return 0;
    });
  };

  const allCandidateIds = availableReviewers.map(([id]) => createCatId(id));

  // 5. Try different-family first (preferred)
  if (policy.requireDifferentFamily || differentFamily.length > 0) {
    const sorted = sortCandidates(differentFamily);
    if (sorted.length > 0) {
      return {
        reviewer: createCatId(sorted[0]?.[0]),
        isDegraded: false,
        candidates: allCandidateIds,
      };
    }
  }

  // 6. Degrade to same-family if no cross-family available
  if (sameFamily.length > 0) {
    // Only consider leads for degradation
    const sameFamilyLeads = sameFamily.filter(([_, entry]) => entry.lead);
    const sorted = sortCandidates(sameFamilyLeads.length > 0 ? sameFamilyLeads : sameFamily);

    if (sorted.length > 0) {
      const degradeReason =
        differentFamily.length === 0
          ? 'No different-family reviewers available (all unavailable or no peer-reviewer role)'
          : 'Different-family reviewers filtered out by policy';

      log.warn({ authorId, degradeReason }, `[resolveReviewer] Degraded to same-family`);

      return {
        reviewer: createCatId(sorted[0]?.[0]),
        isDegraded: true,
        degradeReason,
        candidates: allCandidateIds,
      };
    }
  }

  // 7. Ultimate fallback: default cat
  log.warn({ authorId }, `[resolveReviewer] No reviewers available. Using default cat.`);
  return {
    reviewer: getDefaultCatId(),
    isDegraded: true,
    degradeReason: 'No reviewers available at all',
    candidates: allCandidateIds,
  };
}

/**
 * Get all available reviewers for an author (for UI display).
 * Returns sorted list by preference.
 */
export async function getAvailableReviewers(options: ReviewerMatchOptions): Promise<readonly CatId[]> {
  const result = await resolveReviewer(options);
  return result.candidates;
}

/**
 * Check if a specific cat can review another cat's code.
 * Returns { canReview, reason }.
 */
export function canReview(reviewer: CatId, author: CatId): { canReview: boolean; reason: string } {
  const roster = getRoster();
  const policy = getReviewPolicy();

  const reviewerId = reviewer as string;
  const authorId = author as string;

  // Self-review not allowed
  if (reviewerId === authorId) {
    return { canReview: false, reason: 'Cannot review own code' };
  }

  const reviewerEntry = roster[reviewerId];
  const authorEntry = roster[authorId];

  // Reviewer must be in roster
  if (!reviewerEntry) {
    return {
      canReview: false,
      reason: `Reviewer "${reviewerId}" not in roster`,
    };
  }

  // Reviewer must have peer-reviewer role
  if (!reviewerEntry.roles.includes('peer-reviewer')) {
    return {
      canReview: false,
      reason: `"${reviewerId}" does not have peer-reviewer role`,
    };
  }

  // Reviewer must be available
  if (policy.excludeUnavailable && reviewerEntry.available === false) {
    return {
      canReview: false,
      reason: `"${reviewerId}" is not available (没猫粮！)`,
    };
  }

  // Check family requirement
  if (policy.requireDifferentFamily && authorEntry) {
    if (reviewerEntry.family === authorEntry.family) {
      return {
        canReview: false,
        reason: `Same family (${reviewerEntry.family}) — different family required`,
      };
    }
  }

  return { canReview: true, reason: 'OK' };
}
