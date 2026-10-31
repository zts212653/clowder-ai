'use client';

import { useEffect, useState } from 'react';
import { useReviewMediaSource } from '@/components/content-review/useReviewMediaSource';
import { apiFetch } from '@/utils/api-client';
import type { PreparedReviewCoordinate } from './prepared-artifact-presentation';

/**
 * The review's own title names the work (the upload path does not). Until it is read — or if the
 * read fails — callers show a neutral label; a failed read never becomes a claim about the work.
 */
export function usePreparedReviewTitle(reviewId: string | null): string | undefined {
  const [title, setTitle] = useState<string>();
  useEffect(() => {
    setTitle(undefined);
    if (!reviewId) return;
    const abort = new AbortController();
    void apiFetch(`/api/artifact-reviews/${encodeURIComponent(reviewId)}`, { signal: abort.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { review?: { title?: unknown } }) : null))
      .then((body) => {
        const value = body?.review?.title;
        if (!abort.signal.aborted && typeof value === 'string' && value.trim()) setTitle(value.trim());
      })
      .catch(() => {
        // Display-only read: the neutral label stays; the review surface reports real access errors.
      });
    return () => abort.abort();
  }, [reviewId]);
  return title;
}

export function PreparedReviewThumbnail({ coordinate, alt }: { coordinate: PreparedReviewCoordinate; alt: string }) {
  const [unavailable, setUnavailable] = useState(false);
  const { src } = useReviewMediaSource(coordinate.reviewId, coordinate.round, () => setUnavailable(true));
  if (unavailable || !src) return null;
  return (
    // biome-ignore lint/performance/noImgElement: review media is an authenticated object URL, not a Next image asset.
    <img src={src} alt={alt} className="mt-3 max-h-44 w-full rounded-lg border border-cafe-subtle object-contain" />
  );
}
