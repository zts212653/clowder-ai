/**
 * F32-b P4d: Resolve breedId for a catName.
 * Reads from catRegistry (.cat-cafe/cat-catalog.json).
 */
import { catRegistry } from '@cat-cafe/shared';

export function resolveBreedId(catName: string): string | undefined {
  return catRegistry.tryGet(catName)?.config.breedId;
}
