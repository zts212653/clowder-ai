/**
 * F208 Phase E: Redis key patterns for dossier distillation proposals.
 *
 * AC-E1: DossierDistillationProposal stored in Redis (TTL=0, Iron Rule #5).
 * KD-17: sourceId-based idempotency index.
 *
 * Pattern follows project convention (idx+detail separation):
 *   detail hash + sorted set indices (per DossierObservationKeys / ProfileUpdateProposalKeys).
 *
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const DistillationProposalKeys = {
  /** Hash with all proposal fields: distillation:{proposalId} */
  detail: (proposalId: string) => `distillation:${proposalId}`,

  /** Sorted set of all pending proposals (score=createdAt): distillation:pending */
  pendingIndex: () => 'distillation:pending',

  /** Per-cat sorted set (all statuses, score=createdAt): distillation:cat:{catId} */
  catIndex: (catId: string) => `distillation:cat:${catId}`,

  /** sourceId → proposalId lookup (idempotency): distillation:source:{sourceId} */
  sourceIndex: (sourceId: string) => `distillation:source:${sourceId}`,
} as const;
