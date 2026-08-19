import type {
  ApprovalPublication,
  ProfileUpdateProposal,
  ProfileUpdateProposalStatus,
  ProfileUpdateSignalProvenance,
} from '@cat-cafe/shared';
import { isAllowedCollectionSignal } from '@cat-cafe/shared';
import { hydrateApprovalPublication, serializeApprovalPublication } from './RedisApprovalPublication.js';

export function serializeProfileUpdateProposal(proposal: ProfileUpdateProposal): string[] {
  const fields = [
    'proposalId',
    proposal.proposalId,
    'status',
    proposal.status,
    'sourceThreadId',
    proposal.sourceThreadId,
    'sourceInvocationId',
    proposal.sourceInvocationId,
    'sourceCatId',
    proposal.sourceCatId,
    'targetLayer',
    proposal.targetLayer,
    'targetPath',
    proposal.targetPath,
    'beforeContent',
    proposal.beforeContent,
    'baseContentHash',
    proposal.baseContentHash,
    'afterContent',
    proposal.afterContent,
    'rationale',
    proposal.rationale,
    'signalProvenance',
    JSON.stringify(proposal.signalProvenance),
    'createdBy',
    proposal.createdBy,
    'createdAt',
    String(proposal.createdAt),
  ];
  if (proposal.cardMessageId) fields.push('cardMessageId', proposal.cardMessageId);
  if (proposal.publication) fields.push('publication', serializeApprovalPublication(proposal.publication));
  return fields;
}

export function hydrateProfileUpdateProposal(data: Record<string, string>): ProfileUpdateProposal {
  const proposal: ProfileUpdateProposal = {
    proposalId: requiredField(data, 'proposalId'),
    status: (data.status ?? 'pending') as ProfileUpdateProposalStatus,
    sourceThreadId: requiredField(data, 'sourceThreadId'),
    sourceInvocationId: requiredField(data, 'sourceInvocationId'),
    sourceCatId: requiredField(data, 'sourceCatId') as ProfileUpdateProposal['sourceCatId'],
    targetLayer: 'primer',
    targetPath: requiredField(data, 'targetPath'),
    beforeContent: data.beforeContent ?? '',
    baseContentHash: data.baseContentHash ?? '',
    afterContent: data.afterContent ?? '',
    rationale: data.rationale ?? '',
    signalProvenance: parseSignalProvenance(data.signalProvenance),
    createdBy: requiredField(data, 'createdBy'),
    createdAt: parseInt(requiredField(data, 'createdAt'), 10),
    ...approvalPublicationField(data.publication),
  };
  if (data.cardMessageId) proposal.cardMessageId = data.cardMessageId;
  if (data.approvedBy) proposal.approvedBy = data.approvedBy;
  if (data.approvedAt) proposal.approvedAt = parseInt(data.approvedAt, 10);
  const claimedAt = parseInt(data.claimedAt ?? '0', 10);
  if (claimedAt > 0) proposal.claimedAt = claimedAt;
  if (data.writtenPath) proposal.writtenPath = data.writtenPath;
  if (data.provenancePath) proposal.provenancePath = data.provenancePath;
  if (data.rejectedBy) proposal.rejectedBy = data.rejectedBy;
  if (data.rejectedAt) proposal.rejectedAt = parseInt(data.rejectedAt, 10);
  if (data.rejectionReason) proposal.rejectionReason = data.rejectionReason;
  return proposal;
}

function approvalPublicationField(encoded: string | undefined): { publication?: ApprovalPublication } {
  const publication = hydrateApprovalPublication(encoded);
  return publication ? { publication } : {};
}

function requiredField(data: Record<string, string>, field: string): string {
  const value = data[field];
  if (value === undefined) {
    throw new Error(`Malformed profile update proposal: missing ${field}`);
  }
  return value;
}

function parseSignalProvenance(raw: string | undefined): ProfileUpdateSignalProvenance {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return {
      kind: isAllowedCollectionSignal(parsed.kind) ? parsed.kind : 'cat-declared',
      sourceThreadId: typeof parsed.sourceThreadId === 'string' ? parsed.sourceThreadId : '',
      ...(typeof parsed.sourceMessageId === 'string' ? { sourceMessageId: parsed.sourceMessageId } : {}),
    };
  } catch {
    return { kind: 'cat-declared', sourceThreadId: '' };
  }
}
