'use client';
import type { AssetCanonItem, AssetCanonUpdate } from '@cat-cafe/shared';
import { useState } from 'react';
import { canonAssetUrl } from './asset-canon-client';
import { canonActor } from './asset-canon-presentation';
import { VideoWorkMaterialPreview } from './VideoWorkMaterialPreview';
import { type MaterialUsageProps, VideoWorkMaterialUses } from './VideoWorkMaterialUses';

export function AssetCanonUpdateView({
  item,
  update,
  record,
  clock,
  onSeek,
  threadId,
  busy,
  act,
  mutate,
  onNextVersion,
}: {
  item: AssetCanonItem;
  update: AssetCanonUpdate;
  threadId: string;
  busy: boolean;
  act: (operation: () => Promise<unknown>) => Promise<boolean>;
  mutate: (intent: Record<string, unknown>) => Promise<unknown>;
  onNextVersion: (body: string) => Promise<void>;
} & MaterialUsageProps) {
  const [keeping, setKeeping] = useState(false);
  const [keepReason, setKeepReason] = useState('');
  const preview = (asset: AssetCanonItem) => (
    <div className="aspect-[4/3] min-w-0 overflow-hidden rounded border border-cafe-subtle bg-cafe-surface-elevated">
      <VideoWorkMaterialPreview
        key={canonAssetUrl(asset, threadId)}
        initiallyOpen
        comparison
        url={canonAssetUrl(asset, threadId)}
        name={asset.record.name}
        mediaType={asset.record.version.mediaType}
      />
    </div>
  );
  const caption = (asset: AssetCanonItem, label: string, className: string) => (
    <div className={`min-w-0 ${className}`}>
      <p className="text-xs text-cafe-muted">{label}</p>
      <p className="truncate text-xs" title={asset.record.name}>
        {asset.record.name.split('/').at(-1)}
      </p>
    </div>
  );
  return (
    <>
      <h3 className="font-semibold">{update.kind === 'replacement_available' ? '有新正典' : '素材有更新'}</h3>
      <div className={update.replacement ? 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2' : 'grid gap-2'}>
        {preview(item)}
        {update.replacement ? (
          <>
            <span className="self-center text-cafe-muted" aria-hidden="true">
              →
            </span>
            {preview(update.replacement)}
          </>
        ) : null}
        {caption(item, '这支片用的', 'col-start-1')}
        {update.replacement ? caption(update.replacement, '现在的正典', 'col-start-3') : null}
      </div>
      <p className="whitespace-pre-wrap">{update.reason}</p>
      {update.change ? (
        <p className="text-xs text-cafe-muted">
          谁定的 · {canonActor(update.change.actor)} · {update.change.recordedAt.slice(5, 10)}
        </p>
      ) : null}
      <VideoWorkMaterialUses uses={update.uses} record={record} clock={clock} onSeek={onSeek} />
      {['replacement_available', 'no_longer_canonical'].includes(update.kind) ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-cafe-accent px-3 py-2 text-white"
            disabled={busy}
            onClick={() => void act(() => onNextVersion(`下一版换上新的正典：${item.record.name}。${update.reason}`))}
          >
            下一版换上
          </button>
          <button
            type="button"
            className="rounded border border-cafe-subtle px-3 py-2"
            disabled={busy}
            onClick={() => setKeeping(true)}
          >
            这版不换
          </button>
        </div>
      ) : null}
      {keeping ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() =>
              mutate({
                action: 'decide-asset-update',
                reference: record.reference,
                indexedVersionRef: item.record.indexedVersionRef,
                noticeScope: update.noticeScope,
                updateFingerprint: update.updateFingerprint,
                expectedDecisionRevision: update.decisionRevision,
                decision: 'keep_this_version',
                reason: keepReason,
              }),
            );
          }}
        >
          <label className="block">
            为什么
            <input
              required
              value={keepReason}
              onChange={(e) => setKeepReason(e.target.value)}
              className="mt-1 w-full rounded border border-cafe-subtle bg-cafe-surface p-2 focus:border-[var(--evolution-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--evolution-focus)]"
            />
          </label>
          <button className="rounded bg-cafe-accent px-3 py-1 text-white" disabled={busy || !keepReason.trim()}>
            记下
          </button>
        </form>
      ) : null}
      <p className="text-xs text-cafe-muted">这一版不会变。选「这版不换」，提示就收起，记下谁定的。</p>
    </>
  );
}
