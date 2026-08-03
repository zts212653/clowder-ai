import type {
  HumanDispositionFeedbackInput,
  HumanDispositionLedgerReceipt,
  SessionHandoffProposal,
} from '@cat-cafe/shared';

export interface RejectSessionHandoffInput {
  decidedAt: number;
  feedback?: HumanDispositionFeedbackInput;
}

export type SessionHandoffRejectionOutcome =
  | 'applied'
  | 'replayed'
  | 'conflict'
  | 'legacy_unmigrated'
  | 'invariant_failure'
  | 'not_available';

export interface SessionHandoffRejectionResult {
  outcome: SessionHandoffRejectionOutcome;
  proposal?: SessionHandoffProposal;
}

export interface SessionHandoffDispositionEntryLookup {
  ownerUserId: string;
  receipt: HumanDispositionLedgerReceipt;
}

const SOURCE_PREFIX = 'F225:session-handoff:';
const SOURCE_SUFFIX = ':reject';

export function sessionHandoffProposalIdFromSourceRef(sourceRef: string): string | null {
  if (!sourceRef.startsWith(SOURCE_PREFIX) || !sourceRef.endsWith(SOURCE_SUFFIX)) return null;
  const proposalId = sourceRef.slice(SOURCE_PREFIX.length, -SOURCE_SUFFIX.length);
  return proposalId.length > 0 ? proposalId : null;
}
