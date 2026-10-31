/** F264: bind an explicit single-message choice to its exact live parent. Defaults are snapshotted by common Queue admission. */

import {
  type CatId,
  type FreshnessCarrierCapability,
  type MessageWorkDisposition,
  type QueueAuthorIntent,
  supportsActiveInvocationGuidance,
} from '@cat-cafe/shared';
import {
  MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
  resolveMessageDispositionPreference,
} from '../config/user-preferences-store.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';

type ExactParentTracker = Pick<InvocationTracker, 'has' | 'getUserId' | 'getExecutionId'>;

const UNDECLARED_CARRIER_CAPABILITY: FreshnessCarrierCapability = {
  provider: 'other',
  carrier: 'other',
  deliverySemantics: 'undeclared',
  activeInvocationGuidance: 'undeclared',
};

type FreshnessCapabilityOwner = {
  freshnessCarrierCapability?: (catId: CatId) => FreshnessCarrierCapability | undefined;
};

/** Runtime composition boundary: missing declarations stay data, never become a route crash. */
export function resolveFreshnessCarrierCapabilityOrUndeclared(
  owner: FreshnessCapabilityOwner,
  catId: CatId,
): FreshnessCarrierCapability {
  const resolver = owner.freshnessCarrierCapability;
  return (typeof resolver === 'function' ? resolver.call(owner, catId) : undefined) ?? UNDECLARED_CARRIER_CAPABILITY;
}

export function resolveMessageDispositionForAdmission(input: {
  explicit?: MessageWorkDisposition;
  projectRoot?: string;
  threadId: string;
}): MessageWorkDisposition {
  if (input.explicit) return input.explicit;
  if (!input.projectRoot) return MESSAGE_DISPOSITION_PRODUCT_DEFAULT;
  return resolveMessageDispositionPreference(input.projectRoot, input.threadId).effective;
}

export interface QueueAdmissionPolicyContext {
  projectRoot?: string;
  resolveTargets?: (
    requested: readonly string[],
    threadId: string,
    content?: string,
    exact?: boolean,
  ) => Promise<string[]>;
  onAdmitted?: (admission: {
    threadId: string;
    entries: readonly import('../domains/cats/services/agents/invocation/InvocationQueue.js').QueueEntry[];
    message?: import('../domains/cats/services/stores/ports/MessageStore.js').StoredMessage;
  }) => void;
  invocationTracker?: ExactParentTracker;
  resolveCarrierCapability?: (catId: CatId) => FreshnessCarrierCapability | undefined;
}

export function resolveQueueAuthorIntentByCatId(input: {
  targetCats: readonly CatId[];
  requested: MessageWorkDisposition;
  threadId: string;
  userId: string;
  invocationTracker?: ExactParentTracker;
  resolveCarrierCapability?: (catId: CatId) => FreshnessCarrierCapability | undefined;
  now?: number;
}): Record<string, QueueAuthorIntent> {
  const now = input.now ?? Date.now();
  return Object.fromEntries(
    input.targetCats.map((catId) => {
      const carrierCapability = input.resolveCarrierCapability?.(catId) ?? UNDECLARED_CARRIER_CAPABILITY;
      if (input.requested === 'next_work') {
        return [catId, { requested: 'next_work', carrierCapability } satisfies QueueAuthorIntent];
      }
      if (!supportsActiveInvocationGuidance(carrierCapability)) {
        return [
          catId,
          {
            requested: 'continue_current',
            carrierCapability,
            fallbackAt: now,
            fallbackReason:
              carrierCapability.activeInvocationGuidance === 'undeclared'
                ? 'carrier_capability_undeclared'
                : 'unsupported_carrier',
          } satisfies QueueAuthorIntent,
        ];
      }
      const tracker = input.invocationTracker;
      const boundParentInvocationId =
        tracker?.has(input.threadId, catId) && tracker.getUserId(input.threadId, catId) === input.userId
          ? tracker.getExecutionId(input.threadId, catId)
          : undefined;
      return boundParentInvocationId
        ? [
            catId,
            { requested: 'continue_current', boundParentInvocationId, carrierCapability } satisfies QueueAuthorIntent,
          ]
        : [
            catId,
            {
              requested: 'continue_current',
              carrierCapability,
              fallbackAt: now,
              fallbackReason: 'no_active_parent',
            } satisfies QueueAuthorIntent,
          ];
    }),
  );
}
