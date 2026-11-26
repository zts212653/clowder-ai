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

function fromSaved(draft: SavedDraft | null | undefined): ComposerDraft {
  const blocks = draft?.contentBlocks ?? [];
  return {
    text: draft?.text ?? '',
    images: blocks.flatMap((block): DraftFile[] =>
      block.type === 'file' && 'fileName' in block
        ? [block]
        : block.type === 'image' && block.url
          ? [{ type: 'image', url: block.url }]
          : [],
    ),
    contexts: blocks.flatMap((block) =>
      block.type === 'context_attachment' && 'attachment' in block && block.attachment ? [block.attachment] : [],
    ),
    ...(draft?.replyTo ? { replyTo: draft.replyTo } : {}),
  };
}

/** The server's list with this tab's own changes since `base` applied: what this tab added is added, what it removed
 *  stays removed, and what arrived from elsewhere is kept. */
function mergeList<T>(base: T[], ours: T[], server: T[], key: (item: T) => string): T[] {
  const had = new Set(base.map(key)),
    has = new Set(ours.map(key));
  const kept = server.filter((item) => !had.has(key(item)) || has.has(key(item)));
  const seen = new Set(kept.map(key));
  return [...kept, ...ours.filter((item) => !had.has(key(item)) && !seen.has(key(item)))];
}

/** This tab's draft over the server's: its words and reply stand; attachments merge against what it last knew. */
function mergeDraft(base: ComposerDraft, ours: ComposerDraft, server: ComposerDraft): ComposerDraft {
  const replyTo = ours.replyTo ?? (base.replyTo ? undefined : server.replyTo);
  return {
    text: ours.text,
    images: mergeList(base.images, ours.images, server.images, (file) => file.url),
    contexts: mergeList(base.contexts, ours.contexts, server.contexts, (attachment) => attachment.id),
    ...(replyTo ? { replyTo } : {}),
  };
}
const isEmpty = (draft: ComposerDraft) =>
  !draft.text.trim() && !draft.images.length && !draft.contexts.length && !draft.replyTo;
