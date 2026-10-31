'use client';
import Image from 'next/image';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { projectPath } from './api';
import type { ModificationArtworkPair } from './modification-inputs';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import styles from './VideoProjectReviewSurface.module.css';

type ImageState = { state: 'loading' } | { state: 'ready'; src: string } | { state: 'error'; error: string };
const assetErrors: Record<string, string> = {
  asset_changed: '原文件字节已变化，不能冒充这个画稿版本。',
  asset_missing: '这个画稿版本的原文件已缺失。',
  asset_not_found: '所选输入没有登记这份画稿。',
  access_denied: '当前没有访问这份画稿的权限。',
  invalid_asset_image: '这个版本的字节不是可读取的 PNG 画稿。',
};
async function readArtwork(contentRef: string, side: ModificationArtworkPair['before'], signal: AbortSignal) {
  const response = await apiFetch(
    `${projectPath(contentRef)}/assets/${encodeURIComponent(side.version.id)}?ownerRevision=${side.ownerRevision}`,
    { signal },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === 'object' && 'error' in body ? String(body.error) : String(response.status);
    throw new Error(assetErrors[code] ?? `画稿暂时不可读取（${code}），请重试。`);
  }
  if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw new Error('画稿响应格式不匹配。');
  const blob = await response.blob();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return URL.createObjectURL(blob);
}

export function ModificationArtwork({ contentRef, pair }: { contentRef: string; pair: ModificationArtworkPair }) {
  const t = useScreeningCopy();
  const [zoom, setZoom] = useState(1);
  const [images, setImages] = useState<{ before: ImageState; after: ImageState }>({
    before: { state: 'loading' },
    after: { state: 'loading' },
  });
  const beforeScroll = useRef<HTMLElement>(null),
    afterScroll = useRef<HTMLElement>(null);
  useEffect(() => {
    const controller = new AbortController(),
      urls: string[] = [];
    setImages({ before: { state: 'loading' }, after: { state: 'loading' } });
    for (const side of ['before', 'after'] as const) {
      void readArtwork(contentRef, pair[side], controller.signal).then(
        (src) => {
          if (controller.signal.aborted) {
            URL.revokeObjectURL(src);
            return;
          }
          urls.push(src);
          setImages((value) => ({ ...value, [side]: { state: 'ready', src } }));
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setImages((value) => ({
              ...value,
              [side]: { state: 'error', error: error instanceof Error ? error.message : '画稿暂时不可读取。' },
            }));
        },
      );
    }
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [contentRef, pair]);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-3 text-xs text-cafe-secondary">
        {t.zoom}
        <input
          aria-label={t.zoom}
          type="range"
          min="1"
          max="4"
          step="0.25"
          value={zoom}
          className={styles.slider}
          style={{ '--progress': `${((zoom - 1) / 3) * 100}%` } as import('react').CSSProperties}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <output>{zoom}×</output>
      </label>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(['before', 'after'] as const).map((side) => (
          <ArtworkSide
            key={side}
            label={side === 'before' ? t.original : t.changed}
            content={images[side]}
            version={pair[side]}
            imageLabel={pair.label}
            zoom={zoom}
            scrollRef={side === 'before' ? beforeScroll : afterScroll}
            onScroll={(source) =>
              synchronizeScroll(source, side === 'before' ? afterScroll.current : beforeScroll.current)
            }
            onError={() =>
              setImages((value) => ({ ...value, [side]: { state: 'error', error: '这版画稿解码失败，请重试。' } }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function synchronizeScroll(source: HTMLElement, target: HTMLElement | null) {
  if (!target) return;
  const left =
    source.scrollWidth > source.clientWidth ? source.scrollLeft / (source.scrollWidth - source.clientWidth) : 0;
  const top =
    source.scrollHeight > source.clientHeight ? source.scrollTop / (source.scrollHeight - source.clientHeight) : 0;
  const targetLeft = left * Math.max(0, target.scrollWidth - target.clientWidth),
    targetTop = top * Math.max(0, target.scrollHeight - target.clientHeight);
  if (target.scrollLeft !== targetLeft) target.scrollLeft = targetLeft;
  if (target.scrollTop !== targetTop) target.scrollTop = targetTop;
}

function ArtworkSide({
  label,
  content,
  version,
  imageLabel,
  zoom,
  scrollRef,
  onScroll,
  onError,
}: {
  label: string;
  content: ImageState;
  version: ModificationArtworkPair['before'];
  imageLabel: string;
  zoom: number;
  scrollRef: RefObject<HTMLElement>;
  onScroll: (source: HTMLElement) => void;
  onError: () => void;
}) {
  const t = useScreeningCopy();
  return (
    <div>
      <p className="mb-2 break-words text-xs text-cafe-muted">
        {label === t.original ? t.originalInput(version.ownerRevision) : t.modifiedInput(version.ownerRevision)} ·{' '}
        {version.version.locator.kind === 'workspace'
          ? version.version.locator.path.split('/').at(-1)
          : t.registeredArtwork}
      </p>
      <section
        aria-label={`${label}${t.artworkLabel}`}
        ref={scrollRef}
        onScroll={(event) => onScroll(event.currentTarget)}
        className="h-80 overflow-auto rounded-lg border border-cafe-subtle bg-cafe-canvas"
      >
        <ArtworkPixels
          content={content}
          version={version}
          label={`${label}${t.artworkLabel} · ${imageLabel}`}
          zoom={zoom}
          onError={onError}
        />
      </section>
    </div>
  );
}

function ArtworkPixels({
  content,
  version,
  label,
  zoom,
  onError,
}: {
  content: ImageState;
  version: ModificationArtworkPair['before'];
  label: string;
  zoom: number;
  onError: () => void;
}) {
  if (content.state === 'loading') return <output className="p-4 text-xs text-cafe-muted">正在读取这版画稿…</output>;
  if (content.state === 'error')
    return (
      <p role="alert" className="p-4 text-xs text-cafe-secondary">
        {content.error}
      </p>
    );
  return (
    <OrientedArtworkImage
      key={content.src}
      src={content.src}
      version={version.version}
      label={label}
      zoom={zoom}
      onError={onError}
    />
  );
}

function OrientedArtworkImage({
  src,
  version,
  label,
  zoom,
  onError,
}: {
  src: string;
  version: ModificationArtworkPair['before']['version'];
  label: string;
  zoom: number;
  onError: () => void;
}) {
  const [dimensions, setDimensions] = useState({ width: version.width ?? 1, height: version.height ?? 1 });
  const rotation = version.rotation ?? 0;
  const sideways = rotation === 90 || rotation === 270;
  const displayWidth = sideways ? dimensions.height : dimensions.width;
  const displayHeight = sideways ? dimensions.width : dimensions.height;
  return (
    <div className="relative" style={{ width: `${zoom * 100}%`, aspectRatio: `${displayWidth} / ${displayHeight}` }}>
      <Image
        unoptimized
        width={dimensions.width}
        height={dimensions.height}
        src={src}
        alt={label}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: `${(dimensions.width / displayWidth) * 100}%`,
          maxWidth: 'none',
          height: 'auto',
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        }}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0)
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
        }}
        onError={onError}
      />
    </div>
  );
}
