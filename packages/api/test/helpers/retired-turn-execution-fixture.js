// Persist the pre-retirement wire format; current writers must continue to reject it.
export function retiredHash(id, overrides = {}) {
  const record = {
    invocationId: id,
    parentInvocationId: 'legacy-parent',
    threadId: 'legacy-thread',
    userId: 'owner',
    catId: 'codex-astra',
    executionKind: 'freshness_supplement',
    startedAt: 10,
    causal: { triggerMessageId: 'old-message', freshnessSupplementId: 'old-supplement' },
    ...overrides,
  };
  return {
    ...record,
    startedAt: String(record.startedAt),
    causal: JSON.stringify(record.causal),
    immutableIdentity: JSON.stringify(record),
    status: 'succeeded',
    endedAt: '20',
    // CREATE/TERMINAL Lua retain an empty field when success has no reason.
    terminalReason: '',
  };
}
