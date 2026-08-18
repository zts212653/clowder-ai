/**
 * @cat-cafe/shared
 * 共享类型和 schemas
 *
 * Note: Redis utils are NOT exported from root to avoid pulling
 * Node-only dependencies into frontend bundles.
 * Import from '@cat-cafe/shared/utils' instead.
 */

// F246 Phase I: shared Approval Hub producer metadata (API + Web single source).
export * from './approval-producer-catalog.js';
// Export avatar size limits (shared between API route bodyLimit and frontend size gate)
export * from './avatar-limits.js';
// Export capability tips telemetry pipeline schemas (F268)
export * from './capability-tip-telemetry.js';
// Export capability tips contract (F244 waiting-state Knowledge Feed projection)
export * from './capability-tips.js';
// Export shared CLI effort helpers
export * from './cli-effort.js';
export * from './cli-tool-label.js';
// F291: OAuth Codex Standard/Fast semantic contract
export * from './codex-speed.js';
// Export command parser + core commands (F142 Phase B)
export { parseCommand } from './command-parser.js';
export type {
  AutonomousPetState,
  CodexPetState,
  PetBehaviorOutput,
  PetStateProjection,
} from './concierge/pet-skin-projection.js';
// Export PetSkinContract projection (F229 Phase E0 + E1 + E4)
export {
  PET_STATE_PROJECTION_V0,
  PET_STATE_PROJECTION_V1,
  projectToPetState,
} from './concierge/pet-skin-projection.js';
export { CORE_COMMANDS } from './core-commands.js';
// Export Eval Hub metric reference normalization (F248 B3)
export * from './eval-metric-ref.js';
// First-party WebSocket Stop intent contract (API + Web single source).
export * from './explicit-stop-intent.js';
// Export shared text helpers
export * from './markdown-readable-text.js';
// Browser Preview Gateway request identity shared by API and Web.
export * from './preview-gateway.js';
// Export recall-result sidecar contract (producer → parser → persistence → UI)
export * from './recall-outcome.js';
// Dossier profile parser: import from '@cat-cafe/shared/dossier' (F208 KD-10)
// NOT re-exported here — uses Node.js fs, same pattern as Redis utils.
// Export registry (CatRegistry, catIdSchema, assertKnownCatId)
export * from './registry/index.js';
// Export all schemas
export * from './schemas/index.js';
// Export shared source-code extension helpers (F232 artifact classification + preview)
export * from './source-code-extensions.js';
export * from './text-utils.js';
// F255 runtime schemas are exported directly while their source remains grouped
// with shared types; API and MCP must validate the same owner-free settlement shape.
export * from './types/auto-dream.js';
// F167 direct carriers expose only action identities backed by terminal producers.
export * from './types/executable-action-successor.js';
// Export all types
export * from './types/index.js';
// F287 bounded opportunity/cue contract (kept explicit for API/MCP consumers).
export * from './types/memory-cue.js';
// Export subject key utilities (#320)
export * from './utils/subject-key.js';
