'use client';

import { useState } from 'react';
import { jumpToApprovalAnchor } from '@/components/ApprovalProvenanceLinks';
import { createQuoteContextAttachment } from '@/components/chat-context-reference';
import { useWorkspaceChatReveal } from '@/components/workbench/WorkspaceChatReveal';
import { addQuoteToChat } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { useShellCopy } from '../shell/shell-copy';
import { memoryGroupCopy } from './memory-group.shell-copy';
import type { OriginalMemoryGroupCard } from './memory-group-source';

/** Uses the original conversation draft; never sends or edits a proposal. */
export function MemoryGroupRequestChanges({ original }: { original: OriginalMemoryGroupCard }) {
  const t = useShellCopy(memoryGroupCopy);
  const reveal = useWorkspaceChatReveal();
  const [notice, setNotice] = useState<string | null>(null);
  const requestChanges = () => {
    const { threadId, messageId } = original.coordinate;
    const quote = createQuoteContextAttachment(original.block.title, { kind: 'message', threadId, messageId });
    if (addQuoteToChat(threadId, quote).kind !== 'added') {
      setNotice(t.changeBlocked);
      return;
    }
    const queued = useChatStore.getState().pendingChatInsert;
    if (!queued || queued.threadId !== threadId) return;
    useChatStore.getState().setPendingChatInsert({
      ...queued,
      text: [queued.text, t.changePrompt].filter(Boolean).join('\n'),
      waitForDraft: true,
    });
    jumpToApprovalAnchor(threadId, messageId);
    reveal?.(threadId);
    setNotice(t.changeReady);
  };
  return (
    <div className="mt-2 space-y-1 text-xs">
      <button type="button" className="shell-focusable rounded px-2 py-1" onClick={requestChanges}>
        {t.change}
      </button>
      {notice ? <output className="block text-cafe-muted">{notice}</output> : null}
    </div>
  );
}
