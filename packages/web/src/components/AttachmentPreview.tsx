'use client';

import { ComposerAttachmentPreview, MessageMediaViewer } from '@cat-cafe/ui';
import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from './Lightbox';

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
        <MessageMediaViewer
          item={{ id: item.id, url: item.url, title: item.name, mediaType: item.mediaType }}
          onClose={() => setSelected(undefined)}
        >
          {item.mediaType.startsWith('image/') ? (
            <>
              <img src={item.url} alt={item.name} />
              <CopyButton url={item.url} placement="below" />
            </>
          ) : undefined}
        </MessageMediaViewer>
      )}
    </>
  );
}
