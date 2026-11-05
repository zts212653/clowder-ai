/** Original status endpoints are commit receipts, not pending-list absence. Keep their existing domain contracts. */
export function producerCommittedEffect(
  value: unknown,
  feature: string,
  proposalId: string,
  originalSession?: unknown,
) {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const nested = feature === 'F225' ? body?.proposal : body;
  const record = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : null;
  if (record?.proposalId !== proposalId || record.status !== 'approved') return null;
  // F221 finalizes approved after the durable vignette; its public GET intentionally returns only id/status.
  if (feature === 'F221') return 'taste-written' as const;
  // F231 finalizes approved after the original filesystem and provenance commit. GET likewise omits paths.
  if (feature === 'F231') return 'profile-written' as const;
  // Handoff's original reader also binds the sealed source session; do not weaken that correlation.
  return feature === 'F225' &&
    typeof originalSession === 'string' &&
    !!originalSession &&
    record.sealedSessionId === originalSession
    ? ('handoff-started' as const)
    : null;
}
