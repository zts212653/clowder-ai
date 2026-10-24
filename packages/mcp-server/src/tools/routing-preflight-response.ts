import { routingPreflightDecisionV1Schema, routingQueueAdmissionReceiptV1Schema } from '@cat-cafe/shared';

/** Keep the send acknowledgement concise; the API decision remains canonical. */
export function projectRoutingCallbackResponse(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  const admission = routingQueueAdmissionReceiptV1Schema.safeParse(response.routing_admission);
  if (admission.success) {
    const receipt = admission.data;
    if (
      !receipt.snapshotRef ||
      receipt.targets.some(
        (target) =>
          target.availabilityObservation !== 'available' ||
          target.reasons.some((reason) => reason.code !== 'routing_signal_recovered'),
      )
    )
      return value;
    // B only acknowledges durable admission; recovery/future execution authority remains outside B.
    return {
      ...response,
      routing_admission: {
        stage: receipt.stage,
        executionPreflight: receipt.executionPreflight,
        snapshotRef: receipt.snapshotRef,
        targets: receipt.targets.map((target) => target.targetCatId),
      },
    };
  }
  const parsed = routingPreflightDecisionV1Schema.safeParse(response.routing_preflight);
  if (!parsed.success) return value;
  const decision = parsed.data;
  if (
    decision.resolverState !== 'fresh' ||
    !decision.snapshotRef ||
    decision.targets.some(
      (target) =>
        target.disposition !== 'allowed' || target.reasons.some((reason) => reason.code !== 'routing_signal_recovered'),
    )
  )
    return value;

  return {
    ...response,
    routing_preflight: {
      snapshotRef: decision.snapshotRef,
      targets: decision.targets.map(({ targetCatId, disposition, reasons }) => ({
        targetCatId,
        disposition,
        reasons,
      })),
    },
  };
}
