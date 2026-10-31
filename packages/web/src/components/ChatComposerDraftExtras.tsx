'use client';

import type { ContextAttachment } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { AttachmentPreview } from './AttachmentPreview';
import { ContextAttachmentList } from './ContextAttachmentView';
import { ReplyPreviewBar } from './ReplyPreviewBar';
import { WhisperTargetChips } from './WhisperCatSelector';

interface ChatComposerDraftExtrasProps {
  threadId?: string;
  files: File[];
  contextAttachments: readonly ContextAttachment[];
  replyToMessage: { id: string; content: string; senderCatId: string | null } | null;
  cats: CatData[];
  whisperMode: boolean;
  whisperCats: CatData[];
  whisperTargets: Set<string>;
  onToggleWhisperTarget: (catId: string) => void;
  onRemoveFile: (index: number) => void;
  onRemoveContext: (id: string) => void;
  onClearReply: () => void;
}

/** One draft owner rendered either inside the v2 paper border or in the frozen classic sibling position. */
export function ChatComposerDraftExtras({
  threadId,
  files,
  contextAttachments,
  replyToMessage,
  cats,
  whisperMode,
  whisperCats,
  whisperTargets,
  onToggleWhisperTarget,
  onRemoveFile,
  onRemoveContext,
  onClearReply,
}: ChatComposerDraftExtrasProps) {
  return (
    <>
      {whisperMode ? (
        <WhisperTargetChips cats={whisperCats} selected={whisperTargets} onToggle={onToggleWhisperTarget} />
      ) : null}
      <AttachmentPreview files={files} onRemove={onRemoveFile} />
      <ContextAttachmentList attachments={contextAttachments} compact onRemove={onRemoveContext} threadId={threadId} />
      {replyToMessage ? <ReplyPreviewBar replyToMessage={replyToMessage} cats={cats} onClear={onClearReply} /> : null}
    </>
  );
}
