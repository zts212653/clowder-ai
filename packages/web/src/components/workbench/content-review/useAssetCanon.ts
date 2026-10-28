'use client';
import type { AssetCanonItem, AssetCanonUpdate, WorkContextRecord } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { type CanonPage, canonCommand, readCanonPages } from './asset-canon-client';

export function useAssetCanon(record: WorkContextRecord | null) {
  const threadId = useChatStore((s) => s.currentThreadId);
  const [refresh, setRefresh] = useState(0);
  const [items, setItems] = useState<Record<string, AssetCanonItem>>({});
  const [updates, setUpdates] = useState<AssetCanonUpdate[]>([]);
  const [error, setError] = useState('');
  const loadedScope = useRef('');
  const ref = record?.reference.contentRef,
    revision = record?.reference.ownerRevision,
    metadata = record?.metadataRevision;
  useEffect(() => {
    const abort = new AbortController();
    const scope = JSON.stringify([threadId, ref, revision, metadata]);
    if (loadedScope.current !== scope) {
      setItems({});
      setUpdates([]);
      loadedScope.current = scope;
    }
    if (!threadId || !ref || !revision || !metadata) return () => abort.abort();
    const reference = { contentRef: ref, ownerRevision: revision };
    const mergeItems = (page: CanonPage) => {
      if (!abort.signal.aborted)
        setItems((previous) => ({ ...previous, ...Object.fromEntries(page.items.map((i) => [i.work!.assetId, i])) }));
    };
    const loadUpdates = async () => {
      let after: number | undefined = 0;
      let snapshot: string | undefined;
      const notices: AssetCanonUpdate[] = [];
      do {
        const page: CanonPage = await canonCommand(
          threadId,
          { action: 'check-asset-updates', reference, metadataRevision: metadata, after, limit: 50 },
          abort.signal,
        );
        if (snapshot && page.snapshot !== snapshot) throw new Error('Asset snapshot changed');
        snapshot = page.snapshot;
        mergeItems(page);
        notices.push(...(page.updates ?? []));
        after = page.nextAfter;
      } while (after !== undefined && !abort.signal.aborted);
      if (!abort.signal.aborted) {
        setUpdates([
          ...new Map(
            notices.map((n) => [`${n.original.record.indexedVersionRef}:${n.noticeScope}:${n.updateFingerprint}`, n]),
          ).values(),
        ]);
        setError('');
      }
    };
    let metadataLoaded = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (initial: boolean) => {
      try {
        if (!metadataLoaded) {
          await readCanonPages(threadId, reference, metadata, abort.signal, mergeItems);
          metadataLoaded = true;
        }
        if (initial || document.visibilityState !== 'hidden') await loadUpdates();
      } catch {
        if (!abort.signal.aborted) setError('素材标记暂时无法读取，原件仍可查看。');
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(false), 30_000);
      }
    };
    void poll(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [threadId, ref, revision, metadata, refresh]);
  return { items, updates, error, threadId, refresh: useCallback(() => setRefresh((n) => n + 1), []) };
}
