import type {
  CatId,
  DeferredPersonMemoryReceipt,
  DeferredPersonMemoryResolvedSource,
  DeferredWriteOpportunityReceiptV1,
  PersonMemorySourceRef,
  WriteOpportunityLineageV1,
} from '@cat-cafe/shared';

export interface StageDeferredPersonMemoryReceiptInput {
  receiptId: DeferredPersonMemoryReceipt['receiptId'];
  ownerUserId: string;
  requesterCatId: CatId;
  invocationId: string;
  originMessageRef: PersonMemorySourceRef;
  subject: string;
  normalizedSubject: string;
  registryBinding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>;
  sourceCoordinates: DeferredPersonMemoryResolvedSource[];
  sourceBundleDigest: string;
  dedupeHash: string;
  ready: boolean;
  createdAt: number;
  /**
   * Wave 2 bridge: content-free identity of the Standing Reflex write opportunity whose bounded
   * judgment produced this defer. Optional, so the ordinary F276 defer path is unchanged.
   */
  writeOpportunityLineage?: WriteOpportunityLineageV1;
  writeOpportunityReceipt?: DeferredWriteOpportunityReceiptV1;
}

export type StageDeferredPersonMemoryReceiptResult =
  | { outcome: 'created' | 'replayed' | 'deduped' | 'confirmed'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'already_proposed'; proposalId: string }
  | { outcome: 'conflict' };

export type ClaimDeferredPersonMemoryReceiptResult =
  | { outcome: 'claimed'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'claimed_elsewhere' | 'not_available' };

export type BindDeferredPersonMemoryProcessingResult =
  | { outcome: 'bound' | 'replayed'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'conflict' | 'not_available' };

export type RearmDeferredPersonMemoryReceiptResult =
  | { outcome: 'rearmed'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'conflict' }
  | { outcome: 'not_available' };

export type WithdrawDeferredPersonMemoryReceiptResult =
  | { outcome: 'withdrawn' | 'replayed'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'conflict' | 'not_available' };

export type HardForgetDeferredPersonMemoryReceiptResult =
  | { outcome: 'purged' | 'already_absent' }
  | { outcome: 'proposal_bound'; proposalId: string };

export type DisposeDeferredPersonMemoryReceiptResult =
  | { outcome: 'awaiting_confirmation'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'not_actionable'; receipt: DeferredPersonMemoryReceipt }
  | { outcome: 'conflict' }
  | { outcome: 'not_available' };

export interface DeferredPersonMemoryReceiptStore {
  stage(input: StageDeferredPersonMemoryReceiptInput): Promise<StageDeferredPersonMemoryReceiptResult>;
  get(ownerUserId: string, receiptId: string): Promise<DeferredPersonMemoryReceipt | null>;
  listReady(ownerUserId: string, limit: number, now?: number): Promise<DeferredPersonMemoryReceipt[]>;
  claim(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    now: number;
    leaseMs: number;
    processorCatId: CatId;
    processingThreadId: string;
  }): Promise<ClaimDeferredPersonMemoryReceiptResult>;
  bindProcessingMessage(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processingMessageId: string;
    now: number;
  }): Promise<BindDeferredPersonMemoryProcessingResult>;
  bindProcessorInvocation(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processingMessageId: string;
    processorInvocationId: string;
    now: number;
  }): Promise<BindDeferredPersonMemoryProcessingResult>;
  release(ownerUserId: string, receiptId: string, claimId: string, now: number): Promise<boolean>;
  rearmWriteOpportunity(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processorInvocationId: string;
    dedupeHash: string;
    writeOpportunityLineage: WriteOpportunityLineageV1;
    writeOpportunityReceipt: DeferredWriteOpportunityReceiptV1;
    now: number;
  }): Promise<RearmDeferredPersonMemoryReceiptResult>;
  disposeClaim(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    processorCatId: CatId;
    processingThreadId: string;
    processorInvocationId: string;
    disposition: 'awaiting_confirmation' | 'insufficient_evidence';
    now: number;
  }): Promise<DisposeDeferredPersonMemoryReceiptResult>;
  expireClaim(input: {
    ownerUserId: string;
    receiptId: string;
    claimId: string;
    now: number;
  }): Promise<DisposeDeferredPersonMemoryReceiptResult>;
  withdraw(
    ownerUserId: string,
    receiptId: string,
    decidedAt: number,
  ): Promise<WithdrawDeferredPersonMemoryReceiptResult>;
  hardForget(ownerUserId: string, receiptId: string): Promise<HardForgetDeferredPersonMemoryReceiptResult>;
}
