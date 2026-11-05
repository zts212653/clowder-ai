'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** A WebP display projection keeps its exact authorized source path; source/download reads remain byte exact. */
export function reviewMediaDisplayPath(path: string, mediaType?: string): string {
  return mediaType === 'image/webp' ? `${path}${path.includes('?') ? '&' : '?'}display=oriented` : path;
}

export function useReviewMediaSource(reviewId: string, round: number, onUnavailable: () => void, mediaType?: string) {
  const [src, setSrc] = useState<string | null>(null);
  const [downloadSrc, setDownloadSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoked = useRef(onUnavailable);
  revoked.current = onUnavailable;
  useEffect(() => {
    const abort = new AbortController();
    const objectUrls: string[] = [];
    setSrc(null);
    setDownloadSrc(null);
    setError(null);
    void apiFetch(`/api/artifact-reviews/${encodeURIComponent(reviewId)}/media/${round}`, { signal: abort.signal })
      .then(async (response) => {
        if (abort.signal.aborted) return;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) revoked.current();
          throw new Error('媒体暂时无法读取，请刷新重试。');
        }
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        const original = URL.createObjectURL(blob);
        objectUrls.push(original);
        if (mediaType !== 'image/webp') {
          setDownloadSrc(original);
          setSrc(original);
          return;
        }
        const display = await apiFetch(
          reviewMediaDisplayPath(`/api/artifact-reviews/${encodeURIComponent(reviewId)}/media/${round}`, mediaType),
          { signal: abort.signal },
        );
        if (!display.ok) {
          if ([401, 403, 404, 410].includes(display.status)) revoked.current();
          throw new Error('媒体暂时无法读取，请刷新重试。');
        }
        const pixels = await display.blob();
        if (abort.signal.aborted) return;
        const projected = URL.createObjectURL(pixels);
        objectUrls.push(projected);
        setDownloadSrc(original);
        setSrc(projected);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败');
      });
    return () => {
      abort.abort();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [reviewId, round, mediaType]);
  return { src, downloadSrc, error, setError };
}
