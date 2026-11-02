import type {
  RuntimeInteractionCardRef,
  RuntimeInteractionRecord,
  RuntimeInteractionRequest,
  RuntimeInteractionSubmission,
  RuntimeInteractionTerminal,
  RuntimeInteractionTerminalReasonCode,
} from '@cat-cafe/shared';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../utils/settled-history-page.js';

export interface CreateRuntimeInteractionInput {
  request: RuntimeInteractionRequest;
  hostEpoch: string;
  now: number;
}

export interface SettleRuntimeInteractionInput {
  interactionId: string;
  hostEpoch: string;
  terminal: RuntimeInteractionTerminal;
  now: number;
  expectedRevision?: number;
}

export interface ClaimRuntimeInteractionSubmissionInput {
  interactionId: string;
  expectedRevision: number;
  submission: RuntimeInteractionSubmission;
  now: number;
}

export interface CompleteRuntimeInteractionSubmissionInput {
  interactionId: string;
  expectedRevision: number;
  operationId: string;
  terminal: RuntimeInteractionTerminal;
  now: number;
}

export interface SettleConversationInteractionInput {
  interactionId: string;
  expectedRevision: number;
  terminal: RuntimeInteractionTerminal;
  now: number;
}

export interface InvalidateRuntimeInteractionInput {
  interactionId: string;
  reasonCode: RuntimeInteractionTerminalReasonCode;
  now: number;
  expectedRevision?: number;
}

/** One pending-index snapshot. Partial means at least one indexed detail could not be read or verified. */
export interface RuntimeInteractionPendingIndexRead {
  records: RuntimeInteractionRecord[];
  exhaustiveness: 'complete' | 'partial';
}

export interface RuntimeInteractionStore {
  createStaged(input: CreateRuntimeInteractionInput): Promise<RuntimeInteractionRecord>;
  anchor(
    interactionId: string,
    hostEpoch: string,
    cardRef: RuntimeInteractionCardRef,
    now: number,
    expectedRevision?: number,
  ): Promise<RuntimeInteractionRecord | null>;
  settle(input: SettleRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  claimSubmission(input: ClaimRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null>;
  completeSubmission(input: CompleteRuntimeInteractionSubmissionInput): Promise<RuntimeInteractionRecord | null>;
  settleConversation(input: SettleConversationInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidate(input: InvalidateRuntimeInteractionInput): Promise<RuntimeInteractionRecord | null>;
  invalidateByInvocation(
    invocationId: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  invalidateActiveFromOtherHostEpoch(
    hostEpoch: string,
    reasonCode: RuntimeInteractionTerminalReasonCode,
    now: number,
  ): Promise<RuntimeInteractionRecord[]>;
  get(interactionId: string): Promise<RuntimeInteractionRecord | null>;
  listActive(): Promise<RuntimeInteractionRecord[]>;
  readPendingIndexByUser(userId: string): Promise<RuntimeInteractionPendingIndexRead>;
  listPendingByUser(userId: string): Promise<RuntimeInteractionRecord[]>;
  /** Canonical decision read; bounded derived-index preparation may occur. No decision/payload writes. */
  listSettledPage?(
    owner: string,
    options: SettledHistoryPageOptions,
  ): SettledHistorySourcePage<RuntimeInteractionRecord> | Promise<SettledHistorySourcePage<RuntimeInteractionRecord>>;
  listSettledByUser?(userId: string, limit: number): Promise<RuntimeInteractionRecord[]>;
}

/** Legacy list-only sources can expose known rows, but cannot prove that their pending index was read exhaustively. */
export type RuntimeInteractionPendingReadSource = Pick<RuntimeInteractionStore, 'listPendingByUser'> &
  Partial<Pick<RuntimeInteractionStore, 'readPendingIndexByUser'>>;
