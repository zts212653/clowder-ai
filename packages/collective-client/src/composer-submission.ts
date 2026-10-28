import type { CollectiveHumanMessageRequest } from '@cat-cafe/shared';
import type { CollectiveRecipient } from './client-types.js';
import type { ComposerDraft } from './composer-draft.js';

export type ComposerMessageContent = Pick<
  CollectiveHumanMessageRequest,
  'attachments' | 'contextAttachments' | 'richBlocks' | 'draftReceipt'
>;
export type ComposerSend = (
  body: string,
  recipient: CollectiveRecipient,
  entrust: boolean,
  responseRequested: boolean,
  replyToEventId?: string,
  content?: ComposerMessageContent,
) => Promise<void>;

export function hasComposerContextContent(draft: ComposerDraft): boolean {
  return Boolean(draft.attachments?.length || draft.contextAttachments?.length || draft.richBlocks?.length);
}

/** Preserve the existing plain-text call shape while carrying each structured field through one send boundary. */
export async function sendComposerMessage(
  send: ComposerSend,
  draft: ComposerDraft,
  draftReceipt?: ComposerMessageContent['draftReceipt'],
) {
  const content: ComposerMessageContent = {
    ...(draft.attachments?.length ? { attachments: [...draft.attachments] } : {}),
    ...(draft.contextAttachments?.length ? { contextAttachments: [...draft.contextAttachments] } : {}),
    ...(draft.richBlocks?.length ? { richBlocks: [...draft.richBlocks] } : {}),
    ...(draftReceipt ? { draftReceipt } : {}),
  };
  const args = [draft.body.trim(), draft.recipient, Boolean(draft.entrust), Boolean(draft.responseRequested)] as const;
  if (Object.keys(content).length) await send(...args, draft.replyToEventId, content);
  else if (draft.replyToEventId) await send(...args, draft.replyToEventId);
  else await send(...args);
}
