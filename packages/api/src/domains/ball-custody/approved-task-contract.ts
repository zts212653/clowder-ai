import { createHash } from 'node:crypto';
import type { ApprovedTaskContractV1, TaskContractContinuationV1, ThreadProposal } from '@cat-cafe/shared';
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const approvedTaskContractSchema = z.object({ v: z.literal(1), digest }).strict();
export const taskContractContinuationSchema = z
  .object({
    v: z.literal(1),
    receiptId: z.string().min(1),
    proposalId: z.string().min(1),
    taskId: z.string().min(1),
    taskTitle: z.string().trim().min(1),
    ownerCatId: z.string().min(1),
    ownerThreadId: z.string().min(1),
    userId: z.string().min(1),
    childThreadId: z.string().min(1),
    targetCatIds: z.array(z.string().min(1)).min(1),
    contractDigest: digest,
    approvalContractKind: z.enum(['legacy', 'frozen']),
    clientRequestId: z.string().min(1).max(200),
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();

/** Object keys are sorted; arrays retain approval order. Missing and explicit values remain distinct. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export type CompleteProposalContract = Omit<
  Pick<
    ThreadProposal,
    | 'proposalId'
    | 'title'
    | 'reason'
    | 'initialMessage'
    | 'subjectTaskId'
    | 'subjectTaskTitle'
    | 'sourceThreadId'
    | 'sourceCatId'
    | 'sourceInvocationId'
    | 'sourceMessageId'
    | 'parentThreadId'
    | 'projectPath'
    | 'declaredWorkMode'
    | 'reportingMode'
    | 'preferredCats'
    | 'createdThreadId'
    | 'createdBy'
    | 'createdAt'
    | 'approvedBy'
    | 'approvedAt'
    | 'publication'
    | 'cardMessageId'
    | 'approvedDevelopmentScope'
    | 'approvalContractInvalid'
  >,
  'sourceCatId' | 'preferredCats'
> & {
  sourceCatId: string;
  preferredCats: ReadonlyArray<string>;
};

/** No caller-supplied digest or scope. Approval metadata and the exact published envelope are bound too. */
export function deriveApprovedTaskContract(proposal: Partial<CompleteProposalContract>): ApprovedTaskContractV1 | null {
  if (
    proposal.approvalContractInvalid ||
    proposal.approvedDevelopmentScope ||
    !proposal.subjectTaskId ||
    !proposal.subjectTaskTitle?.trim() ||
    !proposal.initialMessage?.trim() ||
    !proposal.title?.trim() ||
    !proposal.reason?.trim() ||
    !proposal.preferredCats?.length ||
    !proposal.createdThreadId ||
    !proposal.approvedBy ||
    !Number.isFinite(proposal.createdAt) ||
    !Number.isFinite(proposal.approvedAt)
  )
    return null;
  const fields: Partial<CompleteProposalContract> = {
    proposalId: proposal.proposalId,
    title: proposal.title,
    reason: proposal.reason,
    initialMessage: proposal.initialMessage,
    subjectTaskId: proposal.subjectTaskId,
    subjectTaskTitle: proposal.subjectTaskTitle,
    sourceThreadId: proposal.sourceThreadId,
    sourceCatId: proposal.sourceCatId,
    sourceInvocationId: proposal.sourceInvocationId,
    sourceMessageId: proposal.sourceMessageId,
    parentThreadId: proposal.parentThreadId,
    projectPath: proposal.projectPath,
    declaredWorkMode: proposal.declaredWorkMode,
    reportingMode: proposal.reportingMode,
    preferredCats: proposal.preferredCats,
    createdThreadId: proposal.createdThreadId,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
    approvedBy: proposal.approvedBy,
    approvedAt: proposal.approvedAt,
    publication: proposal.publication,
    cardMessageId: proposal.cardMessageId,
  };
  return { v: 1, digest: createHash('sha256').update(canonicalJson(fields)).digest('hex') };
}

/** Called only while finalizing a new approval, after approval-time overrides. */
export function freezeApprovedTaskContract(proposal: ThreadProposal): void {
  if (!proposal.subjectTaskId || proposal.approvedDevelopmentScope) return;
  const contract = deriveApprovedTaskContract(proposal);
  if (!contract)
    throw new Error('Generic Task approval requires a task title, complete initial message and execution targets');
  proposal.approvedTaskContract = contract;
}

export function continuationEvidenceRef(receipt: TaskContractContinuationV1): string {
  return `proposal:${receipt.proposalId}:continuation:${receipt.receiptId}:${receipt.contractDigest}`;
}
