import { routingPreflightDecisionV1Schema, routingQueueAdmissionReceiptV1Schema } from '@cat-cafe/shared';

/** Selection facts belong before selection. A send acknowledgement is not another decision surface. */
export function projectRoutingCallbackResponse(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  let response = value as Record<string, unknown>;
  const admission = routingQueueAdmissionReceiptV1Schema.safeParse(response.routing_admission);
  if (admission.success) {
    // B is retained on the Queue, not repeated to the sender after admission already succeeded.
    const { routing_admission: _admission, ...acknowledgement } = response;
    response = acknowledgement;
  }
  const parsed = routingPreflightDecisionV1Schema.safeParse(response.routing_preflight);
  if (!parsed.success) return response;
  const decision = parsed.data;
  const blocked = decision.targets.filter((target) => target.disposition === 'rejected');
  if (blocked.length === 0) {
    const { routing_preflight: _preflight, ...acknowledgement } = response;
    return acknowledgement;
  }
  return {
    ...response,
    routing_preflight: { ...decision, targets: blocked },
  };
}
