import { createCatId } from '@cat-cafe/shared';
import type { FastifyBaseLogger } from 'fastify';
import {
  computeDispatchCanonicalActionKey,
  computeLegacyNegativeAuthorizationKey,
  computeNegativeAuthorizationKey,
  type IDispatchProposalStore,
} from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import type { OrdinaryTaskHandoffRequest } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { DispatchProposalKeys } from '../domains/cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import { preflightNegativeAuthorizationFence } from './callback-negative-authorization-fence.js';

function taskAction(request: OrdinaryTaskHandoffRequest) {
  return {
    subjectRef: `subject:task:${request.taskId}`,
    actionFamily: 'implement' as const,
    successorSlot: 'implementer' as const,
    mode: 'single' as const,
    terminalPredicate: { kind: 'task_done' as const },
  };
}

/** Same deny-only approval owner at submission, recovered application and actual provider admission. */
export function taskHandoffDispatchAuthority(store: IDispatchProposalStore, log: FastifyBaseLogger) {
  return {
    keys(request: OrdinaryTaskHandoffRequest, proposalSourceInvocationId?: string): string[] {
      const a = request.issuer;
      const origin = 'invocationId' in a ? a.invocationId : proposalSourceInvocationId;
      return [
        DispatchProposalKeys.canonicalAdmissionAction(computeDispatchCanonicalActionKey(a.userId, taskAction(request))),
        ...(origin
          ? [
              DispatchProposalKeys.negativeAuthorization(
                computeNegativeAuthorizationKey(a.userId, origin, request.targetThreadId, request.targetCatId),
              ),
            ]
          : []),
        DispatchProposalKeys.legacyNegativeAuthorization(
          computeLegacyNegativeAuthorizationKey(
            a.userId,
            a.threadId,
            a.catId,
            request.targetThreadId,
            request.targetCatId,
          ),
        ),
        DispatchProposalKeys.negativeAuthorizationLegacyCutover,
      ];
    },
    async assertCurrent(source: StoredMessage, request: OrdinaryTaskHandoffRequest): Promise<void> {
      const actor = request.issuer;
      const origin = 'invocationId' in actor ? actor.invocationId : source.extra?.crossPost?.sourceInvocationId;
      if (!origin) throw new OrdinaryTaskHandoffError('task_dispatch_authorization_unavailable');
      const denied = await preflightNegativeAuthorizationFence({
        content: source.content,
        isCrossThread: actor.threadId !== request.targetThreadId,
        effectClass: 'coordinate',
        senderCatId: createCatId(actor.catId),
        sourceThreadId: actor.threadId,
        sourceInvocationId: origin,
        sourceInvocationCreatedAt: request.issuerCreatedAt ?? source.timestamp,
        targetThreadId: request.targetThreadId,
        ownerUserId: actor.userId,
        explicitTargetCats: [request.targetCatId],
        action: taskAction(request),
        suppressRouting: false,
        dispatchProposalStore: store,
        log,
      });
      if (denied) throw new OrdinaryTaskHandoffError('task_dispatch_authorization_blocked');
    },
  };
}
