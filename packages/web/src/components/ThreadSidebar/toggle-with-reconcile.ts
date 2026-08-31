/**
 * Sequenced toggle with failure reconciliation.
 *
 * Maintains per-key request sequence counters so that:
 * - Stale successful responses (from an older toggle) are discarded
 * - On failure, a reconcile GET fetches server truth, but only applies
 *   if no newer toggle has fired since the reconcile was triggered
 *
 * Used by ThreadSidebar for pin/favorite toggles.
 */

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;

export interface ToggleWithReconcileOptions {
  /** The fetch function to use (e.g. apiFetch) */
  fetch: FetchFn;
  /** Called when a new value should be applied to the store */
  onUpdate: (threadId: string, value: boolean) => void;
  /** JSON field name in the thread object (e.g. 'pinned' or 'favorited') */
  field: string;
  /** Pre-existing seq map to use (allows sharing across instances) */
  seqMap?: Map<string, number>;
  /** Sibling seq map — used to guard the sibling field during reconcile */
  siblingSeqMap: Map<string, number>;
  /** Called to apply sibling field value during reconcile */
  onUpdateSibling?: (threadId: string, value: boolean) => void;
  /** Sibling field name (e.g. 'favorited' when field is 'pinned') */
  siblingField?: string;
}

export function createToggleWithReconcile(opts: ToggleWithReconcileOptions) {
  const seqMap = opts.seqMap ?? new Map<string, number>();

  async function reconcile(threadId: string, expectedSeq: number, expectedSiblingSeq: number): Promise<void> {
    try {
      const res = await opts.fetch(`/api/threads/${threadId}`);
      if (!res.ok) return;
      const t = await res.json();
      const val = t[opts.field];
      if (val !== undefined && seqMap.get(threadId) === expectedSeq) {
        opts.onUpdate(threadId, val);
      }
      if (opts.siblingField && opts.onUpdateSibling) {
        const sibVal = t[opts.siblingField];
        if (sibVal !== undefined && (opts.siblingSeqMap.get(threadId) ?? 0) === expectedSiblingSeq) {
          opts.onUpdateSibling(threadId, sibVal);
        }
      }
    } catch {
      // best-effort
    }
  }

  async function toggle(threadId: string, value: boolean): Promise<void> {
    const seq = (seqMap.get(threadId) ?? 0) + 1;
    seqMap.set(threadId, seq);
    const siblingSeq = opts.siblingSeqMap.get(threadId) ?? 0;
    try {
      const res = await opts.fetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [opts.field]: value }),
      });
      if (!res.ok) {
        if (seqMap.get(threadId) === seq) {
          void reconcile(threadId, seq, siblingSeq);
        }
        return;
      }
      if (seqMap.get(threadId) !== seq) return;
      const updated = await res.json();
      opts.onUpdate(threadId, updated[opts.field] ?? value);
    } catch {
      if (seqMap.get(threadId) === seq) {
        void reconcile(threadId, seq, siblingSeq);
      }
    }
  }

  return { toggle, seqMap };
}
