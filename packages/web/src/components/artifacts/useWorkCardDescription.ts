'use client';
import { FEATURE_DEMOS, type WorkReference, workReferenceSchema } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '@/utils/api-client';

const descriptionSchema = z.object({
  asset: workReferenceSchema.extend({ mediaType: z.string(), blobDigest: z.string() }).passthrough(),
  currentOwnerRevision: z.number().int().positive().safe(),
  origin: z.object({ publisherCatId: z.string().optional() }).passthrough().optional(),
});
export type WorkCardDescription = z.infer<typeof descriptionSchema>;

/** A shipped demo poster is used only for the exact registered cut, never a same-named file. */
export function workVideoDemo(description: WorkCardDescription | null | undefined) {
  return (
    description &&
    Object.values(FEATURE_DEMOS).find((demo) => demo.sha256 && `sha256:${demo.sha256}` === description.asset.blobDigest)
  );
}

export async function readWorkCardDescription(reference: WorkReference, current = false, signal?: AbortSignal) {
  const query = current ? '' : `?ownerRevision=${reference.ownerRevision}`;
  const response = await apiFetch(`/api/content-publications/${encodeURIComponent(reference.contentRef)}${query}`, {
    signal,
  });
  if (!response.ok) throw new Error('原作品暂时无法打开，请保留这条引用后重试。');
  const result = descriptionSchema.parse(await response.json());
  const revision = current ? result.currentOwnerRevision : reference.ownerRevision;
  if (
    result.asset.contentRef !== reference.contentRef ||
    result.asset.ownerRevision !== revision ||
    result.currentOwnerRevision < revision
  )
    throw new Error('原作品版本暂时无法核对，没有换成其它版本。');
  return result;
}

export function useWorkCardDescription(reference: WorkReference | undefined, enabled: boolean) {
  const contentRef = reference?.contentRef;
  const ownerRevision = reference?.ownerRevision;
  const key = contentRef ? JSON.stringify([contentRef, ownerRevision]) : '';
  const [loaded, setLoaded] = useState<{ key: string; data: WorkCardDescription | null }>();
  useEffect(() => {
    if (!contentRef || !ownerRevision || !enabled) return;
    const abort = new AbortController();
    void readWorkCardDescription({ contentRef, ownerRevision }, false, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setLoaded({ key, data });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoaded({ key, data: null });
      });
    return () => abort.abort();
  }, [key, contentRef, ownerRevision, enabled]);
  return {
    description: loaded?.key === key ? loaded.data : null,
    loading: !!reference && loaded?.key !== key,
  };
}
