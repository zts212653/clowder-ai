import {
  routingPreflightDecisionV1Schema,
  routingQueueAdmissionReceiptV1Schema,
  type SessionCacheWarmth,
} from '@cat-cafe/shared';

function sessionCacheReceipt(
  observedAt: number,
  stage: 'queue_admitted' | 'execution_preflight',
  targets: readonly { targetCatId: string; cacheWarmth?: SessionCacheWarmth }[],
) {
  const facts = targets.flatMap((target) =>
    target.cacheWarmth ? [{ targetCatId: target.targetCatId, warmth: target.cacheWarmth }] : [],
  );
  return facts.length ? { session_cache: { observedAt, stage, targets: facts } } : {};
}

/** Selection facts belong before selection. A send acknowledgement is not another decision surface. */
export function projectRoutingCallbackResponse(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  let response = value as Record<string, unknown>;
  const admission = routingQueueAdmissionReceiptV1Schema.safeParse(response.routing_admission);
  if (admission.success) {
    // B is retained on the Queue, not repeated to the sender after admission already succeeded.
    const { routing_admission: _admission, ...acknowledgement } = response;
    response = {
      ...acknowledgement,
      ...sessionCacheReceipt(admission.data.observedAt, 'queue_admitted', admission.data.targets),
    };
  }
  const parsed = routingPreflightDecisionV1Schema.safeParse(response.routing_preflight);
  if (!parsed.success) return response;
  const decision = parsed.data;
  const blocked = decision.targets.filter((target) => target.disposition === 'rejected');
  if (blocked.length === 0) {
    const { routing_preflight: _preflight, ...acknowledgement } = response;
    return { ...acknowledgement, ...sessionCacheReceipt(decision.observedAt, 'execution_preflight', decision.targets) };
  }
  return {
    ...response,
    ...sessionCacheReceipt(decision.observedAt, 'execution_preflight', decision.targets),
    routing_preflight: { ...decision, targets: blocked },
  };
}
