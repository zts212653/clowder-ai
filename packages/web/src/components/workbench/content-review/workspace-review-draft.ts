import {
  artifactReviewAnchorSchema,
  type WorkspaceContentReviewView,
  workspaceContentReviewActionSchema,
} from '@cat-cafe/shared';
import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';

const id = z.string().min(1).max(256),
  revision = z.number().int().positive().safe();
export const workspaceAnnotationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text_quote'), quote: z.string().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal('media_anchor'), anchor: artifactReviewAnchorSchema }).strict(),
]);
export type WorkspaceAnnotationTarget = z.infer<typeof workspaceAnnotationTargetSchema>;
const operation = { operationId: id, expectedRevision: revision };
export const draftSchema = z
  .object({
    v: z.literal(1),
    body: z.string().max(8000),
    target: workspaceAnnotationTargetSchema.nullable(),
    activeAnnotationId: id.nullable(),
    annotation: z
      .object({ ...operation, body: z.string().min(1).max(8000), target: workspaceAnnotationTargetSchema })
      .strict()
      .nullable(),
    action: z
      .object({ ...operation, actionKey: z.string().max(1_000_000), action: workspaceContentReviewActionSchema })
      .strict()
      .nullable(),
    refresh: z
      .object({ ...operation, expectedSourceRevision: z.string().min(1).max(200).optional() })
      .strict()
      .nullable(),
  })
  .strict();
export type WorkspaceReviewDraft = z.infer<typeof draftSchema>;
const empty = (): WorkspaceReviewDraft => ({
  v: 1,
  body: '',
  target: null,
  activeAnnotationId: null,
  annotation: null,
  action: null,
  refresh: null,
});
/** Each source version of one review keeps its own draft under this prefix. */
export function workspaceReviewDraftPrefix(
  review: Pick<WorkspaceContentReviewView['review'], 'ownerUserId' | 'reviewId'>,
) {
  return `cat-cafe:content-review:${review.ownerUserId}:${review.reviewId}:version:`;
}
export function workspaceReviewDraftKey(view: WorkspaceContentReviewView) {
  return `${workspaceReviewDraftPrefix(view.review)}${view.review.source.revision}`;
}

/**
 * What storage held when this tab last read or wrote its key (`raw`, null when absent), and the draft that
 * corresponds to it (`json`). Memory that differs from `json` holds edits whose own write failed.
 */
type Synced = { readonly raw: string | null; readonly json: string };
const syncedWith = (raw: string | null, value: WorkspaceReviewDraft): Synced => ({ raw, json: JSON.stringify(value) });

/**
 * Only activated by a fresh owner read. Writes happen at the user action, never in a late unmount effect.
 *
 * Settlement, per active key (storage = the key's value now, memory = `current`, synced = the last sync):
 * | storage vs synced.raw | memory vs synced.json | the judgement reads      | on 'stale'       |
 * | unchanged             | either                | memory (incl. unsaved)   | nothing to adopt |
 * | moved (another tab)   | unchanged             | storage                  | adopt storage    |
 * | moved (another tab)   | ahead (write failed)  | nothing: 'stale' at once | keep memory      |
 * Invariants: a settlement never overwrites a body only memory holds; storage is written before memory
 * changes; a conflict writes nothing and adopts nothing.
 */
export function useWorkspaceReviewDraft() {
  const current = useRef(empty()),
    key = useRef<string | null>(null);
  const unreadable = useRef(false);
  const synced = useRef<Synced>(syncedWith(null, current.current));
  const [snapshot, publish] = useState(current.current),
    [storageError, setStorageError] = useState(false);
  const save = useCallback((patch: Partial<WorkspaceReviewDraft>): boolean => {
    const next = draftSchema.parse({ ...current.current, ...patch });
    current.current = next;
    publish(next);
    if (!key.current || unreadable.current) return false;
    try {
      const raw = JSON.stringify(next);
      localStorage.setItem(key.current, raw);
      synced.current = syncedWith(raw, next);
      setStorageError(false);
      return true;
    } catch {
      setStorageError(true);
      return false;
    }
  }, []);
  const activate = useCallback((view: WorkspaceContentReviewView) => {
    const nextKey = workspaceReviewDraftKey(view);
    if (key.current === nextKey) return;
    key.current = nextKey;
    try {
      const raw = localStorage.getItem(nextKey);
      current.current = raw ? draftSchema.parse(JSON.parse(raw)) : empty();
      synced.current = syncedWith(raw, current.current);
      unreadable.current = false;
      setStorageError(false);
    } catch {
      current.current = empty();
      unreadable.current = true;
      setStorageError(true);
    }
    publish(current.current);
  }, []);
  const reset = useCallback(() => {
    key.current = null;
    unreadable.current = false;
    current.current = empty();
    synced.current = syncedWith(null, current.current);
    publish(current.current);
    setStorageError(false);
  }, []);
  /**
   * Compare-and-set on the active key for settlements, judged three ways (table above): from this tab's memory
   * while storage still holds what this tab last synced, from storage when another tab wrote and this tab has
   * nothing unsaved, and not at all when both moved. The write goes first; memory changes only after it succeeded.
   */
  const settleDurable = useCallback(
    (
      settle: (value: WorkspaceReviewDraft) => Partial<WorkspaceReviewDraft> | 'stale' | 'failed',
    ): 'settled' | 'stale' | 'failed' => {
      if (!key.current || unreadable.current) return 'failed';
      let storedRaw: string | null;
      let stored: WorkspaceReviewDraft;
      try {
        storedRaw = localStorage.getItem(key.current);
        stored = storedRaw ? draftSchema.parse(JSON.parse(storedRaw)) : empty();
      } catch {
        return 'failed';
      }
      const storageMoved = storedRaw !== synced.current.raw;
      if (storageMoved && JSON.stringify(current.current) !== synced.current.json) return 'stale';
      const base = storageMoved ? stored : current.current;
      const patch = settle(base);
      if (patch === 'failed') return 'failed';
      if (patch === 'stale') {
        if (storageMoved) {
          current.current = stored;
          synced.current = syncedWith(storedRaw, stored);
          publish(stored);
        }
        return 'stale';
      }
      const next = draftSchema.parse({ ...base, ...patch });
      const raw = JSON.stringify(next);
      try {
        localStorage.setItem(key.current, raw);
      } catch {
        setStorageError(true);
        return 'failed';
      }
      current.current = next;
      synced.current = syncedWith(raw, next);
      publish(next);
      setStorageError(false);
      return 'settled';
    },
    [],
  );
  const confirmAnnotation = useCallback(
    (operationId: string) =>
      settleDurable((value) => {
        const pending = value.annotation;
        if (!pending || pending.operationId !== operationId) return 'stale';
        const same =
          value.body.trim() === pending.body && JSON.stringify(value.target) === JSON.stringify(pending.target);
        return { annotation: null, ...(same ? { body: '', target: null } : {}) };
      }),
    [settleDurable],
  );
  // `activeKey` names the storage key `current` belongs to, so a late writer can tell whether it still owns it.
  return { current, activeKey: key, snapshot, storageError, save, activate, reset, confirmAnnotation, settleDurable };
}
