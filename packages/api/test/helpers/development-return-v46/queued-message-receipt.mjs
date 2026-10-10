// Frozen test-only projection dependency from public main 3e70e1d6805be24672e8f841861f180d20b184c2.
// Type annotations erased; projection functions unchanged. No production reader or writer.
function latestExposure(custody, catId, invocationId) {
  let latest;
  for (const exposure of custody.bodyExposures ?? []) {
    if (exposure.targetCatId !== catId) continue;
    if (invocationId !== undefined && exposure.invocationId !== invocationId) continue;
    // Exposure history is append-only. When two reads share one millisecond,
    // the later appended child is the deterministic successor.
    if (!latest || exposure.seenAt >= latest.seenAt) latest = exposure;
  }
  return latest;
}
function targetAttempts(custody, catId) {
  const attempts = (custody.targetAttempts ?? [])
    .filter((attempt) => attempt.targetCatId === catId)
    .sort((left, right) => left.sequence - right.sequence)
    .map((attempt) => ({ ...attempt }));
  return attempts.length > 0 ? { attempts } : {};
}
function latestTargetAttempt(custody, catId) {
  return (custody.targetAttempts ?? [])
    .filter((attempt) => attempt.targetCatId === catId)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
}
function projectQueueReceiptTarget(custody, catId, state) {
  const outcome = custody.targetOutcomeByCatId?.[catId];
  const authorIntent = custody.authorIntentByCatId?.[catId];
  const authorIntentProjection = authorIntent
    ? {
        authorIntent: {
          ...authorIntent,
          effective: authorIntent.fallbackAt === undefined ? authorIntent.requested : 'next_work',
        },
      }
    : {};
  const attemptsProjection = targetAttempts(custody, catId);
  if (state.handled.has(catId)) {
    const exposure = outcome ? latestExposure(custody, catId, outcome.invocationId) : undefined;
    return {
      catId,
      state: 'handled',
      ...authorIntentProjection,
      ...attemptsProjection,
      ...(exposure ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt } : {}),
      ...(outcome ? { outcome } : {}),
    };
  }
  if (state.withdrawn.has(catId)) {
    const exposure = latestExposure(custody, catId);
    const actionSuccessorRetired = custody.actionSuccessorTerminalFenceByTargetCatId?.[catId] !== undefined;
    return {
      catId,
      state: 'withdrawn',
      ...authorIntentProjection,
      ...attemptsProjection,
      ...(actionSuccessorRetired ? { retryable: false } : {}),
      withdrawnAt: custody.withdrawnAtByCatId?.[catId],
      ...(exposure ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.steering[catId]) {
    const exposure = latestExposure(custody, catId, state.steering[catId]);
    return {
      catId,
      state: 'steering',
      ...authorIntentProjection,
      ...attemptsProjection,
      invocationId: state.steering[catId],
      ...(exposure ? { seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.steeringRequested.has(catId))
    return { catId, state: 'steering', ...authorIntentProjection, ...attemptsProjection };
  if (state.failed.has(catId)) {
    const exposure = latestExposure(custody, catId);
    const awakenedInvocationId = custody.awakenedInvocationIdByCatId?.[catId];
    const awakenedAt = custody.awakenedAtByCatId?.[catId];
    const interruptedAttempt = latestTargetAttempt(custody, catId);
    const interrupted = interruptedAttempt?.state === 'interrupted';
    const retryable = !custody.carrierByTargetCatId || custody.carrierByTargetCatId[catId] !== undefined;
    return {
      catId,
      state: interrupted ? 'interrupted' : 'failed',
      ...authorIntentProjection,
      ...attemptsProjection,
      ...(interrupted || retryable ? {} : { retryable: false }),
      ...(exposure
        ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt }
        : interruptedAttempt?.invocationId
          ? { invocationId: interruptedAttempt.invocationId }
          : awakenedInvocationId
            ? { invocationId: awakenedInvocationId, ...(awakenedAt !== undefined ? { awakenedAt } : {}) }
            : {}),
    };
  }
  if (state.seen.has(catId)) {
    const invocationId = custody.seenInvocationIdByCatId[catId];
    const exposure = invocationId ? latestExposure(custody, catId, invocationId) : latestExposure(custody, catId);
    return {
      catId,
      state: 'seen',
      ...authorIntentProjection,
      ...attemptsProjection,
      ...(invocationId ? { invocationId } : exposure ? { invocationId: exposure.invocationId } : {}),
      ...(exposure ? { seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.awakened[catId]) {
    const awakenedAt = custody.awakenedAtByCatId?.[catId];
    return {
      catId,
      state: 'awakened',
      ...authorIntentProjection,
      ...attemptsProjection,
      invocationId: state.awakened[catId],
      ...(awakenedAt !== undefined ? { awakenedAt } : {}),
    };
  }
  if (state.notified.has(catId)) return { catId, state: 'notified', ...authorIntentProjection, ...attemptsProjection };
  return { catId, state: 'queued', ...authorIntentProjection, ...attemptsProjection };
}
export function projectQueueReceipt(custody) {
  const state = {
    handled: new Set(custody.handledByCatIds),
    withdrawn: new Set(custody.withdrawnByCatIds ?? []),
    steering: custody.steeredInvocationIdByCatId ?? {},
    steeringRequested: new Set(custody.steerRequestedByCatIds ?? []),
    failed: new Set(custody.failedByCatIds),
    seen: new Set(custody.seenByCatIds),
    awakened: custody.awakenedInvocationIdByCatId ?? {},
    notified: new Set(custody.notifiedByCatIds),
  };
  return {
    version: 1,
    entryId: custody.entryId,
    ...(custody.receiptScope ? { scope: custody.receiptScope } : {}),
    targets: custody.allTargetCats.map((catId) => projectQueueReceiptTarget(custody, catId, state)),
    reminderAttempts: (custody.reminderAttempts ?? []).map((attempt) => ({ ...attempt })),
  };
}
