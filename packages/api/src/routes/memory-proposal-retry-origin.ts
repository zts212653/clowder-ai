import { isDeepStrictEqual } from 'node:util';
import type { ApprovalOriginRef, ApprovalPublication } from '@cat-cafe/shared';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import { ApprovalOriginValidationError } from '../domains/approval-hub/ApprovalOriginValidationError.js';

/** A retry may recover the saved origin but must never substitute its new invocation's source. */
export async function readMemoryProposalRetryOrigin(
  ingress: ApprovalIngress,
  producerId: 'F260' | 'F321',
  proposal: {
    ownerUserId: string;
    sourceThreadId: string;
    approvalOriginRef?: ApprovalOriginRef;
    publication?: ApprovalPublication;
  },
): Promise<ApprovalOriginRef | null> {
  const origin = proposal.approvalOriginRef;
  if (!origin || (origin.threadId !== undefined && origin.threadId !== proposal.sourceThreadId)) return null;
  if (proposal.publication?.state === 'anchored' && !isDeepStrictEqual(origin, proposal.publication.envelope.originRef))
    return null;
  try {
    // Reuse the catalogued system-wake and event-origin policies from initial publication.
    await ingress.validateOrigin({ producerId, ownerUserId: proposal.ownerUserId, originRef: origin });
    return origin;
  } catch (error) {
    if (error instanceof ApprovalOriginValidationError) return null;
    // A transient read failure or programming error must preserve a retryable failure, not reject the origin.
    throw error;
  }
}
