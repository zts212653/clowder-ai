'use client';

import { type ContextAttachment } from '@cat-cafe/shared';

/** Module-level draft storage — survives component unmount/remount across thread switches */
export {
  syncContextAttachmentDraftToStorage,
  syncDraftToStorage,
  syncReplyDraftToStorage,
  threadContextAttachmentDrafts,
  threadDrafts,
  threadImageDrafts,
  threadReplyDrafts,
} from './thread-drafts';

export interface ChatInputDraftSnapshot {
  text: string;
  files: File[];
  contextAttachments: ContextAttachment[];
}
