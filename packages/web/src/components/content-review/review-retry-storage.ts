import { type ArtifactReviewCommand, artifactReviewCommandSchema } from '@cat-cafe/shared';

export function clearReviewRetryRecord(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Storage availability cannot change a successful server read or its authority. */
export function readReviewRetryRecord(
  key: string,
  reviewId: string,
): { available: boolean; command: ArtifactReviewCommand | null } {
  let stored: string | null;
  try {
    stored = localStorage.getItem(key);
  } catch {
    return { available: false, command: null };
  }
  if (!stored) return { available: true, command: null };
  try {
    const parsed = artifactReviewCommandSchema.safeParse(JSON.parse(stored));
    if (parsed.success && parsed.data.reviewId === reviewId) return { available: true, command: parsed.data };
  } catch {
    // Malformed JSON is an invalid retry record, not a failed authorized read.
  }
  clearReviewRetryRecord(key);
  return { available: true, command: null };
}
