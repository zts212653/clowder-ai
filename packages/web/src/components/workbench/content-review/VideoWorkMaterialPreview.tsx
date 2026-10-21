'use client';
import { useEffect, useRef, useState } from 'react';
import { useShellLanguage } from '@/components/shell/shell-language';

const words = {
  zh: { preview: '预览', open: '在此预览', hide: '收起预览', retry: '重试预览', error: '这份素材暂时无法预览。' },
  en: {
    preview: 'Preview',
    open: 'Preview here',
    hide: 'Hide preview',
    retry: 'Retry preview',
    error: 'This material cannot be previewed right now.',
  },
};
type PreviewKind = 'image' | 'audio' | 'video';
const formats: Readonly<Record<string, PreviewKind | undefined>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'audio/wav': 'audio',
  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'video/mp4': 'video',
  'video/webm': 'video',
};

function NativeMaterial({
  kind,
  url,
  name,
  onError,
  onMedia,
}: {
  kind: PreviewKind;
  url: string;
  name: string;
  onError: () => void;
  onMedia: (element: HTMLMediaElement | null) => void;
}) {
  if (kind === 'image')
    // biome-ignore lint/performance/noImgElement: original permission-checked source has no public image URL.
    return <img src={url} alt={name} onError={onError} className="mt-2 max-h-64 w-full object-contain" />;
  const playback = { ref: onMedia, src: url, 'aria-label': name, controls: true, preload: 'none' as const, onError };
  if (kind === 'audio') return <audio {...playback} className="mt-2 w-full" />;
  return <video {...playback} className="mt-2 max-h-64 w-full" />;
}

export function VideoWorkMaterialPreview({ url, name, mediaType }: { url: string; name: string; mediaType: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  const t = words[useShellLanguage()];
  useEffect(() => {
    if (!open || failed) return;
    const element = media.current;
    return () => element?.pause();
  }, [open, failed]);
  const kind = formats[mediaType];
  if (!kind) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-label={`${t.preview} ${name}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setFailed(false);
        }}
        className="text-cafe-accent"
      >
        {open ? t.hide : t.open}
      </button>
      {open &&
        (failed ? (
          <p role="alert" className="mt-2 text-cafe-error">
            {t.error}{' '}
            <button type="button" onClick={() => setFailed(false)} className="underline">
              {t.retry}
            </button>
          </p>
        ) : (
          <NativeMaterial
            kind={kind}
            url={url}
            name={name}
            onError={() => setFailed(true)}
            onMedia={(node) => {
              media.current = node;
            }}
          />
        ))}
    </div>
  );
}
