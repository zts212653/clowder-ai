import type { RouteOptions } from './route-helpers.js';

/** Only authenticated human ingress can choose a real attempt despite automatic supply advice. */
export function isRoutingOwnerAttempt(options: RouteOptions): boolean {
  if (options.ownerAuthProvenance !== 'strict' || options.a2aTriggerMessageId || options.a2aCallerCatId) return false;
  return (
    options.humanDispositionInvocationOrigin === 'direct_owner' ||
    (options.humanDispositionInvocationOrigin === 'queue_replay' && options.routingQueueSource === 'user')
  );
}
