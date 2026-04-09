'use client';

import { useState } from 'react';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { Lightbox } from './Lightbox';
import { MarkdownContent } from './MarkdownContent';

export function ContentBlocks({ blocks }: { blocks: MessageContent[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
          return (
            // biome-ignore lint/performance/noImgElement: uploaded images cannot use next/image
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt="attached image"
              className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(src)}
            />
          );
        }
        return null;
      })}
      {lightboxSrc && <Lightbox url={lightboxSrc} alt="attached image" onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
