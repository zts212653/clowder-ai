import {
  type CollectiveComposerDraft,
  type CollectiveMessageAttachment,
  collectiveHumanChannelStateSchema,
  collectiveMessageAttachmentSchema,
  collectiveReadPositionSchema,
  collectiveSaveDraftResultSchema,
  type MessageSticker,
} from '@cat-cafe/shared';
import { createContext, type ReactNode, useContext } from 'react';
import type { z } from 'zod';

export interface MessageExpressionPort {
  upload(
    file: File,
    clientUploadId: string,
    channelId: string,
    signal: AbortSignal,
    sticker?: MessageSticker,
  ): Promise<CollectiveMessageAttachment>;
  catalogImage?(stickerId: string, channelId: string, signal: AbortSignal): Promise<Blob>;
  read(attachmentId: string, sourceEventId: string | undefined, signal: AbortSignal): Promise<Blob>;
  channelState(channelId: string, rootEventId?: string): Promise<z.infer<typeof collectiveHumanChannelStateSchema>>;
  saveDraft(
    channelId: string,
    rootEventId: string | undefined,
    content: CollectiveComposerDraft,
    expectedRevision: number,
    clientOperationId: string,
    keepalive?: boolean,
  ): Promise<z.infer<typeof collectiveSaveDraftResultSchema>>;
  markRead(channelId: string, eventId: string): Promise<z.infer<typeof collectiveReadPositionSchema>>;
}
const MessageExpressionContext = createContext<MessageExpressionPort | undefined>(undefined);
export function MessageExpressionProvider({
  value,
  children,
}: {
  value: MessageExpressionPort | undefined;
  children: ReactNode;
}) {
  return <MessageExpressionContext.Provider value={value}>{children}</MessageExpressionContext.Provider>;
}
export const useMessageExpression = () => useContext(MessageExpressionContext);

export function createMessageExpressionPort(
  identity: { serviceInstanceId: string; collectiveId: string; humanId: string },
  transport: (path: string, init?: RequestInit) => Promise<Response>,
): MessageExpressionPort {
  const { humanId, ...coordinates } = identity;
  const request = (path: string, init?: RequestInit) =>
    transport(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        'x-collective-human-id': humanId,
        'x-collective-message-content': '2',
      },
    });
  return {
    async channelState(channelId, rootEventId) {
      const query = new URLSearchParams({ ...coordinates, channelId, ...(rootEventId ? { rootEventId } : {}) });
      return collectiveHumanChannelStateSchema.parse(await (await request(`/api/channel-state?${query}`)).json());
    },
    async saveDraft(channelId, rootEventId, content, expectedRevision, clientOperationId, keepalive) {
      const response = await request('/api/channel-state/draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...coordinates,
          channelId,
          ...(rootEventId ? { rootEventId } : {}),
          content,
          expectedRevision,
          clientOperationId,
        }),
        keepalive,
      });
      return collectiveSaveDraftResultSchema.parse(await response.json());
    },
    async markRead(channelId, eventId) {
      const response = await request('/api/channel-state/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...coordinates, channelId, eventId }),
      });
      const value = (await response.json()) as { read: unknown };
      return collectiveReadPositionSchema.parse(value.read);
    },
    async catalogImage(stickerId, channelId, signal) {
      const query = new URLSearchParams({ ...coordinates, channelId, stickerId });
      const response = await request(`/api/message-attachments/catalog?${query}`, { method: 'POST', signal });
      const blob = await response.blob();
      signal.throwIfAborted();
      return blob;
    },
    async upload(file, clientUploadId, channelId, signal, sticker) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      signal.throwIfAborted();
      const blobDigest = `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      const query = new URLSearchParams({
        ...coordinates,
        channelId,
        clientUploadId,
        fileName: file.name,
        mediaType: file.type || 'application/octet-stream',
        blobDigest,
        ...(sticker ? { stickerId: sticker.stickerId } : {}),
      });
      const result = await request(`/api/message-attachments/upload?${query}`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/octet-stream' },
        signal,
      });
      return collectiveMessageAttachmentSchema.parse(await result.json());
    },
    async read(attachmentId, sourceEventId, signal) {
      const query = new URLSearchParams({
        ...coordinates,
        attachmentId,
        ...(sourceEventId ? { sourceEventId } : {}),
      });
      const response = await request(`/api/message-attachments/read?${query}`, { method: 'POST', signal });
      const blob = await response.blob();
      signal.throwIfAborted();
      return blob;
    },
  };
}
