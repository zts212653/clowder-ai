'use client';

import { useEffect, useMemo, useState } from 'react';
import { Lightbox } from './Lightbox';

interface AttachmentPreviewProps {
  files: File[];
  onRemove: (index: number) => void;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileIcon(mimeType: string): string {
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType === 'application/zip' || mimeType === 'application/gzip' || mimeType === 'application/x-tar') return '🗜️';
  if (mimeType.startsWith('text/')) return '📝';
  if (mimeType === 'application/json') return '📋';
  return '📎';
}

export function AttachmentPreview({ files, onRemove }: AttachmentPreviewProps) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  useEffect(() => {
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [urls]);

  if (files.length === 0) return null;

  const imageIndices: number[] = [];
  const fileIndices: number[] = [];
  files.forEach((f, i) => {
    if (isImageFile(f)) imageIndices.push(i);
    else fileIndices.push(i);
  });

  return (
    <>
      {imageIndices.length > 0 && (
        <div className="flex gap-2 px-4 py-2 overflow-x-auto">
          {imageIndices.map((originalIdx) => {
            const file = files[originalIdx];
            const urlIdx = originalIdx;
            return (
              <div key={`${file.name}-${originalIdx}`} className="relative flex-shrink-0 group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={urls[urlIdx]}
                  alt={file.name}
                  className="w-16 h-16 object-cover rounded-lg border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setLightboxIdx(urlIdx)}
                />
                <button
                  onClick={() => onRemove(originalIdx)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-conn-red-text text-[var(--cafe-surface)] text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title={`移除 ${file.name}`}
                  aria-label={`Remove ${file.name}`}
                >
                  x
                </button>
                <span className="block text-micro text-cafe-muted truncate w-16 mt-0.5 text-center">{file.name}</span>
              </div>
            );
          })}
        </div>
      )}

      {fileIndices.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 py-2">
          {fileIndices.map((originalIdx) => {
            const file = files[originalIdx];
            return (
              <div
                key={`${file.name}-${originalIdx}`}
                className="relative flex items-center gap-2 bg-cafe-surface border border-cafe rounded-lg pl-2 pr-8 py-1.5 group"
              >
                <span className="text-lg flex-shrink-0">{fileIcon(file.type)}</span>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs text-cafe-secondary truncate max-w-[120px]">{file.name}</span>
                  <span className="text-micro text-cafe-muted">{formatFileSize(file.size)}</span>
                </div>
                <button
                  onClick={() => onRemove(originalIdx)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-conn-red-text text-[var(--cafe-surface)] text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title={`移除 ${file.name}`}
                  aria-label={`Remove ${file.name}`}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}

      {lightboxIdx !== null && urls[lightboxIdx] && (
        <Lightbox
          url={urls[lightboxIdx]}
          alt={files[lightboxIdx]?.name ?? 'preview'}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </>
  );
}
