import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { useCallback, useMemo, useState } from 'react';
import { readWorkspaceOperationReceipt } from './workspace-review-action-recovery';
import {
  draftSchema,
  type WorkspaceAnnotationTarget,
  type WorkspaceReviewDraft,
  workspaceReviewDraftKey,
  workspaceReviewDraftPrefix,
} from './workspace-review-draft';

type TextTarget = Extract<WorkspaceAnnotationTarget, { kind: 'text_quote' }>;

/**
 * Text left by the retired F309 text composer (CVO095/098). New text annotations go through the selection
 * card into chat, so these items are only ever finished, never written to the owner again. One stored draft
 * can hold two independent items: an old save whose result is unknown, and text typed after it.
 */
export type LegacyTextItem =
  | {
      readonly kind: 'pending';
      readonly key: string;
      readonly sourceRevision: string;
      readonly operationId: string;
      readonly expectedRevision: number;
      readonly body: string;
      readonly quote: string;
    }
  | {
      readonly kind: 'draft';
      readonly key: string;
      readonly sourceRevision: string;
      /** Captured exactly as stored: continuing compares against it before clearing anything. */
      readonly body: string;
      readonly target: TextTarget;
      readonly quote: string;
    };
export type LegacyTextOutcome =
  | { readonly kind: 'saved'; readonly annotationId: string | null }
  | { readonly kind: 'unsaved' }
  | { readonly kind: 'unknown' };
/** What happened to local storage: done, refused because the item changed meanwhile, or not written. */
export type LegacyTextLocal = 'settled' | 'stale' | 'failed';
type Settlement = { readonly patch: Partial<WorkspaceReviewDraft>; readonly record?: WorkspaceReviewDraft };

/** An old save proven unsaved while newer text holds the draft slot is kept here; old clients never read it. */
export const unsavedRecordKey = (key: string, operationId: string) => `${key}#unsaved:${operationId}`;
const sameTarget = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** The live slot still holds the very text the old save sent (the composer kept it until confirmation). */
const liveIsPending = (draft: WorkspaceReviewDraft) =>
  Boolean(draft.annotation) &&
  draft.body.trim() === draft.annotation?.body &&
  sameTarget(draft.target, draft.annotation?.target);

export function legacyTextItemsOf(key: string, sourceRevision: string, draft: WorkspaceReviewDraft): LegacyTextItem[] {
  const items: LegacyTextItem[] = [];
  const pending = draft.annotation;
  if (pending?.target.kind === 'text_quote')
    items.push({
      kind: 'pending',
      key,
      sourceRevision,
      operationId: pending.operationId,
      expectedRevision: pending.expectedRevision,
      body: pending.body,
      quote: pending.target.quote,
    });
  if (draft.target?.kind === 'text_quote' && draft.body.trim() && !liveIsPending(draft))
    items.push({
      kind: 'draft',
      key,
      sourceRevision,
      body: draft.body,
      target: draft.target,
      quote: draft.target.quote,
    });
  return items;
}

/** Settles exactly the captured old save; anything else now in the slot is left alone ('stale'). */
export function settlePending(
  draft: WorkspaceReviewDraft,
  item: Extract<LegacyTextItem, { kind: 'pending' }>,
  outcome: 'saved' | 'unsaved',
): Settlement | 'stale' {
  const pending = draft.annotation;
  // Saved and no longer pending here (e.g. the owner read already confirmed it): the end state is reached.
  if (!pending && outcome === 'saved') return { patch: {} };
  if (pending?.operationId !== item.operationId || pending.expectedRevision !== item.expectedRevision) return 'stale';
  if (outcome === 'saved')
    return { patch: { annotation: null, ...(liveIsPending(draft) ? { body: '', target: null } : {}) } };
  if (liveIsPending(draft) || !draft.body.trim())
    return { patch: { annotation: null, body: pending.body, target: pending.target } };
  // Newer text holds the slot: the proven-unsaved text becomes its own item instead of being dropped.
  return {
    patch: { annotation: null },
    record: {
      v: 1,
      body: pending.body,
      target: pending.target,
      activeAnnotationId: null,
      annotation: null,
      action: null,
      refresh: null,
    },
  };
}

/** Finishes exactly the captured draft; if the slot now holds different text, nothing is cleared. */
export function finishDraft(
  draft: WorkspaceReviewDraft,
  item: Extract<LegacyTextItem, { kind: 'draft' }>,
): Settlement | 'stale' {
  if (draft.body !== item.body || !sameTarget(draft.target, item.target)) return 'stale';
  return { patch: { body: '', target: null } };
}

function readStored(key: string): WorkspaceReviewDraft | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? draftSchema.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Old text of this review across every source version (and proven-unsaved records). The current version
 * is owned by the live draft hook; every other key is read from and written to storage directly.
 */
