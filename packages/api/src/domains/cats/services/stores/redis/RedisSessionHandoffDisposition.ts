import {
  buildHumanDispositionLedgerReceipt,
  classifyHumanDispositionFeedbackReplay,
  humanDispositionFeedbackInputSchema,
  humanDispositionLedgerEntrySchema,
  type SessionHandoffProposal,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { buildSessionHandoffDispositionLedgerEntry } from '../../../../human-disposition/human-disposition-adapters.js';
import { humanDispositionReceiptAppendArguments } from '../../../../human-disposition/human-disposition-lua.js';
import type { RejectSessionHandoffInput, SessionHandoffRejectionResult } from '../ports/SessionHandoffDisposition.js';
import { CAS_AND_SETTLE_LUA } from './redis-handoff-lua-scripts.js';
import { HandoffKeys } from './session-handoff-keys.js';

type ProposalLoader = (proposalId: string) => Promise<SessionHandoffProposal | null>;

export async function rejectSessionHandoffWithDisposition(
  redis: RedisClient,
  proposalId: string,
  input: RejectSessionHandoffInput,
  loadProposal: ProposalLoader,
): Promise<SessionHandoffRejectionResult> {
  if (!Number.isFinite(input.decidedAt) || input.decidedAt < 0) {
    throw new Error('decidedAt must be a finite nonnegative number');
  }
  const feedback = input.feedback === undefined ? undefined : humanDispositionFeedbackInputSchema.parse(input.feedback);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await attemptRejection(redis, proposalId, input.decidedAt, feedback, loadProposal);
    if (result !== 'retry') return result;
  }

  const settled = await loadProposal(proposalId);
  if (settled?.status === 'rejected') return classifyTerminalRejection(redis, settled, feedback);
  return { outcome: 'not_available', ...(settled ? { proposal: settled } : {}) };
}

async function attemptRejection(
  redis: RedisClient,
  proposalId: string,
  decidedAt: number,
  feedback: RejectSessionHandoffInput['feedback'],
  loadProposal: ProposalLoader,
): Promise<SessionHandoffRejectionResult | 'retry'> {
  const proposal = await loadProposal(proposalId);
  if (!proposal) return { outcome: 'not_available' };
  if (proposal.status === 'rejected') return classifyTerminalRejection(redis, proposal, feedback);
  if (proposal.status !== 'pending') return { outcome: 'not_available', proposal };

  const entry = buildSessionHandoffDispositionLedgerEntry({ proposal, decidedAt, feedback });
  const result = await evalRejection(redis, proposal, entry);
  if (result === 'APPLIED') {
    return { outcome: 'applied', proposal: (await loadProposal(proposalId)) ?? proposal };
  }
  if (result === 'CONFLICT') {
    const settled = await loadProposal(proposalId);
    if (settled?.status === 'rejected') return classifyTerminalRejection(redis, settled, feedback);
  }
  return result === 'CAS_MISS' ? 'retry' : { outcome: mapLuaFailure(result), proposal };
}

async function classifyTerminalRejection(
  redis: RedisClient,
  proposal: SessionHandoffProposal,
  incomingFeedback: RejectSessionHandoffInput['feedback'],
): Promise<SessionHandoffRejectionResult> {
  const entry = humanDispositionLedgerEntrySchema.safeParse(proposal.humanDispositionLedgerEntry);
  if (!entry.success) return { outcome: 'legacy_unmigrated', proposal };

  const integrity = await evalRejection(redis, proposal, entry.data);
  if (integrity !== 'REPLAY') return { outcome: mapLuaFailure(integrity), proposal };

  const replay = classifyHumanDispositionFeedbackReplay(entry.data.episode.feedback, incomingFeedback);
  return { outcome: replay === 'replay' ? 'replayed' : 'conflict', proposal };
}

async function evalRejection(
  redis: RedisClient,
  proposal: SessionHandoffProposal,
  entry: NonNullable<SessionHandoffProposal['humanDispositionLedgerEntry']>,
): Promise<string> {
  const receipt = buildHumanDispositionLedgerReceipt(entry);
  const receiptCall = humanDispositionReceiptAppendArguments(proposal.userId, receipt);
  const feedbackJson = entry.episode.feedback ? JSON.stringify(entry.episode.feedback) : '';
  return (await redis.eval(
    CAS_AND_SETTLE_LUA,
    6,
    HandoffKeys.detail(proposal.proposalId),
    HandoffKeys.user(proposal.userId),
    HandoffKeys.settledUser(proposal.userId),
    ...receiptCall.keys,
    'pending',
    'rejected',
    String(entry.episode.decidedAt),
    proposal.proposalId,
    feedbackJson,
    JSON.stringify(entry),
    ...receiptCall.arguments.slice(0, 3),
  )) as string;
}

function mapLuaFailure(result: string): SessionHandoffRejectionResult['outcome'] {
  if (result === 'REPLAY') return 'replayed';
  if (result === 'CONFLICT') return 'conflict';
  if (result === 'LEGACY_UNMIGRATED') return 'legacy_unmigrated';
  if (result === 'CAS_MISS') return 'not_available';
  return 'invariant_failure';
}