/** What the server holds for a conversation, as far as this tab knows: its revision and the draft it saved. */
type Known = Map<string, { revision: number; signature: string }>;
/** Puts a merged draft into the input, when that conversation is still the one open. */
type Show = (threadId: string, merged: ComposerDraft) => void;

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
  /** IME is composing: keep the transient text, but no draft write/delete may persist uncommitted pinyin. */
  holdWrites?: boolean;
  /** Bumped for every composer edit, including composition input. A later edit wins over an older server restore. */
  revision?: number;
}) {
  const known = useRef<Known>(new Map());
  const pending = useRef<{ threadId: string; draft: ComposerDraft } | null>(null);
  // The conversation whose server draft the input shows in full (attachments read back). Until then nothing is written:
  // the input is not yet what the owner left. Each opening starts unshown; a restore after a switch never counts.
  const shown = useRef<string | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const { threadId, enabled } = input;
  // A conflict's merge goes into the input (attachments only: the words there may have moved on); nothing is written
  // while its attachments are read back.
  const show: Show = (id, merged) => {
    if (latest.current.threadId !== id) return;
    shown.current = null;
    void Promise.resolve(
      latest.current.restore({ ...merged, text: latest.current.draft.text }, () => latest.current.threadId === id),
    ).then(
      () => {
        if (latest.current.threadId === id) shown.current = id;
      },
      () => undefined,
    );
  };
  const signature = JSON.stringify(input.draft);
  const holdWrites = input.holdWrites === true;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    shown.current = null;
    const opened = JSON.stringify(latest.current.draft);
    const openedRevision = latest.current.revision ?? 0;
    void apiFetch(draftPath(threadId))
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { draft: SavedDraft | null; revision: number };
        if (!live) return;
        const saved = fromSaved(body.draft);
        known.current.set(threadId, { revision: body.revision, signature: JSON.stringify(saved) });
        const { draft: now, holdWrites: wasComposing } = latest.current;
        // What the owner typed before the server answered stays; the server's attachments they haven't seen join it.
        const typedSinceOpen = openedRevision !== (latest.current.revision ?? 0) || opened !== JSON.stringify(now);
        const merged = typedSinceOpen ? mergeDraft(JSON.parse(opened) as ComposerDraft, now, saved) : saved;
        if (JSON.stringify(now) !== JSON.stringify(merged)) {
          // A draft whose attachments can't be read back is as unknown as an unreachable one: nothing overwrites it.
          const ok = await Promise.resolve(latest.current.restore(merged, () => live)).then(
            () => true,
            () => false,
          );
          // Only this opening's own failure counts: a later opening may already have read a newer draft.
          if (!ok) {
            if (live) known.current.delete(threadId);
            return;
          }
        }
        if (!live) return;
        shown.current = threadId;
        // What the owner typed first is written at once, with the server's attachments it now carries.
        // If attachments took longer than the composition, send the latest committed words with them.
        const committed = wasComposing ? { ...merged, text: latest.current.draft.text } : merged;
        if (!latest.current.holdWrites && JSON.stringify(committed) !== JSON.stringify(saved)) {
          await saveDraft(threadId, committed, known.current, show);
        }
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
    // Keep any previous committed edit queued while the native IME owns its candidate text.
    if (!enabled || !server || shown.current !== threadId || holdWrites) return;
    if (server.signature === signature) {
      pending.current = null;
      return;
    }
    pending.current = { threadId, draft: JSON.parse(signature) as ComposerDraft };
    const timer = setTimeout(() => flush(pending, known.current, show), 600);
    return () => clearTimeout(timer);
  }, [threadId, enabled, signature, holdWrites]);
  useEffect(() => () => flush(pending, known.current, show), [threadId]);
  useEffect(() => {
    const leave = () => flush(pending, known.current, show, true);
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  return {
    /** A send the server took: that conversation's saved draft is gone too. */
    clear: (sent: string) =>
      void saveDraft(sent, { text: '', images: [], contexts: [] }, known.current, show).catch(() => undefined),
  };
}

function flush(
  pending: { current: { threadId: string; draft: ComposerDraft } | null },
  known: Known,
  show: Show,
  keepalive = false,
) {
  const waiting = pending.current;
  pending.current = null;
  // Uncommitted IME text is not a draft; dropping the pending write keeps it out of the server on a switch/unload.
  if (waiting) void saveDraft(waiting.threadId, waiting.draft, known, show, keepalive).catch(() => undefined);
}

/** The write still going for each conversation: the next one waits for it (its conflict read and merge included),
 *  so a later edit is written over the revision the earlier one left, never raced by it. */
const writing = new Map<string, Promise<void>>();
function saveDraft(threadId: string, draft: ComposerDraft, known: Known, show: Show, keepalive = false) {
  // The draft was made over what the server held when it was queued; an earlier write may have moved that on (a
  // merge from another tab): this draft's own changes go over the newer one.
  const queuedOn = known.get(threadId)?.signature;
  const run = () => {
    const now = known.get(threadId)?.signature;
    const rebased =
      queuedOn && now && now !== queuedOn
        ? mergeDraft(JSON.parse(queuedOn) as ComposerDraft, draft, JSON.parse(now) as ComposerDraft)
        : draft;
    if (rebased !== draft && JSON.stringify(rebased) !== JSON.stringify(draft)) show(threadId, rebased);
    return writeDraft(threadId, rebased, known, show, false, keepalive);
  };
  const next = (writing.get(threadId) ?? Promise.resolve()).then(run, run);
  const tail = next.catch(() => undefined);
  writing.set(threadId, tail);
  void tail.then(() => {
    if (writing.get(threadId) === tail) writing.delete(threadId);
  });
  return next;
}

async function writeDraft(
  threadId: string,
  draft: ComposerDraft,
  known: Known,
  show: Show,
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
    // The draft changed elsewhere: read it, keep what arrived there, apply this tab's own changes, show and write that.
    const read = await apiFetch(draftPath(threadId));
    if (!read.ok) return;
    const body = (await read.json()) as { draft: SavedDraft | null; revision: number };
    const before = known.get(threadId)?.signature;
    const server = fromSaved(body.draft),
      merged = mergeDraft(before ? (JSON.parse(before) as ComposerDraft) : draft, draft, server);
    known.set(threadId, { revision: body.revision, signature: JSON.stringify(server) });
    if (JSON.stringify(merged) !== JSON.stringify(draft)) show(threadId, merged);
    return writeDraft(threadId, merged, known, show, true, keepalive);
  }
  if (!response.ok) return;
  const saved = (await response.json()) as { draft?: { revision?: number } | null; revision?: number };
  known.set(threadId, { revision: saved.draft?.revision ?? saved.revision ?? 0, signature: JSON.stringify(draft) });
}
