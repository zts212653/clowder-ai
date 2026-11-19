import type { ContextAttachment, FileContent, ImageContent } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { apiFetch } from '@/utils/api-client';

/** An uploaded attachment the draft keeps as the server stored it: an image, or a file with its name, type and size. */
export type DraftFile = Pick<ImageContent, 'type' | 'url'> | FileContent;
/** images: the uploaded attachments in the input; a picked file is uploaded only when it is sent. */
export type ComposerDraft = { text: string; images: DraftFile[]; contexts: ContextAttachment[]; replyTo?: string };
type SavedDraft = {
  text?: string;
  replyTo?: string;
  contentBlocks?: ({ type: string; url?: string; attachment?: ContextAttachment } | FileContent)[];
};

const draftPath = (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/composer-draft`;
const isEmpty = (draft: ComposerDraft) =>
  !draft.text.trim() && !draft.images.length && !draft.contexts.length && !draft.replyTo;
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
  /** Shows a saved draft in the input; what it returns settles once the input shows all of it (attachments are read back).
   *  `current` says whether the input still belongs to that conversation: what arrives after a switch is dropped. */
  restore: (draft: ComposerDraft, current: () => boolean) => void | Promise<unknown>;
}) {
  const known = useRef<Known>(new Map());
  const pending = useRef<{ threadId: string; draft: ComposerDraft } | null>(null);
  // The conversation whose server draft the input shows in full (attachments read back). Until then nothing is written:
  // the input is not yet what the owner left. Each opening starts unshown; a restore after a switch never counts.
  const shown = useRef<string | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const { threadId, enabled } = input;
  const signature = JSON.stringify(input.draft);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    shown.current = null;
    const opened = JSON.stringify(latest.current.draft);
    void apiFetch(draftPath(threadId))
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { draft: SavedDraft | null; revision: number };
        if (!live) return;
        const blocks = body.draft?.contentBlocks ?? [];
        const saved: ComposerDraft = {
          text: body.draft?.text ?? '',
          images: blocks.flatMap((block): DraftFile[] =>
            block.type === 'file' && 'fileName' in block
              ? [block]
              : block.type === 'image' && block.url
                ? [{ type: 'image', url: block.url }]
                : [],
          ),
          contexts: blocks.flatMap((block) =>
            block.type === 'context_attachment' && block.attachment ? [block.attachment] : [],
          ),
          ...(body.draft?.replyTo ? { replyTo: body.draft.replyTo } : {}),
        };
        known.current.set(threadId, { revision: body.revision, signature: JSON.stringify(saved) });
        const now = JSON.stringify(latest.current.draft);
        if (now !== opened) await writeDraft(threadId, latest.current.draft, known.current);
        else if (now !== JSON.stringify(saved)) {
          // A draft whose attachments can't be read back is as unknown as an unreachable one: nothing overwrites it.
          const ok = await Promise.resolve(latest.current.restore(saved, () => live)).then(
            () => true,
            () => false,
          );
          // Only this opening's own failure counts: a later opening may already have read a newer draft.
          if (!ok) {
            if (live) known.current.delete(threadId);
            return;
          }
        }
        if (live) shown.current = threadId;
      })
      // An unreachable draft leaves this tab's composer as it is; the next edit writes again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [threadId, enabled]);
  useEffect(() => {
    const server = known.current.get(threadId);
    // Nothing to write until the server's draft is known and shown, or while the composer shows exactly that draft.
    if (!enabled || !server || shown.current !== threadId) return;
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
    clear: (sent: string) =>
      void writeDraft(sent, { text: '', images: [], contexts: [] }, known.current).catch(() => undefined),
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
            ...(draft.images.length || draft.contexts.length
              ? {
                  contentBlocks: [
                    ...draft.images,
                    ...draft.contexts.map((attachment) => ({ type: 'context_attachment', attachment })),
                  ],
                }
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
