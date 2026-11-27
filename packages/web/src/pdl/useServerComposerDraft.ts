import type { ContextAttachment, FileContent, ImageContent } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type ApiSessionIdentity, apiSessionIdentity } from '@/utils/api-session-identity';

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

/** Apply this tab's edits over the latest server draft. */
function mergeDraft(base: ComposerDraft, ours: ComposerDraft, server: ComposerDraft): ComposerDraft {
  const replyTo = ours.replyTo === base.replyTo ? server.replyTo : ours.replyTo;
  return {
    text: ours.text === base.text ? server.text : ours.text,
    images: mergeList(base.images, ours.images, server.images, (file) => file.url),
    contexts: mergeList(base.contexts, ours.contexts, server.contexts, (attachment) => attachment.id),
    ...(replyTo ? { replyTo } : {}),
  };
}
const isEmpty = (draft: ComposerDraft) =>
  !draft.text.trim() && !draft.images.length && !draft.contexts.length && !draft.replyTo;
const emptyDraft: ComposerDraft = { text: '', images: [], contexts: [] };
const emptySignature = JSON.stringify(emptyDraft);
type Edit = { draft: ComposerDraft; base?: ComposerDraft };
type KnownDraft = { revision: number; signature: string; afterSend?: true };
type Scope = {
  session: ApiSessionIdentity;
  known: Map<string, KnownDraft>;
  pending: { threadId: string; draft: ComposerDraft } | null;
  edits: Map<string, Edit>;
  sends: Set<string>;
};
export type DraftSendRevision = number | 'current';
type Show = (threadId: string, merged: ComposerDraft) => void;

const currentSession = (scope: Scope) => apiSessionIdentity.getSnapshot() === scope.session;
const editKey = (scope: Scope, threadId: string) =>
  'cat-cafe:composer-edit:' + encodeURIComponent(scope.session.ownerUserId ?? '') + ':' + encodeURIComponent(threadId);

function isStoredDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<ComposerDraft>;
  return (
    typeof draft.text === 'string' &&
    Array.isArray(draft.images) &&
    Array.isArray(draft.contexts) &&
    (draft.replyTo === undefined || typeof draft.replyTo === 'string')
  );
}

function readEdit(scope: Scope, threadId: string): Edit | undefined {
  const held = scope.edits.get(threadId);
  if (held) return held;
  try {
    const raw = localStorage.getItem(editKey(scope, threadId));
    if (!raw) return undefined;
    const edit = JSON.parse(raw) as Partial<Edit> | null;
    if (edit && isStoredDraft(edit.draft) && (edit.base === undefined || isStoredDraft(edit.base))) {
      return { draft: edit.draft, base: edit.base };
    }
  } catch {
    // Browser storage can be unavailable. The edit remains usable in this page.
  }
  return undefined;
}

function rememberEdit(scope: Scope, threadId: string, edit?: Edit, previous?: Edit): void {
  if (edit) scope.edits.set(threadId, edit);
  else scope.edits.delete(threadId);
  try {
    if (edit) localStorage.setItem(editKey(scope, threadId), JSON.stringify(edit));
    else if (previous && localStorage.getItem(editKey(scope, threadId)) === JSON.stringify(previous)) {
      localStorage.removeItem(editKey(scope, threadId));
    }
  } catch {
    // Keep the in-page edit until the server acknowledges it.
  }
}

// Abort while apiFetch waits for a refreshed session too, to avoid retrying a body as a different owner.
async function inDraftSession<T>(scope: Scope, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (!currentSession(scope) || !scope.session.ownerUserId) return undefined;
  const controller = new AbortController();
  const release = apiSessionIdentity.subscribe(() => {
    if (!currentSession(scope)) controller.abort();
  });
  try {
    const result = await run(controller.signal);
    return currentSession(scope) ? result : undefined;
  } finally {
    release();
  }
}

