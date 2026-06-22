/**
 * F208 Phase D: Redis key patterns for operator dossier observation storage.
 *
 * AC-D1: operator observations stored in Redis pending layer (OQ-10: staging only,
 * promotion to summary layer in Phase E).
 *
 * Pattern follows project convention (idx+detail separation):
 *   detail hash + sorted set index (per TaskKeys / ProfileUpdateProposalKeys).
 *
 * All keys share the cat-cafe: prefix set by the Redis client.
 */

export const DossierObservationKeys = {
  /** Hash with observation fields: dossier-obs:{obsId} */
  detail: (id: string) => `dossier-obs:${id}`,

  /** Per-cat sorted set (score=timestamp): dossier-obs:cat:{catId} */
  catIndex: (catId: string) => `dossier-obs:cat:${catId}`,
} as const;
