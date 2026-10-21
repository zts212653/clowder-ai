'use client';
import type { WorkContextRecord, WorkVideoContext } from '@cat-cafe/shared';
import { useState } from 'react';
import { VideoWorkMaterialPreview } from './VideoWorkMaterialPreview';

type Material = WorkVideoContext['assets'][number];
type AssetUrl = (id: string, revision: number) => string;
const sequence = (kind: string) => /^(动作帧|录像帧|帧序列) · /.test(kind);
function pauseCollapsed(group: HTMLDetailsElement) {
  if (!group.open) for (const media of group.querySelectorAll('audio, video')) (media as HTMLMediaElement).pause();
}
function Material({ row, revision, assetUrl }: { row: Material; revision: number; assetUrl?: AssetUrl }) {
  const version = row.asset.versions.find((item) => item.id === row.versionId);
  if (!version) throw new Error('Selected material version is not indexed');
  const href = assetUrl?.(row.asset.id, revision);
  return (
    <li className="rounded-lg border border-cafe-subtle p-2 text-xs">
      {href ? (
        <a className="text-cafe-accent underline" href={href} target="_blank" rel="noreferrer">
          {row.asset.name}
        </a>
      ) : (
        <span>{row.asset.name}</span>
      )}
      <p className="mt-1 text-cafe-muted">{version.byteLength.toLocaleString()} 字节</p>
      <p className="whitespace-pre-wrap">{row.uses.join('；')}</p>
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
}: {
  groups: string[];
  assets: Material[];
  revision: number;
  assetUrl?: AssetUrl;
}) {
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
                    <Material key={row.asset.id} row={row} revision={revision} assetUrl={assetUrl} />
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
export function VideoWorkMaterials({ record, assetUrl }: { record: WorkContextRecord | null; assetUrl?: AssetUrl }) {
  if (!record?.context.assets.length)
    return <p className="text-xs leading-5 text-cafe-muted">尚未登记这版用到的素材。</p>;
  const assets = record.context.assets;
  const kinds = [...new Set(assets.map((row) => row.asset.kind))];
  const frames = kinds.filter(sequence);
  return (
    <div className="space-y-3">
      {frames.length ? (
        <FrameSequences groups={frames} assets={assets} revision={record.metadataRevision} assetUrl={assetUrl} />
      ) : null}
      {kinds
        .filter((kind) => !sequence(kind))
        .map((kind) => (
          <details key={kind} onToggle={(event) => pauseCollapsed(event.currentTarget)}>
            <summary className="mb-1 cursor-pointer text-xs font-semibold">
              {kind} · {assets.filter((row) => row.asset.kind === kind).length}
            </summary>
            <ul className="space-y-2">
              {assets
                .filter((row) => row.asset.kind === kind)
                .map((row) => (
                  <Material key={row.asset.id} row={row} revision={record.metadataRevision} assetUrl={assetUrl} />
                ))}
            </ul>
          </details>
        ))}
    </div>
  );
}
