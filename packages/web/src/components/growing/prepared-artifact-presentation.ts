import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';

type PreparedArtifactCoordinate = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;

export interface PreparedReviewCoordinate {
  reviewId: string;
  round: number;
}

const FALLBACK_TITLE = '准备好的作品';

/** A cat-prepared F309 review is named by its `content-review:<id>:round:<n>` preview coordinate. */
export function preparedReviewCoordinate(previewRef: string | undefined): PreparedReviewCoordinate | null {
  const match = /^content-review:(review-[a-f0-9]{64}):round:([1-9]\d*)$/.exec(previewRef ?? '');
  return match?.[1] && match[2] ? { reviewId: match[1], round: Number(match[2]) } : null;
}

/**
 * What the card calls the work. Refs and revisions are technical coordinates: they stay in the
 * details and data attributes, never in the title. Only an F309 review coordinate carries a real
 * version number; an F232 revision is a timestamp and is not shown as a version.
 */
export function preparedArtifactPresentation(
  coordinate: PreparedArtifactCoordinate,
  artifact?: GlobalArtifactDTO,
  reviewTitle?: string,
) {
  const review = preparedReviewCoordinate(coordinate.previewRef);
  const title = artifact?.name ?? reviewTitle ?? FALLBACK_TITLE;
  const version = review ? `第 ${coordinate.artifactRevision} 版` : undefined;
  return { review, title, version, label: version ? `${title} · ${version}` : title };
}
