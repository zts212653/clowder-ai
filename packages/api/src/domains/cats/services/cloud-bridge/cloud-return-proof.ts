import type { CloudBridgeReturnV1 } from '@cat-cafe/shared';
import type { CloudReturnGrantClaims } from './cloud-return-grant.js';

/** Call only after the existing grant claim or legacy signature has been verified. */
export function cloudReturnProof(claim: CloudReturnGrantClaims): CloudBridgeReturnV1 {
  return {
    v: 1,
    threadId: claim.threadId,
    sourceMessageId: claim.sourceMessageId,
    targetCatId: claim.targetCatId,
    dispatchInvocationId: claim.dispatchInvocationId,
  };
}
