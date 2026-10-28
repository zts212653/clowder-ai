'use client';

import { ComposerAttachmentPreview } from '@cat-cafe/ui';
import { useEffect, useMemo, useState } from 'react';
import { Lightbox } from './Lightbox';

/** Private Host upload behavior stays here; attachment presentation is shared with Channel. */
export function AttachmentPreview({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  const [selected, setSelected] = useState<string>();
  const items = useMemo(
    () =>
      files.map((file, index) => ({
        id: String(index),
        name: file.name,
        mediaType: file.type,
        byteLength: file.size,
        url: URL.createObjectURL(file),
      })),
    [files],
  );
  useEffect(
    () => () => {
      for (const item of items) URL.revokeObjectURL(item.url);
    },
    [items],
  );
  const item = items.find((value) => value.id === selected);
  return (
    <>
      <ComposerAttachmentPreview
        items={items}
        onRemove={(id) => onRemove(Number(id))}
        onOpen={setSelected}
        labels={{ remove: (name) => `Remove ${name}`, retry: '重试', uploading: '正在上传…' }}
      />
      {item && (
        <Lightbox
          url={item.url}
          alt={item.name}
          mediaType={item.mediaType.startsWith('video/') ? 'video' : 'image'}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
