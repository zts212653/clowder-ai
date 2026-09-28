'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function useReviewMediaSource(reviewId: string, round: number, onUnavailable: () => void) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revoked = useRef(onUnavailable);
  revoked.current = onUnavailable;
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setSrc(null);
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
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : '读取失败');
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reviewId, round]);
  return { src, error, setError };
}
