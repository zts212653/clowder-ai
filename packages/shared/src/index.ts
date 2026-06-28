/**
 * @cat-cafe/shared
 * 共享类型和 schemas
 *
 * Note: Redis utils are NOT exported from root to avoid pulling
 * Node-only dependencies into frontend bundles.
 * Import from '@cat-cafe/shared/utils' instead.
 */

// Export avatar size limits (shared between API route bodyLimit and frontend size gate)
export * from './avatar-limits.js';
// Export capability tips contract (F244 waiting-state Knowledge Feed projection)
export * from './capability-tips.js';
// Export shared CLI effort helpers
export * from './cli-effort.js';
// Export command parser + core commands (F142 Phase B)
export { parseCommand } from './command-parser.js';
export type { CodexPetState, PetStateProjection } from './concierge/pet-skin-projection.js';
// Export PetSkinContract projection (F229 Phase E0 + E1)
export {
  PET_STATE_PROJECTION_V0,
  PET_STATE_PROJECTION_V1,
  projectToPetState,
} from './concierge/pet-skin-projection.js';
export { CORE_COMMANDS } from './core-commands.js';
// Dossier profile parser: import from '@cat-cafe/shared/dossier' (F208 KD-10)
// NOT re-exported here — uses Node.js fs, same pattern as Redis utils.
// Export registry (CatRegistry, catIdSchema, assertKnownCatId)
export * from './registry/index.js';
// Export all schemas
export * from './schemas/index.js';
// Export shared source-code extension helpers (F232 artifact classification + preview)
export * from './source-code-extensions.js';
// Export shared text helpers
export * from './text-utils.js';
// Export all types
export * from './types/index.js';
// Export subject key utilities (#320)
export * from './utils/subject-key.js';
