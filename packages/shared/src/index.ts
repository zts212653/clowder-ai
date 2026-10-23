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
// Human-facing runtime member identity shared by API notifications and Web surfaces.
export * from './cat-display-name.js';
export * from './cat-mention-identity.js';
export * from './chatgpt-cloud-presentation.js';
// Export shared CLI effort helpers
export * from './cli-effort.js';
export * from './cli-tool-label.js';
export * from './co-creator-display.js';
export * from './codex-account.js';
// F291: OAuth Codex Standard/Fast semantic contract
export * from './codex-speed.js';
export * from './collective-participation-scope.js';
export * from './collective-work-assignment.js';
// Export command parser + core commands (F142 Phase B)
export { parseCommand } from './command-parser.js';
export * from './concierge/companion-identity.js';
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
// #1343: Context window catalog (API Auto-mode fallback + Web draft preview)
export * from './context-window-catalog.js';
// F322: shared wire validation for the owner-private conversation presentation preference.
export * from './conversation-view-preference.js';
export { CORE_COMMANDS } from './core-commands.js';
export * from './deployment-defaults.js';
// F247: one contract for the shared Remote entry and the source-bound Host.
export * from './dot-mcp.js';
// Export Eval Hub metric reference normalization (F248 B3)
export * from './eval-metric-ref.js';
// First-party WebSocket Stop intent contract (API + Web single source).
export * from './explicit-stop-intent.js';
export * from './ignored-item-preference.js';
export * from './markdown-link-safety.js';
// Export shared text helpers
export * from './markdown-readable-text.js';
export * from './message-bundle-projection.js';
export * from './message-output-layout.js';
export type {
  MessageNavigationAdmission,
  MessageNavigationReference,
  MessageSearchInput,
  MessageSearchResponse,
  MessageSearchResult,
} from './message-search.js';
// First-party host-tool identities shared by onboarding discovery and catalog repair.
export * from './native-tool-identities.js';
export * from './plugin-archive-replacement.js';
export * from './plugin-configuration-required.js';
// Browser Preview Gateway request identity shared by API and Web.
export * from './preview-gateway.js';
export * from './preview-visible-page-admission.js';
export * from './provider-semantic-projection.js';
export { RECALL_DISPLAY_DOC_KINDS } from './recall-display-contract.js';
// Export recall-result sidecar contract (producer → parser → persistence → UI)
export * from './recall-outcome.js';
// Dossier profile parser: import from '@cat-cafe/shared/dossier' (F208 KD-10)
// NOT re-exported here — uses Node.js fs, same pattern as Redis utils.
// Export registry (CatRegistry, catIdSchema, assertKnownCatId)
export * from './registry/index.js';
export * from './runtime-question-retirement.js';
// Export all schemas
export * from './schemas/index.js';
// Export shared source-code extension helpers (F232 artifact classification + preview)
export * from './source-code-extensions.js';
export * from './text-utils.js';
export * from './thread-works.js';
export * from './types/artifact-review.js';
export * from './types/artifact-review-drawing.js';
// F255 runtime schemas are exported directly while their source remains grouped
// with shared types; API and MCP must validate the same owner-free settlement shape.
export * from './types/auto-dream.js';
export * from './types/collective-accountability-attention.js';
export * from './types/collective-appearance-bridge.js';
export * from './types/collective-artifact.js';
export * from './types/collective-artifact-command.js';
export * from './types/collective-artifact-context.js';
export * from './types/collective-artifact-custody.js';
export * from './types/collective-artifact-custody-relay.js';
export * from './types/collective-artifact-management.js';
export * from './types/collective-artifact-media.js';
export * from './types/collective-artifact-media-read.js';
export * from './types/collective-artifact-operations.js';
export * from './types/collective-artifact-publication.js';
export * from './types/collective-artifact-relay.js';
export * from './types/collective-collaboration.js';
export * from './types/collective-content-modification.js';
export * from './types/collective-context-bridge.js';
export * from './types/collective-media-share-surface.js';
export * from './types/collective-media-surface.js';
export * from './types/collective-media-surface-rpc.js';
export * from './types/collective-members.js';
export * from './types/collective-participation.js';
export * from './types/collective-project-authoring.js';
export * from './types/collective-ui-placement.js';
export * from './types/collective-work.js';
export * from './types/collective-work-acceptance.js';
export * from './types/collective-work-matter.js';
export * from './types/collective-work-policy.js';
export { collectiveWorkResultMediaTypeForFileName } from './types/collective-work-return.js';
export * from './types/collective-work-wake.js';
export * from './types/content-modification.js';
export * from './types/content-modification-carrier.js';
export * from './types/content-modification-control.js';
export * from './types/content-modification-view.js';
export * from './types/deployment-wait.js';
export * from './types/evolution-media-source.js';
// F167 direct carriers expose only action identities backed by terminal producers.
export * from './types/executable-action-successor.js';
// F300: refs-only home-state contract (self facet + side-effect assessment).
export * from './types/home-state.js';
// Export all types
export * from './types/index.js';
export * from './types/living-work.js';
// F314: one accepted-source contract shared by API persistence and MCP producers.
export * from './types/local-review.js';
export * from './types/media-publication-source.js';
// F287 bounded opportunity/cue contract (kept explicit for API/MCP consumers).
export * from './types/memory-cue.js';
export * from './types/message-output-layout.js';
export * from './types/message-publication-landing.js';
export * from './types/output-message.js';
export * from './types/video-project.js';
export * from './types/video-project-review.js';
export * from './types/work-video.js';
export * from './types/workspace-content-review.js';
export * from './utils/local-session-import.js';
export * from './utils/media-byte-range.js';
export * from './utils/pull-request-changes-target.js';
// Export subject key utilities (#320)
export * from './utils/subject-key.js';
