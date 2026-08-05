/** F264: resolve scoped author preference and bind current-work intent to an exact live parent. */

import type { CatId, FreshnessCarrierCapability, MessageWorkDisposition, QueueAuthorIntent } from '@cat-cafe/shared';
import { resolveMessageDispositionPreference } from '../config/user-preferences-store.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';

type ExactParentTracker = Pick<InvocationTracker, 'has' | 'getUserId' | 'getExecutionId'>;

const UNDECLARED_CARRIER_CAPABILITY: FreshnessCarrierCapability = {
  provider: 'other',
  carrier: 'other',
  deliverySemantics: 'undeclared',
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
  if (!input.projectRoot) return 'next_work';
  return resolveMessageDispositionPreference(input.projectRoot, input.threadId).effective;
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
      if (carrierCapability.deliverySemantics !== 'exact_active_turn') {
        return [
          catId,
          {
            requested: 'continue_current',
            carrierCapability,
            fallbackAt: now,
            fallbackReason:
              carrierCapability.deliverySemantics === 'undeclared'
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
