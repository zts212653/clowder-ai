import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { useState } from 'react';
import { buildCatOptions } from '@/components/chat-input-options';
import { getThreadDraft } from '@/components/thread-drafts';
import { useWorkspaceChatReveal } from '@/components/workbench/WorkspaceChatReveal';
import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { artifactDiscussionMessage } from './artifact-discussion-message';
import { artifactRoundChatTarget } from './artifact-modification-source';
import { addMediaWorkToChat } from './media-chat-composer';
import { MEDIA_SELECTION_REFUSAL_COPY } from './media-chat-selection';

/** A deliberate discussion action references this exact round in the original composer; it never sends. */
export function useArtifactChatDiscussion(view: ArtifactReviewView, round: ArtifactReviewRound, title?: string) {
  const reveal = useWorkspaceChatReveal();
  const { cats } = useCatData();
  const [notice, setNotice] = useState<string | null>(null);
  const discuss = (body?: string) => {
    const threadId = useChatStore.getState().currentThreadId;
    const target = artifactRoundChatTarget(view, round, title);
    const ownerCatId = view.authority.ownerCatId;
    if (threadId !== view.review.task.threadId || !target || !ownerCatId) {
      setNotice('请回到这件作品的对话后继续讨论。');
      return false;
    }
    const ownerTarget = buildCatOptions(cats).find((option) => option.id === ownerCatId && !option.isGroup);
    if (!ownerTarget) {
      setNotice('暂时无法确认负责猫的发送入口，请稍后重试。');
      return false;
    }
    const result = addMediaWorkToChat(threadId, target, true);
    if (result.kind === 'refused') {
      setNotice(MEDIA_SELECTION_REFUSAL_COPY[result.reason]);
      return false;
    } else {
      setNotice(null);
      const queued = useChatStore.getState().pendingChatInsert;
      if (queued?.threadId === threadId) {
        const message = artifactDiscussionMessage(
          ownerTarget.insert,
          `${getThreadDraft(threadId)}\n${queued.text}`,
          body,
        );
        useChatStore.getState().setPendingChatInsert({
          ...queued,
          text: [queued.text, message].filter(Boolean).join('\n'),
          preserveSelection: queued.preserveSelection ?? true,
        });
      }
      reveal?.(threadId);
      return true;
    }
  };
  return { discuss, notice };
}
