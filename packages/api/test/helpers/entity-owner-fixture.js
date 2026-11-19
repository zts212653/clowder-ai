export function entityOwnerFixture(store, revision) {
  const project = (entity) => ({ ...entity, revision: revision(entity) });
  return {
    list: async () => store.list().map(project),
    get: async (_owner, entityId) => {
      const entry = store.get(entityId);
      return entry ? project(entry) : null;
    },
    evidence: async (owner, entityId, requestId) => store.getOwnerActionEvidence(entityId, owner, requestId),
    mutate: async (ownerUserId, entityId, command, updatedAt) => {
      const input = { ownerUserId, entityId, requestId: command.requestId, expectedRevision: command.expectedRevision, updatedAt };
      try {
        const result = command.action === 'correct'
          ? store.correct({ ...input, patch: command.patch })
          : command.action === 'retire' ? store.retire(input) : store.hardForget(input);
        return result.outcome === 'applied' ? { ...result, entity: project(result.entity) } : result;
      } catch (error) {
        if (error instanceof Error && error.name === 'EntitySurfaceConflictError') return { outcome: 'conflict' };
        throw error;
      }
    },
  };
}
