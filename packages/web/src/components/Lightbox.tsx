'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

async function copyImageToClipboard(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`not an image: ${blob.type}`);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await copyImageToClipboard(url);
      } catch {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          return;
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [url],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-md px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
      title={copied ? 'Copied!' : 'Copy image'}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function Lightbox({
  url,
  alt,
  caption,
  onClose,
}: {
  url: string;
  alt: string;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled via useEffect
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only, not interactive */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: container prevents backdrop close */}
      <div
        className="relative group max-w-[90vw] max-h-[90vh] flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-3 -right-3 bg-black/70 hover:bg-black/90 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg z-10"
          title="Close"
        >
          &times;
        </button>
        {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} className="max-w-full max-h-[85vh] object-contain rounded-lg" />
        {caption && <p className="mt-2 text-sm text-white/80">{caption}</p>}
        <CopyButton url={url} />
      </div>
    </div>,
    document.body,
  );
}
