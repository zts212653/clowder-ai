/**
 * Registry exports
 */

export type { CatRegistryEntry } from './CatRegistry.js';
export {
  assertKnownCatId,
  CatRegistry,
  catRegistry,
} from './CatRegistry.js';

export { catIdSchema } from './cat-id-schema.js';

export { type NormalizeCatResult, normalizeCatId } from './normalize-cat-id.js';
