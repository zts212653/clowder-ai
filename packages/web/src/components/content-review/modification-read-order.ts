import type { ContentModificationRequestView } from '@cat-cafe/shared';

export function olderModificationRead(
  prior: ContentModificationRequestView | null,
  next: ContentModificationRequestView,
): boolean {
  return Boolean(
    prior &&
      prior.record.requestId === next.record.requestId &&
      (prior.record.revision > next.record.revision || (prior.record.control && !next.record.control)),
  );
}
