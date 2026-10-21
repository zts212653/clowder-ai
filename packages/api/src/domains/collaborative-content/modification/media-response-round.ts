import type { ArtifactReviewRound } from '@cat-cafe/shared';

export function isModificationResultRound(
  round: ArtifactReviewRound,
  source: { requestId: string; round: number; reviewRevision: number; lastResultRound: number },
): boolean {
  if (round.responseSource)
    return (
      round.responseSource.round === source.round &&
      round.responseSource.requestId === source.requestId &&
      round.responseSource.reviewRevision >= source.reviewRevision
    );
  return round.number > source.round && round.number <= source.lastResultRound;
}
