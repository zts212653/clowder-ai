'use client';
import type { AssetCanonItem, AssetCanonUpdate, WorkContextRecord, WorkVideoContext } from '@cat-cafe/shared';
import { useState } from 'react';
import { canonActor, canonStatusLabel } from './asset-canon-presentation';
import { VideoWorkMaterialPreview } from './VideoWorkMaterialPreview';
import { type MaterialUsageProps, VideoWorkMaterialUses } from './VideoWorkMaterialUses';

type Canon = {
  error?: string;
  selectedId?: string;
  items?: Record<string, AssetCanonItem>;
  updates?: AssetCanonUpdate[];
  onSelect?: (assetId: string) => void;
};

type Material = WorkVideoContext['assets'][number];
type AssetUrl = (id: string, revision: number) => string;
const sequence = (kind: string) => /^(动作帧|录像帧|帧序列) · /.test(kind);
function pauseCollapsed(group: HTMLDetailsElement) {
  if (!group.open) for (const media of group.querySelectorAll('audio, video')) (media as HTMLMediaElement).pause();
}
function Material({
  row,
  revision,
  assetUrl,
  items,
  updates,
  onSelect,
  selectedId,
  record,
  clock,
  onSeek,
}: { row: Material; revision: number; assetUrl?: AssetUrl } & Canon & MaterialUsageProps) {
  const version = row.asset.versions.find((item) => item.id === row.versionId);
  if (!version) throw new Error('Selected material version is not indexed');
  const href = assetUrl?.(row.asset.id, revision);
  return (
    <li
      className={`rounded-lg border p-2 text-xs ${selectedId === row.asset.id ? 'border-cafe-accent' : 'border-cafe-subtle'}`}
    >
      {onSelect ? (
        <button
          type="button"
          className="break-all text-left text-cafe-accent underline"
          title={row.asset.name}
          onClick={() => onSelect(row.asset.id)}
        >
          {row.asset.name.split('/').at(-1)}
        </button>
      ) : href ? (
        <a className="text-cafe-accent underline" href={href} target="_blank" rel="noreferrer">
          {row.asset.name}
        </a>
      ) : (
        <span>{row.asset.name}</span>
      )}
      {items ? (
        <p className="mt-1 text-xs text-cafe-muted">
          {items[row.asset.id] ? (
            <>
              {items[row.asset.id]!.record.status ? canonStatusLabel[items[row.asset.id]!.record.status!] : '还没标'}
              {items[row.asset.id]!.record.judgment
                ? ` · ${canonActor(items[row.asset.id]!.record.judgment!.actor)} · ${items[row.asset.id]!.record.judgment!.recordedAt.slice(5, 10)}`
                : ''}
              {updates?.some((u) => u.original.work?.assetId === row.asset.id && u.kind === 'replacement_available')
                ? ' · 有新正典'
                : ''}
            </>
          ) : (
            '正在读取标记…'
          )}
        </p>
      ) : null}
      <p className="mt-1 text-cafe-muted">{version.byteLength.toLocaleString()} 字节</p>
      <VideoWorkMaterialUses uses={row.uses} record={record} clock={clock} onSeek={onSeek} />
      {href ? (
        <VideoWorkMaterialPreview key={href} url={href} name={row.asset.name} mediaType={version.mediaType} />
      ) : null}
    </li>
  );
}
function FrameSequences({
  groups,
  assets,
  revision,
  assetUrl,
  items,
  updates,
  onSelect,
  selectedId,
  record,
  clock,
  onSeek,
}: {
  groups: string[];
  assets: Material[];
  revision: number;
  assetUrl?: AssetUrl;
} & Canon &
  MaterialUsageProps) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="mb-1 cursor-pointer text-xs font-semibold">帧序列 · {groups.length} 组</summary>
      <ul className="space-y-2">
        {groups.map((kind) => {
          const frames = assets.filter((row) => row.asset.kind === kind);
          const first = frames[0];
          const url = first && assetUrl?.(first.asset.id, revision);
          return (
            <li key={kind} className="rounded-lg border border-cafe-subtle p-2 text-xs">
              <p>
                {kind} · {frames.length} 张
              </p>
              {open && url ? (
                // biome-ignore lint/performance/noImgElement: permission-checked original first frame, not a public thumbnail.
                <img src={url} alt={`${kind} 首帧`} loading="lazy" className="my-2 max-h-28 w-full object-contain" />
              ) : null}
              <details onToggle={(event) => pauseCollapsed(event.currentTarget)}>
                <summary className="cursor-pointer text-cafe-accent">查看每帧原件</summary>
                <ul className="mt-2 space-y-2">
                  {frames.map((row) => (
                    <Material
                      key={row.asset.id}
                      row={row}
                      revision={revision}
                      assetUrl={assetUrl}
                      items={items}
                      updates={updates}
                      onSelect={onSelect}
                      selectedId={selectedId}
                      record={record}
                      clock={clock}
                      onSeek={onSeek}
                    />
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
export function VideoWorkMaterials({
  record,
  assetUrl,
  items,
  updates,
  onSelect,
  selectedId,
  error,
  clock,
  onSeek,
}: { record: WorkContextRecord | null; assetUrl?: AssetUrl } & Canon & Pick<MaterialUsageProps, 'clock' | 'onSeek'>) {
  if (!record?.context.assets.length)
    return <p className="text-xs leading-5 text-cafe-muted">尚未登记这版用到的素材。</p>;
  const assets = record.context.assets;
  const kinds = [...new Set(assets.map((row) => row.asset.kind))];
  const frames = kinds.filter(sequence);
  return (
    <div className="space-y-3">
      {error ? (
        <p role="alert" className="text-xs text-cafe-muted">
          {error}
        </p>
      ) : null}
      {updates?.some((u) => u.kind === 'replacement_available') ? (
        <button
          type="button"
          className="w-full rounded border border-cafe-subtle bg-cafe-surface-elevated p-2 text-left text-xs"
          onClick={() => {
            const id = updates.find((u) => u.kind === 'replacement_available')?.original.work?.assetId;
            if (id) onSelect?.(id);
          }}
        >
          {
            new Set(
              updates.filter((u) => u.kind === 'replacement_available').map((u) => u.original.record.indexedVersionRef),
            ).size
          }{' '}
          件有新正典 · 看 ›
        </button>
      ) : null}
      {frames.length ? (
        <FrameSequences
          groups={frames}
          assets={assets}
          revision={record.metadataRevision}
          assetUrl={assetUrl}
          items={items}
          updates={updates}
          onSelect={onSelect}
          selectedId={selectedId}
          record={record}
          clock={clock}
          onSeek={onSeek}
        />
      ) : null}
      {kinds
        .filter((kind) => !sequence(kind))
        .map((kind) => (
          <details key={kind} onToggle={(event) => pauseCollapsed(event.currentTarget)}>
            <summary className="mb-1 cursor-pointer text-xs font-semibold">
              {kind} · {assets.filter((row) => row.asset.kind === kind).length}
              {items
                ? ` · 正典 ${assets.filter((row) => row.asset.kind === kind && items[row.asset.id]?.record.status === 'canonical').length}`
                : ''}
            </summary>
            <ul className="space-y-2">
              {assets
                .filter((row) => row.asset.kind === kind)
                .map((row) => (
                  <Material
                    key={row.asset.id}
                    row={row}
                    revision={record.metadataRevision}
                    assetUrl={assetUrl}
                    items={items}
                    updates={updates}
                    onSelect={onSelect}
                    selectedId={selectedId}
                    record={record}
                    clock={clock}
                    onSeek={onSeek}
                  />
                ))}
            </ul>
          </details>
        ))}
    </div>
  );
}