function readSaved(scope: Scope, threadId: string, fresh = false) {
  return inDraftSession(scope, async (signal) => {
    const response = await apiFetch(draftPath(threadId), { signal }, fresh ? { afterCurrentGet: true } : undefined);
    if (response.ok) return (await response.json()) as { draft: SavedDraft | null; revision: number };
    return undefined;
  });
}

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
  const session = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const scope = useMemo<Scope>(
    () => ({ session, known: new Map(), edits: new Map(), pending: null, sends: new Set() }),
    [session],
  );
  const opening = useRef<{ threadId: string; images?: { visible: DraftFile[]; complete: DraftFile[] } }>();
  // An opening starts unshown. A slow restore can queue edits using the saved attachment descriptors,
  // and only flushes them if the owner leaves before all attachments are available.
  const shown = useRef<string | null>(null);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const latest = useRef(input);
  latest.current = input;
  const { threadId, enabled } = input;
  // A conflict's merge goes into the input (attachments only: the words there may have moved on); nothing is written
  // while its attachments are read back.
  const show: Show = (id, merged) => {
    if (!currentSession(scope) || latest.current.threadId !== id) return;
    const owner = opening.current;
    const isCurrent = () => currentSession(scope) && opening.current === owner && latest.current.threadId === id;
    shown.current = null;
    void Promise.resolve(latest.current.restore({ ...merged, text: latest.current.draft.text }, isCurrent)).then(
      () => {
        if (isCurrent()) shown.current = id;
      },
      () => undefined,
    );
  };
  const signature = JSON.stringify(input.draft);
  const holdWrites = input.holdWrites === true;
  useEffect(() => {
    if (!enabled || !session.ownerUserId) return;
    const owner: NonNullable<typeof opening.current> = { threadId };
    opening.current = owner;
    const isCurrent = () => currentSession(scope) && opening.current === owner && latest.current.threadId === threadId;
    shown.current = null;
    const opened = JSON.stringify(latest.current.draft);
    const openedRevision = latest.current.revision ?? 0;
    // Reopening can race the write flushed on the previous departure.
    const readDraft = () => readSaved(scope, threadId);
    const previousWrite = writing.get(editKey(scope, threadId));
    void (previousWrite ? previousWrite.then(() => (isCurrent() ? readDraft() : undefined)) : readDraft())
      .then(async (body) => {
        if (!body || !isCurrent()) return;
        const saved = fromSaved(body.draft);
        const waiting = readEdit(scope, threadId);
        const resumed = waiting?.base ? mergeDraft(waiting.base, waiting.draft, saved) : (waiting?.draft ?? saved);
        scope.known.set(threadId, { revision: body.revision, signature: JSON.stringify(saved) });
        const now = latest.current.draft;
        // What the owner typed before the server answered stays; the server's attachments they haven't seen join it.
        const typedSinceOpen = openedRevision !== (latest.current.revision ?? 0) || opened !== JSON.stringify(now);
        const merged = typedSinceOpen ? mergeDraft(JSON.parse(opened) as ComposerDraft, now, resumed) : resumed;
        if (JSON.stringify(now) !== JSON.stringify(merged)) {
          owner.images = { visible: now.images, complete: merged.images };
          // A draft whose attachments can't be read back is as unknown as an unreachable one.
          const ok = await Promise.resolve(latest.current.restore(merged, isCurrent)).then(
            () => true,
            () => false,
          );
          if (!isCurrent()) return;
          owner.images = undefined;
          if (!ok) {
            scope.known.delete(threadId);
            if (scope.pending?.threadId === threadId) scope.pending = null;
            return;
          }
        }
        shown.current = threadId;
        // The restore can queue attachment state in React. Save the committed composer on its next render.
        setRestoreRevision((revision) => revision + 1);
      })
      // An unreachable draft leaves this tab's composer as it is; the next edit writes again.
      .catch(() => undefined);
    return () => {
      if (opening.current === owner) opening.current = undefined;
    };
  }, [threadId, enabled, scope, session.ownerUserId]);
  useEffect(() => {
    const server = scope.known.get(threadId);
    const restoreImages = opening.current?.images;
    // Keep any previous committed edit queued while the native IME owns its candidate text.
    if (!enabled || !server || holdWrites || (!restoreImages && shown.current !== threadId)) return;
    let draft = JSON.parse(signature) as ComposerDraft;
    if (server.afterSend) {
      if (isEmpty(draft)) return;
      draft = mergeDraft(emptyDraft, draft, JSON.parse(server.signature) as ComposerDraft);
    }
    if (restoreImages) {
      draft.images = mergeList(restoreImages.visible, draft.images, restoreImages.complete, (file) => file.url);
    }
    if (server.signature === JSON.stringify(draft)) {
      scope.pending = null;
      return;
    }
    scope.pending = { threadId, draft };
    if (restoreImages) return;
    const timer = setTimeout(() => flush(scope, show), 600);
    return () => clearTimeout(timer);
  }, [threadId, enabled, signature, holdWrites, restoreRevision, scope]);
  useEffect(() => () => flush(scope, show), [threadId, scope]);
  useEffect(() => {
    const leave = () => flush(scope, show, true);
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [scope]);

  return {
    /** Accepted sends consume an exact revision captured by the message route, even before the browser's first read. */
    send: async (
      sent: string,
      admit: (revision: DraftSendRevision, signal: AbortSignal) => Promise<false | { revision?: number }>,
    ): Promise<boolean> => {
      if (scope.sends.has(sent)) return false;
      scope.sends.add(sent);
      try {
        await writing.get(editKey(scope, sent));
        const expected = scope.known.get(sent)?.revision ?? 'current';
        const submittedEdit = readEdit(scope, sent);
        const accepted = await inDraftSession(scope, (signal) => admit(expected, signal));
        if (!accepted) return false;
        if (opening.current?.threadId === sent) {
          opening.current = undefined;
          shown.current = sent;
        }
        if (scope.pending?.threadId === sent) scope.pending = null;
        rememberEdit(scope, sent, undefined, scope.edits.get(sent) ?? submittedEdit);

        if (accepted.revision !== undefined || expected === 0) {
          scope.known.set(sent, { revision: accepted.revision ?? 0, signature: emptySignature });
        } else {
          // A different revision may have arrived elsewhere. Learn its base without filling the input just sent.
          scope.known.delete(sent);
          void readSaved(scope, sent, true)
            .then((saved) => {
              if (!saved || !currentSession(scope) || scope.known.has(sent)) return;
              scope.known.set(sent, {
                revision: saved.revision,
                signature: JSON.stringify(fromSaved(saved.draft)),
                afterSend: true,
              });
              setRestoreRevision((revision) => revision + 1);
            })
            .catch(() => undefined);
        }
        return true;
      } finally {
        scope.sends.delete(sent);
        if (scope.pending?.threadId === sent) flush(scope, show);
      }
    },
  };
}

