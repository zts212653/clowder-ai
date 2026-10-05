'use client';
import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export type CompareMediaVersion = { asset: ReviewedMediaAsset; label: string; mediaPath?: string };
export function compareMediaPath(version: CompareMediaVersion): string {
  return (
    version.mediaPath ??
    `/api/content-publications/${encodeURIComponent(version.asset.contentRef)}/media/${version.asset.ownerRevision}`
  );
}
export function compareMediaKey(versions: readonly CompareMediaVersion[]): string {
  return JSON.stringify(versions.map((version) => [compareMediaPath(version), version.asset.blobDigest]));
}

/** A pair is displayed only for its exact read identity. A denied half closes both previews. */
export function useCompareMediaSources(versions: readonly CompareMediaVersion[], onUnavailable?: () => void) {
  const key = compareMediaKey(versions);
  const pathKey = JSON.stringify(versions.map(compareMediaPath));
  const [state, setState] = useState<{ key: string; sources: string[]; error: string | null } | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    const paths: string[] = JSON.parse(pathKey);
    void Promise.all(
      paths.map(async (path) => {
        const response = await apiFetch(path, { signal: abort.signal });
        if (abort.signal.aborted) return null;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) unavailable.current?.();
          throw new Error(
            [401, 403, 404, 410].includes(response.status) ? '此版本当前不可访问。' : '版本读取失败，请重新打开对比。',
          );
        }
        const blob = await response.blob();
        if (abort.signal.aborted) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return url;
      }),
    )
      .then((sources) => {
        if (!abort.signal.aborted && sources.every((src): src is string => src !== null))
          setState({ key, sources, error: null });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          setState({ key, sources: [], error: error instanceof Error ? error.message : '版本读取失败。' });
          abort.abort();
          for (const url of urls) URL.revokeObjectURL(url);
        }
      });
    return () => {
      abort.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [key, pathKey]);
  return state?.key === key ? state : { key, sources: [], error: null };
}
