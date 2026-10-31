import { z } from 'zod';
import { evolutionMediaSnapshotSourceSchema } from './evolution-media-source.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes('\0'));

export { type MessageMediaItemSelector, messageMediaItemSelectorSchema } from './message-media-item-selector.js';

import { type MessageMediaItemSelector, messageMediaItemSelectorSchema } from './message-media-item-selector.js';

/** A selector is a claim to resolve against a persisted message, never authority supplied by the client. */
export const messageMediaPublicationSourceSchema = z
  .object({
    kind: z.literal('message'),
    threadId: id,
    messageId: id,
    messageRevision: z.string().max(64).regex(/^\d+$/),
    item: messageMediaItemSelectorSchema,
    expectedUrl: z.string().min(1).max(2048),
  })
  .strict();
export type MessageMediaPublicationSource = z.infer<typeof messageMediaPublicationSourceSchema>;

export const workspaceMediaSnapshotSourceSchema = z
  .object({
    kind: z.literal('workspace-snapshot'),
    threadId: id,
    locator: z.object({ worktreeId: id, path: z.string().min(1).max(2048) }).strict(),
    expectedSourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type WorkspaceMediaSnapshotSource = z.infer<typeof workspaceMediaSnapshotSourceSchema>;

export const mediaPublicationSourceSchema = z.discriminatedUnion('kind', [
  messageMediaPublicationSourceSchema,
  workspaceMediaSnapshotSourceSchema,
  evolutionMediaSnapshotSourceSchema,
]);
export type MediaPublicationSource = z.infer<typeof mediaPublicationSourceSchema>;

export function messageMediaItemKey(item: MessageMediaItemSelector): string {
  switch (item.kind) {
    case 'content-block':
      return `content:${item.index}`;
    case 'media-gallery':
      return `gallery:${encodeURIComponent(item.blockId)}:${item.itemIndex}`;
    case 'rich-file':
      return `file:${encodeURIComponent(item.blockId)}`;
  }
}
