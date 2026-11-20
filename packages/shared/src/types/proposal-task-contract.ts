/** Server-owned approval binding; appended to the original proposal, never a second permission ledger. */
export interface ApprovedTaskContractV1 {
  v: 1;
  digest: string;
}

export interface TaskContractContinuationV1 {
  v: 1;
  receiptId: string;
  proposalId: string;
  taskId: string;
  taskTitle: string;
  ownerCatId: string;
  ownerThreadId: string;
  userId: string;
  childThreadId: string;
  targetCatIds: string[];
  contractDigest: string;
  approvalContractKind: 'legacy' | 'frozen';
  /** Present only for the approval ingress, which has no home callback invocation. */
  approval?: { ownerRevision: number; previousHandoffMessageRef: string | null };
  clientRequestId: string;
  issuedAt: number;
}
