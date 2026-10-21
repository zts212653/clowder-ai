'use client';
import {
  type CollectiveArtifactProjection,
  type CollectiveMediaShareRef,
  type CollectiveRetainedMediaPage,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearCommittedDraft } from '@/components/content-review/review-draft-commit';
import { useReviewDraft } from '@/components/content-review/useReviewDraft';
import { readRetainedMediaPage, shareRetainedMediaFromHost } from './collective-media-share-client';

export function CollectiveMediaShare({
  reference,
  onDone,
}: {
  readonly reference: CollectiveMediaShareRef;
  readonly onDone: (artifact?: CollectiveArtifactProjection) => void;
}) {
  const [page, setPage] = useState<CollectiveRetainedMediaPage>();
  const [selected, setSelected] = useState<CollectiveRetainedMediaPage['items'][number]>();
  const draftKey = `collective-media-share:${JSON.stringify([
    reference.serviceInstanceId,
    reference.collectiveId,
    reference.humanId,
    reference.connectionId,
    reference.sourceEventId,
  ])}`;
  const draft = useReviewDraft(draftKey),
    title = draft.draft.body;
  const setTitle = (body: string) => draft.update({ body, anchor: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef(true);
  const base = `/api/plugins/official.collective-connector/connections/${encodeURIComponent(reference.connectionId)}/artifacts`;
  const load = useCallback(
    async (after?: string) => {
      setBusy(true);
      setError(undefined);
      try {
        const value = await readRetainedMediaPage(base, after);
        if (current.current) {
          setPage(value);
          setSelected(undefined);
        }
      } catch (failure) {
        if (current.current) setError(failure instanceof Error ? failure.message : '作品列表读取失败。');
      } finally {
        if (current.current) setBusy(false);
      }
    },
    [base],
  );
  useEffect(() => {
    current.current = true;
    void load();
    return () => {
      current.current = false;
    };
  }, [load]);
  async function share() {
    if (!selected || !title.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const artifact = await shareRetainedMediaFromHost(base, reference, selected, title, draftKey);
      clearCommittedDraft(draftKey, title);
      if (current.current) onDone(artifact);
    } catch (failure) {
      if (current.current) setError(failure instanceof Error ? failure.message : '分享尚未确认。');
    } finally {
      if (current.current) setBusy(false);
    }
  }
  return (
    <section
      role="dialog"
      aria-label="从此 Café 分享图片或视频"
      className="absolute inset-0 z-30 overflow-y-auto bg-cafe-surface p-6"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <h2 className="text-lg font-semibold">从此 Café 分享图片或视频</h2>
        <p>选择已发布的 PNG 图片或 MP4 视频，分享后回到原讨论。成员可阅读和批注。</p>
        {page && page.items.length === 0 && <p>这一页没有可分享的作品。</p>}
        {page?.items.map((item) => (
          <label key={item.contentRef} className="flex gap-3 rounded border p-3">
            <input
              type="radio"
              name="retained-media"
              checked={selected?.contentRef === item.contentRef}
              disabled={busy}
              onChange={() => {
                setSelected(item);
                if (!draft.hasDraft || selected) setTitle(item.label.replace(/\.(png|mp4)$/i, ''));
              }}
            />
            {item.label} · 第 {item.ownerRevision} 版 · {item.mediaType === 'image/png' ? '图片' : '视频'}
          </label>
        ))}
        {selected && (
          <label>
            作品名称
            <input
              aria-label="作品名称"
              className="ml-3 rounded border p-2"
              maxLength={200}
              value={title}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        {draft.storageError && <p role="alert">名称尚未保存到浏览器，请保留页面并恢复存储后重试。</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => onDone()}>
            返回原讨论
          </button>
          <button type="button" disabled={busy} onClick={() => void load()}>
            重新读取
          </button>
          {page?.nextCursor && (
            <button type="button" disabled={busy} onClick={() => void load(page.nextCursor)}>
              下一页
            </button>
          )}
          <button
            type="button"
            disabled={!selected || !title.trim() || busy || draft.storageError}
            onClick={() => void share()}
          >
            {busy ? '正在处理…' : '分享所选作品'}
          </button>
        </div>
      </div>
    </section>
  );
}
