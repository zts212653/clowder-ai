import {
  buildHumanDispositionLedgerReceipt,
  classifyHumanDispositionFeedbackReplay,
  type HumanDispositionLedgerEntry,
  type HumanDispositionLedgerReceipt,
  humanDispositionLedgerEntrySchema,
  type SessionHandoffProposal,
} from '@cat-cafe/shared';
import { buildSessionHandoffDispositionLedgerEntry } from '../../../../human-disposition/human-disposition-adapters.js';
import { InMemoryHumanDispositionReceiptIndex } from '../../../../human-disposition/InMemoryHumanDispositionReceiptIndex.js';
import type { RejectSessionHandoffInput, SessionHandoffRejectionResult } from './SessionHandoffDisposition.js';

export class InMemorySessionHandoffDisposition {
  constructor(private readonly receipts: InMemoryHumanDispositionReceiptIndex) {}

  reject(proposal: SessionHandoffProposal, input: RejectSessionHandoffInput): SessionHandoffRejectionResult {
    if (!Number.isFinite(input.decidedAt) || input.decidedAt < 0) {
      throw new Error('decidedAt must be a finite nonnegative number');
    }
    if (proposal.status === 'rejected') return this.classifyTerminal(proposal, input);
    if (proposal.status !== 'pending') return { outcome: 'not_available', proposal };

    const entry = buildSessionHandoffDispositionLedgerEntry({
      proposal,
      decidedAt: input.decidedAt,
      feedback: input.feedback,
    });
    const receipt = buildHumanDispositionLedgerReceipt(entry);
    if (this.receipts.get(proposal.userId, receipt.sourceRef) || proposal.humanDispositionLedgerEntry) {
      return { outcome: 'invariant_failure', proposal };
    }

    proposal.status = 'rejected';
    proposal.updatedAt = input.decidedAt;
    proposal.humanDispositionLedgerEntry = entry;
    if (entry.episode.feedback) proposal.latestHumanDisposition = entry.episode.feedback;
    else delete proposal.latestHumanDisposition;
    if (this.receipts.append(proposal.userId, receipt) !== 'applied') {
      throw new Error('in-memory disposition receipt changed during synchronous transition');
    }
    return { outcome: 'applied', proposal };
  }

  load(
    proposal: SessionHandoffProposal | undefined,
    ownerUserId: string,
    receipt: HumanDispositionLedgerReceipt,
  ): HumanDispositionLedgerEntry | null {
    if (!proposal || proposal.userId !== ownerUserId) return null;
    const entry = humanDispositionLedgerEntrySchema.safeParse(proposal.humanDispositionLedgerEntry);
    if (!entry.success) return null;
    const storedReceipt = this.receipts.get(ownerUserId, receipt.sourceRef);
    if (JSON.stringify(storedReceipt) !== JSON.stringify(receipt)) return null;
    return JSON.stringify(buildHumanDispositionLedgerReceipt(entry.data)) === JSON.stringify(receipt)
      ? entry.data
      : null;
  }

  private classifyTerminal(
    proposal: SessionHandoffProposal,
    input: RejectSessionHandoffInput,
  ): SessionHandoffRejectionResult {
    const entry = humanDispositionLedgerEntrySchema.safeParse(proposal.humanDispositionLedgerEntry);
    if (!entry.success) return { outcome: 'legacy_unmigrated', proposal };
    const receipt = buildHumanDispositionLedgerReceipt(entry.data);
    const storedReceipt = this.receipts.get(proposal.userId, receipt.sourceRef);
    const canonicalFeedback = entry.data.episode.feedback;
    if (
      JSON.stringify(storedReceipt) !== JSON.stringify(receipt) ||
      classifyHumanDispositionFeedbackReplay(proposal.latestHumanDisposition, canonicalFeedback) === 'conflict'
    ) {
      return { outcome: 'invariant_failure', proposal };
    }
    const replay = classifyHumanDispositionFeedbackReplay(canonicalFeedback, input.feedback);
    return { outcome: replay === 'replay' ? 'replayed' : 'conflict', proposal };
  }
}
