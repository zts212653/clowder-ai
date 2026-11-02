'use client';
import { useContentOpen } from '@/components/content-review/useContentOpen';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import type { RichFileBlock } from '@/stores/chat-types';
import type { useRegisteredFileWork } from './useRegisteredFileWork';

export const isSafeFileUrl = (url: string) => /^(\/uploads\/|\/api\/|https?:\/\/)/.test(url);
/** Card decoration/registration stays here; viewer, type and target decisions do not. */
export function useFileCardOpen({
  block,
  publication,
  host,
  originThread,
  messageId,
  sourceMessageIds,
  registered,
}: {
  block: RichFileBlock;
  publication?: PublishedMessageCoordinate;
  host: string | null;
  originThread?: string;
  messageId?: string;
  sourceMessageIds?: readonly string[];
  registered: ReturnType<typeof useRegisteredFileWork>;
  video: boolean;
}) {
  const opening = useContentOpen(publication, JSON.stringify([host, block.url, messageId, sourceMessageIds]));
  return {
    ...opening,
    open: (mode: 'lightbox' | 'work-mode', latest = false) => {
      if (!host || !isSafeFileUrl(block.url)) return Promise.resolve(false);
      return opening.openContent(
        {
          kind: 'message-file',
          url: block.url,
          name: block.fileName,
          mime: block.mimeType,
          coordinate: publication ?? {
            threadId: originThread ?? host,
            messageId: messageId ?? '',
            messageRevision: '',
          },
          item: { kind: 'rich-file', blockId: block.id },
          sourceMessageIds,
          current: latest,
          reference: registered.reference,
          resolveRegistered: registered.resolve,
          origin: messageId ? { kind: 'chat-file-link', threadId: originThread ?? host, messageId } : undefined,
        },
        mode,
      );
    },
  };
}
