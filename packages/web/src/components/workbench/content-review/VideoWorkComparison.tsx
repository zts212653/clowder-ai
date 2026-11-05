'use client';
import {
  type ReviewedMediaAsset,
  reviewedMediaAssetSchema,
  type WorkContextRecord,
  type WorkReference,
  type WorkVideoContext,
  workVersionRecordSchema,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { checked, json } from '@/components/content-review/modification-http';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import { VideoComparisonPlayback } from './VideoComparisonPlayback';

async function loadComparison(contentRef: string, left: number, right: number, threadId: string, signal: AbortSignal) {
  const value = await checked<{ asset: unknown }>(
    await apiFetch(`/api/content-publications/${encodeURIComponent(contentRef)}?ownerRevision=${left}`, {
      signal: signal,
    }),
  );
  const verified = reviewedMediaAssetSchema.parse(value.asset);
  if (verified.contentRef !== contentRef || verified.ownerRevision !== left || verified.media.kind !== 'video')
    throw new Error('对比版本不一致。');
  const rows = [];
  // The summary is bounded; larger histories remain individually selectable.
  for (
    let revision = Math.max(Math.min(left, right), Math.max(left, right) - 20);
    revision <= Math.max(left, right);
    revision++
  ) {
    const data = await checked<{ version: unknown }>(
      await apiFetch('/api/works/command', {
        ...json({
          threadId,
          command: { action: 'read', reference: { contentRef: contentRef, ownerRevision: revision } },
        }),
        signal: signal,
      }),
    );
    const version = workVersionRecordSchema.parse(data.version);
    if (version.contentRef !== contentRef || version.ownerRevision !== revision) throw new Error('版本说明不一致。');
    rows.push({ revision, label: `第 ${revision} 版`, body: version.changeSummary });
  }
  return { verified, rows };
}

export function VideoWorkComparison({
  reference,
  latest,
  onClose,
  onLeftActiveChange,
  rightContext,
  onAlignRight,
}: {
  reference: WorkReference;
  rightContext: WorkContextRecord | null;
  onAlignRight: (story: WorkVideoContext['story'][number]) => void;
  latest: number;
  onClose: () => void;
  onLeftActiveChange: (active: boolean) => void;
}) {
  const [left, setLeft] = useState(Math.max(1, reference.ownerRevision - 1));
  const [mode, setMode] = useState('parallel');
  const [leftActive, setLeftActive] = useState(true);
  const [asset, setAsset] = useState<ReviewedMediaAsset | null>(null);
  const [notes, setNotes] = useState<Array<{ revision: number; label: string; body: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const threadId = useChatStore((state) => state.currentThreadId);
  const visible = useWorkspaceSurfaceVisibility();
  useEffect(() => {
    const abort = new AbortController();
    setAsset(null);
    setError(null);
    setNotes([]);
    if (!visible || !threadId) return () => abort.abort();
    void (async () => {
      try {
        const { verified, rows } = await loadComparison(
          reference.contentRef,
          left,
          reference.ownerRevision,
          threadId,
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setAsset(verified);
          setNotes(rows);
        }
      } catch {
        if (!abort.signal.aborted) setError('对比原件或版本说明暂时无法读取。');
      }
    })();
    return () => abort.abort();
  }, [reference.contentRef, reference.ownerRevision, left, threadId, visible]);
  return (
    <aside
      data-video-work-comparison
      className={`flex ${mode === 'sequential' && leftActive ? 'flex-1' : 'w-[42%]'} min-w-0 shrink-0 flex-col overflow-y-auto border-r border-cafe-subtle`}
      aria-label="对比版本"
    >
      <div className="flex flex-wrap items-center gap-2 p-2 text-xs">
        <select aria-label="左侧作品版本" value={left} onChange={(event) => setLeft(Number(event.target.value))}>
          {Array.from({ length: latest }, (_, index) => index + 1).map((revision) => (
            <option key={revision} value={revision}>
              第 {revision} 版
            </option>
          ))}
        </select>
        <select
          aria-label="对比方式"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value);
            setLeftActive(true);
            onLeftActiveChange(event.target.value === 'sequential');
          }}
        >
          <option value="parallel">并排</option>
          <option value="sequential">先后看</option>
        </select>
        <button type="button" onClick={onClose}>
          返回看片
        </button>
        {mode === 'sequential' ? (
          <button
            type="button"
            onClick={() => {
              setLeftActive(!leftActive);
              onLeftActiveChange(!leftActive);
            }}
          >
            {leftActive ? `看右版（第 ${reference.ownerRevision} 版）` : `看左版（第 ${left} 版）`}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="p-3 text-xs text-cafe-error">
          {error}
        </p>
      ) : asset ? (
        <>
          <VideoComparisonPlayback
            key={`${asset.contentRef}:${asset.ownerRevision}:${reference.ownerRevision}`}
            asset={asset}
            reference={reference}
            rightContext={rightContext}
            sequential={mode === 'sequential'}
            leftActive={leftActive}
            onShowRight={() => {
              setLeftActive(false);
              onLeftActiveChange(false);
            }}
            onAlignRight={onAlignRight}
          />
          <ol className="space-y-3 p-3 text-xs">
            {notes.map((row) => (
              <li key={row.revision}>
                <strong>{row.label}</strong>
                <p className="whitespace-pre-wrap leading-5">{row.body}</p>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="p-3 text-xs text-cafe-muted">正在读取对比原件…</p>
      )}
    </aside>
  );
}