export function useLegacyTextNotes({
  view,
  draft,
  load,
  base,
}: {
  readonly view: WorkspaceContentReviewView | null;
  readonly draft: {
    readonly activeKey: { readonly current: string | null };
    readonly snapshot: WorkspaceReviewDraft;
    readonly settleDurable: (
      settle: (value: WorkspaceReviewDraft) => Partial<WorkspaceReviewDraft> | 'stale' | 'failed',
    ) => LegacyTextLocal;
  };
  readonly load: (reviewId: string) => Promise<WorkspaceContentReviewView>;
  readonly base: string;
}) {
  const [storageTick, setStorageTick] = useState(0);
  const text = view?.review.source.kind === 'text' ? view : null;
  const found = useMemo(() => {
    void storageTick;
    const items: LegacyTextItem[] = [];
    let unreadable = 0;
    if (!text || typeof localStorage === 'undefined') return { items, unreadable };
    const currentKey = workspaceReviewDraftKey(text);
    items.push(...legacyTextItemsOf(currentKey, text.review.source.revision, draft.snapshot));
    const prefix = workspaceReviewDraftPrefix(text.review);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix) || key === currentKey) continue;
      const stored = readStored(key);
      if (!stored) unreadable += 1;
      else items.push(...legacyTextItemsOf(key, key.slice(prefix.length).split('#')[0] ?? '', stored));
    }
    return { items, unreadable };
  }, [text, draft.snapshot, storageTick]);

  /**
   * Compare-and-set against what storage holds right now — for the active key too, through the draft hook's
   * durable entry — never against the value an item was read from or this tab's memory. Writes go first.
   */
  const apply = useCallback(
    (key: string, settle: (value: WorkspaceReviewDraft) => Settlement | 'stale', recordKey?: string) => {
      let recordWritten = false;
      const judge = (value: WorkspaceReviewDraft): Partial<WorkspaceReviewDraft> | 'stale' | 'failed' => {
        const settlement = settle(value);
        if (settlement === 'stale') return 'stale';
        if (settlement.record && recordKey) {
          try {
            localStorage.setItem(recordKey, JSON.stringify(settlement.record));
            recordWritten = true;
          } catch {
            return 'failed';
          }
        }
        return settlement.patch;
      };
      let result: LegacyTextLocal;
      if (key === draft.activeKey.current) result = draft.settleDurable(judge);
      else {
        const stored = readStored(key);
        const patch = stored ? judge(stored) : 'stale';
        if (!stored || patch === 'stale' || patch === 'failed') result = patch === 'failed' ? 'failed' : 'stale';
        else {
          try {
            localStorage.setItem(key, JSON.stringify(draftSchema.parse({ ...stored, ...patch })));
            result = 'settled';
          } catch {
            result = 'failed';
          }
        }
      }
      if (result !== 'settled' && recordWritten && recordKey) {
        try {
          localStorage.removeItem(recordKey);
        } catch {
          // The record only duplicates text still held by the unsettled slot.
        }
      }
      setStorageTick((tick) => tick + 1);
      return result;
    },
    [draft],
  );

  /** Old save first by its operation: saved → the original record; provably unsaved → continuable text. */
  const reconcile = useCallback(
    async (
      item: Extract<LegacyTextItem, { kind: 'pending' }>,
    ): Promise<{ owner: LegacyTextOutcome; local: LegacyTextLocal | null }> => {
      if (!text) return { owner: { kind: 'unknown' }, local: null };
      const refreshed = await load(text.review.reviewId).catch(() => undefined);
      const record = refreshed?.review.annotations.find((annotation) => annotation.operationId === item.operationId);
      let owner: LegacyTextOutcome = { kind: 'unknown' };
      if (record) owner = { kind: 'saved', annotationId: record.id };
      else if (refreshed) {
        const receipt = await readWorkspaceOperationReceipt(base, text.review.reviewId, item.operationId);
        if (receipt && receipt.actor.kind === 'human' && receipt.actor.actorId === refreshed.review.ownerUserId)
          owner = { kind: 'saved', annotationId: null };
        // The owner writes an annotation only at its expected revision; once the review moved past it with no
        // receipt, the old request can never land. Without that fence an in-flight write stays possible.
        else if (receipt === null && refreshed.review.revision > item.expectedRevision) owner = { kind: 'unsaved' };
      }
      if (owner.kind === 'unknown') return { owner, local: null };
      const outcome = owner.kind;
      const local = apply(
        item.key,
        (value) => settlePending(value, item, outcome),
        unsavedRecordKey(item.key, item.operationId),
      );
      return { owner, local };
    },
    [text, load, base, apply],
  );

  /** The person carried this draft into the chat card; it is cleared only if it is still that exact text. */
  const continued = useCallback(
    (item: Extract<LegacyTextItem, { kind: 'draft' }>): LegacyTextLocal =>
      apply(item.key, (value) => finishDraft(value, item)),
    [apply],
  );

  return { items: found.items, unreadable: found.unreadable, reconcile, continued };
}
export type LegacyTextNotes = ReturnType<typeof useLegacyTextNotes>;
