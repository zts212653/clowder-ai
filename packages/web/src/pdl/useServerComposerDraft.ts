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
/** What the server holds for a conversation, as far as this tab knows: its revision and the draft it saved. */
type Known = Map<string, { revision: number; signature: string }>;

/**
 * The owner's draft of each conversation lives on the server, so a refresh or another device continues it, and a
 * draft sent or cleared elsewhere does not come back. Opening a conversation shows the server's draft (what this
 * browser kept is only a quick first view), unless the owner typed before the server answered. Edits are written
 * back under the last known revision (a conflict takes the server's revision and writes again); an edit still
 * waiting is written at once when the conversation changes or the page goes away, so nothing typed is lost.
 */
export function useServerComposerDraft(input: {
  threadId: string;
  enabled: boolean;
  draft: ComposerDraft;
  restore: (draft: ComposerDraft) => void;
}) {
  const known = useRef<Known>(new Map());
  const pending = useRef<{ threadId: string; draft: ComposerDraft } | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const { threadId, enabled } = input;
  const signature = JSON.stringify(input.draft);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const opened = JSON.stringify(latest.current.draft);
    void apiFetch(draftPath(threadId))
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { draft: SavedDraft | null; revision: number };
        if (!live) return;
        const saved: ComposerDraft = {
          text: body.draft?.text ?? '',
          contexts: (body.draft?.contentBlocks ?? []).flatMap((block) =>
            block.type === 'context_attachment' && block.attachment ? [block.attachment] : [],
          ),
          ...(body.draft?.replyTo ? { replyTo: body.draft.replyTo } : {}),
        };
        known.current.set(threadId, { revision: body.revision, signature: JSON.stringify(saved) });
        const now = JSON.stringify(latest.current.draft);
        if (now !== opened) await writeDraft(threadId, latest.current.draft, known.current);
        else if (now !== JSON.stringify(saved)) latest.current.restore(saved);
      })
      // An unreachable draft leaves this tab's composer as it is; the next edit writes again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [threadId, enabled]);
  useEffect(() => {
    const server = known.current.get(threadId);
    // Nothing to write until the server's draft is known, or while the composer shows exactly that draft.
    if (!enabled || !server) return;
    if (server.signature === signature) {
      pending.current = null;
      return;
    }
    pending.current = { threadId, draft: JSON.parse(signature) as ComposerDraft };
    const timer = setTimeout(() => flush(pending, known.current), 600);
    return () => clearTimeout(timer);
  }, [threadId, enabled, signature]);
  useEffect(() => () => flush(pending, known.current), [threadId]);
  useEffect(() => {
    const leave = () => flush(pending, known.current, true);
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  return {
    /** A send the server took: that conversation's saved draft is gone too. */
    clear: (sent: string) => void writeDraft(sent, { text: '', contexts: [] }, known.current).catch(() => undefined),
  };
}

function flush(
  pending: { current: { threadId: string; draft: ComposerDraft } | null },
  known: Known,
  keepalive = false,
) {
  const waiting = pending.current;
  pending.current = null;
  if (waiting) void writeDraft(waiting.threadId, waiting.draft, known, false, keepalive).catch(() => undefined);
}

async function writeDraft(
  threadId: string,
  draft: ComposerDraft,
  known: Known,
  retried = false,
  keepalive = false,
): Promise<void> {
  const expectedRevision = known.get(threadId)?.revision ?? 0;
  if (isEmpty(draft) && !expectedRevision) return;
  const response = await apiFetch(draftPath(threadId), {
    method: isEmpty(draft) ? 'DELETE' : 'PUT',
    headers: { 'Content-Type': 'application/json' },
    keepalive,
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
    known.set(threadId, { revision: conflict.actualRevision, signature: '' });
    return writeDraft(threadId, draft, known, true, keepalive);
  }
  if (!response.ok) return;
  const saved = (await response.json()) as { draft?: { revision?: number } | null; revision?: number };
  known.set(threadId, { revision: saved.draft?.revision ?? saved.revision ?? 0, signature: JSON.stringify(draft) });
}
