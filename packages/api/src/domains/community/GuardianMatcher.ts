import type { CatId, ReviewPolicy, Roster } from '@cat-cafe/shared';
import { createCatId } from '@cat-cafe/shared';
import { getDefaultCatId, getReviewPolicy, getRoster } from '../../config/cat-config-loader.js';

export interface GuardianMatchOptions {
  author: CatId;
  reviewer: CatId;
  policy?: Partial<ReviewPolicy>;
  threadActivity?: Record<string, number>;
}

export interface GuardianMatchResult {
  guardian: CatId;
  isDegraded: boolean;
  degradeReason?: string;
  candidates: readonly CatId[];
}

export async function resolveGuardian(options: GuardianMatchOptions): Promise<GuardianMatchResult> {
  const roster = getRoster();
  const defaultPolicy = getReviewPolicy();
  const policy: ReviewPolicy = { ...defaultPolicy, ...options.policy };
  const authorId = options.author as string;
  const reviewerId = options.reviewer as string;
  const authorEntry = roster[authorId];

  if (!authorEntry) {
    return { guardian: getDefaultCatId(), isDegraded: false, candidates: [] };
  }

  const eligible = Object.entries(roster).filter(
    ([id, entry]) => id !== authorId && id !== reviewerId && entry.available !== false,
  );

  const differentFamily = eligible.filter(([_, e]) => e.family !== authorEntry.family);
  const sameFamily = eligible.filter(([_, e]) => e.family === authorEntry.family);
  const activity = options.threadActivity ?? {};

  const sort = (arr: Array<[string, Roster[string]]>) =>
    [...arr].sort((a, b) => {
      const actDiff = (activity[b[0]] ?? 0) - (activity[a[0]] ?? 0);
      if (actDiff !== 0) return actDiff;
      if (policy.preferLead) {
        if (b[1].lead && !a[1].lead) return 1;
        if (a[1].lead && !b[1].lead) return -1;
      }
      return 0;
    });

  const allIds = eligible.map(([id]) => createCatId(id));

  if (differentFamily.length > 0) {
    const sorted = sort(differentFamily);
    return { guardian: createCatId(sorted[0][0]), isDegraded: false, candidates: allIds };
  }

  if (sameFamily.length > 0) {
    const sorted = sort(sameFamily);
    return {
      guardian: createCatId(sorted[0][0]),
      isDegraded: true,
      degradeReason: 'No different-family guardians available',
      candidates: allIds,
    };
  }

  return {
    guardian: getDefaultCatId(),
    isDegraded: true,
    degradeReason: 'No guardians available',
    candidates: allIds,
  };
}
