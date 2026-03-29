'use client';

import { useEffect, useMemo, useState } from 'react';
import { Lightbox } from './Lightbox';

interface ImagePreviewProps {
  files: File[];
  onRemove: (index: number) => void;
}

export function ImagePreview({ files, onRemove }: ImagePreviewProps) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // Create object URLs once per file set, revoke on cleanup
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);

  useEffect(() => {
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [urls]);

  if (files.length === 0) return null;

  return (
    <>
      <div className="flex gap-2 px-4 py-2 overflow-x-auto">
        {files.map((file, i) => (
          <div key={`${file.name}-${i}`} className="relative flex-shrink-0 group">
            <img
              src={urls[i]}
              alt={file.name}
              className="w-16 h-16 object-cover rounded-lg border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxIdx(i)}
            />
            <button
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title={`移除 ${file.name}`}
              aria-label={`Remove ${file.name}`}
            >
              x
            </button>
            <span className="block text-[9px] text-cafe-muted truncate w-16 mt-0.5 text-center">{file.name}</span>
          </div>
        ))}
      </div>
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
