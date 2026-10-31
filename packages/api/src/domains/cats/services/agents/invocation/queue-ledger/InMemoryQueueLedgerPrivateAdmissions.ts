import { type QueueLedgerEntry, queueLedgerAdmissionFingerprint } from './QueueLedger.js';

/** What a settled `private_input` identity means for an incoming row carrying the same id. */
export type PrivateAdmissionVerdict = 'unseen' | 'replay' | 'conflict';

/**
 * Durable admission receipts for `private_input` rows.
 *
 * A public input's admission winner is its History message, which outlives the Queue row being
 * retired at the processing boundary. A private input has no History member by design and its row
 * is deliberately deleted once its last target starts, so without a receipt a replayed stable key
 * would be admitted — and executed — a second time.
 *
 * The receipt stores the envelope fingerprint rather than just the id. That is what lets a retired
 * identity reach the same verdict a live row gets from `queueLedgerAdmissionsMatch`: the same
 * envelope is a replay, a different envelope reusing the key is a conflict. An id-only receipt
 * cannot tell those apart and would report a changed payload as successfully admitted.
 */
export class InMemoryQueueLedgerPrivateAdmissions {
  private readonly byThread = new Map<string, Map<string, string>>();

  /** Record the winner. Only `private_input` rows own a receipt; every other kind has a message. */
  remember(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    for (const entry of entries) {
      if (entry.kind !== 'private_input') continue;
      const receipts = this.byThread.get(threadId) ?? new Map<string, string>();
      receipts.set(entry.id, queueLedgerAdmissionFingerprint(entry));
      this.byThread.set(threadId, receipts);
    }
  }

  /**
   * Retract receipts for a rolled-back admission.
   *
   * A receipt left behind after a compensated write would refuse the identity forever, turning one
   * failed attempt into a permanent tombstone that silently swallows every later retry of the key.
   */
  forget(threadId: string, entries: readonly QueueLedgerEntry[]): void {
    const receipts = this.byThread.get(threadId);
    if (!receipts) return;
    for (const entry of entries) {
      if (entry.kind === 'private_input') receipts.delete(entry.id);
    }
    if (receipts.size === 0) this.byThread.delete(threadId);
  }

  verdict(threadId: string, entry: QueueLedgerEntry): PrivateAdmissionVerdict {
    if (entry.kind !== 'private_input') return 'unseen';
    const receipt = this.byThread.get(threadId)?.get(entry.id);
    if (receipt === undefined) return 'unseen';
    return receipt === queueLedgerAdmissionFingerprint(entry) ? 'replay' : 'conflict';
  }
}
