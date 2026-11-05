import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { createQuoteContextAttachment } from '../chat-context-reference';
import { addQuoteToChat } from '../workspace/workspace-file-quote';

/** A deliberate source-message quote and mention; the target composer owns hydration, append and persistence. */
export function queueWorkDiscussion(
  artifact: GlobalArtifactDTO,
  mention: string,
  draftReadFailure: { title: string; message: string },
): boolean {
  if (!artifact.threadId || !artifact.sourceMessageId || !artifact.catId || !mention.trim()) return false;
  const queued = useChatStore.getState().pendingChatInsert;
  if (queued && queued.threadId !== artifact.threadId) return false;
  const attachment = createQuoteContextAttachment([artifact.name, artifact.url].filter(Boolean).join('\n'), {
    kind: 'message',
    threadId: artifact.threadId,
    messageId: artifact.sourceMessageId,
    senderCatId: artifact.catId,
  });
  if (addQuoteToChat(artifact.threadId, attachment).kind !== 'added') return false;
  const next = useChatStore.getState().pendingChatInsert;
  if (!next || next.threadId !== artifact.threadId) return false;
  useChatStore.getState().setPendingChatInsert({
    ...next,
    text: `${[next.text, mention.trim()].filter(Boolean).join('\n')} `,
    waitForDraft: true,
    draftReadFailure,
  });
  return true;
}
