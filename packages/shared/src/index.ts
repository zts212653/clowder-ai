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
// Export shared CLI effort helpers
export * from './cli-effort.js';
// Export command parser + core commands (F142 Phase B)
export { parseCommand } from './command-parser.js';
export { CORE_COMMANDS } from './core-commands.js';
// Export registry (CatRegistry, catIdSchema, assertKnownCatId)
export * from './registry/index.js';
// Export all schemas
export * from './schemas/index.js';
// Export shared text helpers
export * from './text-utils.js';
// Export all types
export * from './types/index.js';
// Export subject key utilities (#320)
export * from './utils/subject-key.js';
