export function makeQueuedMessageCustody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-1',
    revision: 1,
    intent: 'implement',
    status: 'queued',
    allTargetCats: ['opus', 'codex'],
    pendingTargetCats: ['opus', 'codex'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}