function flush(scope: Scope, show: Show, keepalive = false) {
  const waiting = scope.pending;
  if (!waiting) return;
  const queuedOn = scope.known.get(waiting.threadId)?.signature;
  const edit = { draft: waiting.draft, base: queuedOn ? (JSON.parse(queuedOn) as ComposerDraft) : undefined };
  rememberEdit(scope, waiting.threadId, edit);
  if (scope.sends.has(waiting.threadId)) return;
  scope.pending = null;
  const threadId = waiting.threadId;
  const key = editKey(scope, threadId);
  const run = () => {
    if (!currentSession(scope)) return;
    const now = scope.known.get(threadId)?.signature;
    const draft =
      queuedOn && now && now !== queuedOn && edit.base
        ? mergeDraft(edit.base, edit.draft, JSON.parse(now) as ComposerDraft)
        : edit.draft;
    if (draft !== edit.draft && JSON.stringify(draft) !== JSON.stringify(edit.draft)) show(threadId, draft);
    return writeDraft(threadId, draft, scope, show, false, keepalive).then((saved) => {
      if (saved && scope.edits.get(threadId) === edit) rememberEdit(scope, threadId, undefined, edit);
    });
  };
  const tail = (writing.get(key) ?? Promise.resolve()).then(run).catch(() => undefined);
  writing.set(key, tail);
  void tail.then(() => {
    if (writing.get(key) === tail) writing.delete(key);
  });
}

/** Serialize draft writes as well as the base read they may need, for each account and conversation. */
const writing = new Map<string, Promise<void>>();

async function writeDraft(
  threadId: string,
  draft: ComposerDraft,
  scope: Scope,
  show: Show,
  retried = false,
  keepalive = false,
): Promise<boolean> {
  const expectedRevision = scope.known.get(threadId)?.revision;
  if (expectedRevision === undefined) return false;
  const empty = isEmpty(draft);
  if (empty && expectedRevision === 0) return true;
  const result = await inDraftSession(scope, async (signal) => {
    const response = await apiFetch(draftPath(threadId), {
      signal,
      method: empty ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      keepalive,
      body: JSON.stringify(
        empty
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
    if (response.status === 409) return { conflict: true as const };
    if (!response.ok) return undefined;
    return (await response.json()) as { draft?: { revision?: number } | null; revision?: number };
  });
  if (!result) return false;
  if ('conflict' in result) {
    if (retried) return false;
    const body = await readSaved(scope, threadId, true);
    if (!body || !currentSession(scope)) return false;
    const before = scope.known.get(threadId)?.signature;
    const server = fromSaved(body.draft);
    const merged = mergeDraft(before ? (JSON.parse(before) as ComposerDraft) : draft, draft, server);
    scope.known.set(threadId, { revision: body.revision, signature: JSON.stringify(server) });
    if (JSON.stringify(merged) !== JSON.stringify(draft)) show(threadId, merged);
    return writeDraft(threadId, merged, scope, show, true, keepalive);
  }
  scope.known.set(threadId, {
    revision: result.draft?.revision ?? result.revision ?? 0,
    signature: JSON.stringify(draft),
  });
  return true;
}
