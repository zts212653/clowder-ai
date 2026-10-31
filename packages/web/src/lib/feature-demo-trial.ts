import { flushComposerDraft } from '@/components/composer-draft-flush-registry';
import { durableDraftSnapshotFromOwner, writeOwnerComposerDraft } from '@/components/durable-composer-draft-helpers';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { loadOwnerComposerDraft } from '@/utils/true-recall';

/** Persist through the original draft owner before a possible full-document navigation. Never invokes a cat. */
export async function openFeatureDemoTrial(prompt: string, signal?: AbortSignal): Promise<boolean> {
  const originalUrl = window.location.href;
  try {
    if (signal?.aborted || useChatStore.getState().pendingChatInsert) return false;
    const sourceThreadId = useChatStore.getState().currentThreadId;
    if (sourceThreadId) await flushComposerDraft(sourceThreadId);
    const targetThreadId = await useConciergeStore.getState().fetchThreadId({ refresh: true });
    if (!targetThreadId || signal?.aborted || window.location.href !== originalUrl) return false;
    const clientSnapshot =
      targetThreadId === sourceThreadId ? await flushComposerDraft(targetThreadId, { includeRevision: true }) : null;
    const owner = await loadOwnerComposerDraft(targetThreadId);
    if (signal?.aborted || window.location.href !== originalUrl) return false;
    const draft = durableDraftSnapshotFromOwner(owner.draft);
    const text = draft.text.endsWith(prompt) ? draft.text : [draft.text, prompt].filter(Boolean).join('\n\n');
    const result =
      text === draft.text
        ? { kind: 'saved' as const, revision: owner.revision }
        : await writeOwnerComposerDraft(targetThreadId, owner.revision, { ...draft, text });
    if (result.kind !== 'saved' || signal?.aborted || window.location.href !== originalUrl) return false;
    // The in-chat transition keeps a mounted editor; non-chat entries reload and read the same durable draft.
    if (clientSnapshot)
      useChatStore.getState().setPendingChatInsert({
        threadId: targetThreadId,
        text,
        authoritative: true,
        serverRevision: result.revision,
        imageUrls: draft.imageUrls,
        contextAttachments: draft.contextAttachments,
        ...(draft.replyTo ? { replyToId: draft.replyTo } : {}),
        ...(clientSnapshot ? { clientSnapshot } : {}),
      });
    pushThreadRouteWithHistory(targetThreadId, window);
    return true;
  } catch {
    return false;
  }
}
