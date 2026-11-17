import type { ContextAttachment } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';

export type ComposerDraft = { text: string; contexts: ContextAttachment[]; replyTo?: string };
type SavedDraft = {
  text?: string;
  replyTo?: string;
  contentBlocks?: { type: string; attachment?: ContextAttachment }[];
};

const draftPath = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/composer-draft`;
const isEmpty = (draft: ComposerDraft) => !draft.text.trim() && !draft.contexts.length && !draft.replyTo;

/**
 * The owner's draft of each conversation lives on the server, so a refresh or another device continues it.
 * Opening a conversation reads it once, and an empty composer takes it. Edits are written back under the last
 * known revision; on a conflict the server's revision is taken and the write repeated, because the composer
 * being typed in is the newest draft.
 */
export function useServerComposerDraft(input: {
  threadId: string;
  enabled: boolean;
  draft: ComposerDraft;
  composerEmpty: () => boolean;
  restore: (draft: ComposerDraft) => void;
}) {
  const revisions = useRef(new Map<string, number>());
  const latest = useRef(input);
  latest.current = input;
  const { threadId, enabled } = input;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void apiFetch(draftPath(threadId))
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { draft: SavedDraft | null; revision: number };
        if (!live) return;
        revisions.current.set(threadId, body.revision);
        const saved: ComposerDraft = {
          text: body.draft?.text ?? '',
          contexts: (body.draft?.contentBlocks ?? []).flatMap((block) =>
            block.type === 'context_attachment' && block.attachment ? [block.attachment] : [],
          ),
          ...(body.draft?.replyTo ? { replyTo: body.draft.replyTo } : {}),
        };
        const local = latest.current.draft;
        if (!isEmpty(saved) && latest.current.composerEmpty()) latest.current.restore(saved);
        // Words already in this composer are the newest draft: they replace what the server kept.
        else if (!isEmpty(local) && JSON.stringify(local) !== JSON.stringify(saved))
          await writeDraft(threadId, local, revisions.current);
      })
      // An unreachable draft leaves this tab's composer as it is; the next edit writes again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [threadId, enabled]);
  const signature = JSON.stringify(input.draft);
  useEffect(() => {
    if (!enabled || !revisions.current.has(threadId)) return;
    const draft = JSON.parse(signature) as ComposerDraft;
    const timer = setTimeout(() => void writeDraft(threadId, draft, revisions.current).catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [threadId, enabled, signature]);
  return {
    /** A send the server took: that conversation's saved draft is gone too. */
    clear: (sent: string) =>
      void writeDraft(sent, { text: '', contexts: [] }, revisions.current).catch(() => undefined),
  };
}

async function writeDraft(threadId: string, draft: ComposerDraft, revisions: Map<string, number>, retried = false) {
  const expectedRevision = revisions.get(threadId) ?? 0;
  if (isEmpty(draft) && !expectedRevision) return;
  const response = await apiFetch(draftPath(threadId), {
    method: isEmpty(draft) ? 'DELETE' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      isEmpty(draft)
        ? { expectedRevision }
        : {
            expectedRevision,
            text: draft.text,
            ...(draft.contexts.length
              ? { contentBlocks: draft.contexts.map((attachment) => ({ type: 'context_attachment', attachment })) }
              : {}),
            ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
          },
    ),
  });
  if (response.status === 409 && !retried) {
    const conflict = (await response.json()) as { actualRevision?: number };
    if (typeof conflict.actualRevision !== 'number') return;
    revisions.set(threadId, conflict.actualRevision);
    return writeDraft(threadId, draft, revisions, true);
  }
  if (!response.ok) return;
  const saved = (await response.json()) as { draft?: { revision?: number } | null; revision?: number };
  revisions.set(threadId, saved.draft?.revision ?? saved.revision ?? 0);
}
