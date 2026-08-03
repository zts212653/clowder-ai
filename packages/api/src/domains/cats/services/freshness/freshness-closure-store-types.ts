import type {
  FreshnessClosureAggregate,
  FreshnessClosureBlockedReason,
  FreshnessSupplementAggregate,
  FreshnessSupplementFailureReason,
  LegacyClosureMigrationOutcomeCounts,
} from '@cat-cafe/shared';
import type { FreshnessSupplementOfferInput } from './glass-box/FreshnessSupplementStateMachine.js';

export type OfferFreshnessSupplementResult =
  | { kind: 'offered'; supplement: FreshnessSupplementAggregate }
  | { kind: 'budget_exhausted'; supplement: FreshnessSupplementAggregate };

export interface FreshnessClosureScope {
  userId: string;
  threadId: string;
  catId: string;
}

export interface OpenOrAdvanceFreshnessClosureInput extends FreshnessClosureScope {
  closureId: string;
  invocationId: string;
  turnInvocationId?: string;
  originTriggerMessageId?: string | null;
  draftContent: string;
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  observedRawFrontierMessageId: string | null;
  replayUnsafeToolNames?: string[];
  now: number;
}

export interface ClaimFreshnessClosureInput {
  invocationId: string;
  inputFrontierMessageId: string;
  observedRawFrontierMessageId: string | null;
  now: number;
  automatic?: boolean;
  automaticAttemptLimit?: number;
}

export interface SupersedeFreshnessClosureInput {
  invocationId: string;
  turnInvocationId?: string;
  draftContent: string;
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  observedRawFrontierMessageId: string | null;
  evidenceRefs: string[];
  replayUnsafeToolNames?: string[];
  now: number;
}

export interface BlockFreshnessClosureInput {
  invocationId: string;
  reason: FreshnessClosureBlockedReason;
  evidenceRefs: string[];
  draftContent?: string;
  now: number;
}

export interface BlockFreshnessClosureRecoveryInput {
  evidenceRefs: string[];
  now: number;
}

export interface RefreshFreshnessClosureFrontierInput {
  requiredMessageIds: string[];
  requiredFrontierMessageId: string;
  observedRawFrontierMessageId: string;
  now: number;
}

export interface CommitFreshnessClosureInput {
  invocationId: string;
  messageId: string;
  observedRawFrontierMessageId: string | null;
  draftContent?: string;
  evidenceRefs?: string[];
  now: number;
}

export interface MigrateLegacyFreshnessClosureInput {
  expectedRevision: number;
  actorId: string;
  evidenceRef: string;
  manifestSha256: string;
  accountingSha256: string;
  invocationIds: string[];
  messageIds: string[];
  evidenceRefs: string[];
  outcomeCounts: LegacyClosureMigrationOutcomeCounts;
  now: number;
}

export interface FreshnessClosureStore {
  get(closureId: string): Promise<FreshnessClosureAggregate | null>;
  listActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate[]>;
  /** @deprecated Commit paths must use an explicit closureId. Kept for read compatibility. */
  getActiveByScope(scope: FreshnessClosureScope): Promise<FreshnessClosureAggregate | null>;
  openOrAdvance(input: OpenOrAdvanceFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  claimAttempt(closureId: string, input: ClaimFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  supersedeAttempt(closureId: string, input: SupersedeFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  blockAttempt(closureId: string, input: BlockFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  blockPreflight(closureId: string, input: { evidenceRefs: string[]; now: number }): Promise<FreshnessClosureAggregate>;
  refreshFrontier(closureId: string, input: RefreshFreshnessClosureFrontierInput): Promise<FreshnessClosureAggregate>;
  blockRecovery(closureId: string, input: BlockFreshnessClosureRecoveryInput): Promise<FreshnessClosureAggregate>;
  commit(closureId: string, input: CommitFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  recoverAttempt(closureId: string, input: { evidenceRef: string; now: number }): Promise<FreshnessClosureAggregate>;
  retry(
    closureId: string,
    input: { actorId: string; evidenceRef: string; now: number },
  ): Promise<FreshnessClosureAggregate>;
  migrateLegacy(closureId: string, input: MigrateLegacyFreshnessClosureInput): Promise<FreshnessClosureAggregate>;
  dispose(
    closureId: string,
    input: {
      kind: 'deferred' | 'superseded' | 'dismissed';
      actorId: string;
      evidenceRef: string;
      now: number;
    },
  ): Promise<FreshnessClosureAggregate>;
  listActiveByThread(threadId: string): Promise<FreshnessClosureAggregate[]>;
  listAllActive(): Promise<FreshnessClosureAggregate[]>;
  listRecoverable(): Promise<FreshnessClosureAggregate[]>;
  listUpdatedBetween(fromInclusive: number, toExclusive: number): Promise<FreshnessClosureAggregate[]>;
  getSupplement(supplementId: string): Promise<FreshnessSupplementAggregate | null>;
  listSupplementsByLineage(lineageId: string): Promise<FreshnessSupplementAggregate[]>;
  listSupplementsByThread(threadId: string): Promise<FreshnessSupplementAggregate[]>;
  listRecoverableSupplements(): Promise<FreshnessSupplementAggregate[]>;
  offerSupplement(input: FreshnessSupplementOfferInput): Promise<OfferFreshnessSupplementResult>;
  claimSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate>;
  commitSupplement(
    supplementId: string,
    input: { invocationId: string; messageId: string; now: number },
  ): Promise<FreshnessSupplementAggregate>;
  declineSupplement(
    supplementId: string,
    input: { invocationId: string; now: number },
  ): Promise<FreshnessSupplementAggregate>;
  failSupplement(
    supplementId: string,
    input: { invocationId?: string; reason: FreshnessSupplementFailureReason; now: number },
  ): Promise<FreshnessSupplementAggregate>;
  deleteByThread(threadId: string): Promise<number>;
}
