/**
 * Read-only context capacity projections for config/Hub surfaces.
 * Runtime routing resolves an invocation-owned snapshot with the concrete carrier;
 * this module deliberately exposes no prompt-policy knobs.
 */

import { catRegistry } from '@cat-cafe/shared';
import { getAllCatIdsFromConfig } from './cat-config-loader.js';
import { getCatModel } from './cat-models.js';
import { type ResolvedContextCapacity, resolveContextCapacity } from './context-capacity.js';

export type CatCapacityProjection = Pick<
  ResolvedContextCapacity,
  'windowTokens' | 'inputCeilingTokens' | 'source' | 'actionable' | 'provenance'
>;

export function getCatCapacity(catName: string): CatCapacityProjection {
  const config = catRegistry.tryGet(catName)?.config;
  return resolveContextCapacity({
    catId: catName,
    model: config ? getCatModel(catName) : undefined,
  });
}

export function getAllCatCapacities(): Record<string, CatCapacityProjection> {
  const result: Record<string, CatCapacityProjection> = {};
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) result[catName] = getCatCapacity(catName);
  return result;
}

export function clearBudgetCache(): void {
  // Compatibility test seam: capacity is derived on demand and has no cache.
}
