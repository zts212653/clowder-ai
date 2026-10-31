/**
 * F192 Phase G — Task Outcome Episode barrel exports.
 */

// Schema + types
export type {
  A1WorldTruthRecord,
  A2InteractionDecision,
  CancelReason,
  MagicWordRecord,
  PermissionCancelRecord,
  ProxySignal,
  TaskOutcomeAttribution,
  TaskOutcomeEpisode,
  TaskOutcomeVerdict,
} from './task-outcome-episode.js';
export {
  CANCEL_REASONS,
  parseA1WorldTruthRecord,
  parseMagicWordRecord,
  parsePermissionCancelRecord,
  parseTaskOutcomeEpisode,
  TASK_OUTCOME_ATTRIBUTIONS,
  VERDICT_CLASSES,
} from './task-outcome-episode.js';

// Route handlers
export type {
  A1WorldTruthInput,
  AssembledEpisode,
  MagicWordInput,
  SignalAppendResult,
} from './task-outcome-routes.js';
export {
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
  handleMagicWord,
} from './task-outcome-routes.js';

// Signal builders
export type {
  BuildA1WorldTruthInput,
  BuildMagicWordInput,
} from './task-outcome-signal-builder.js';
export {
  buildA1WorldTruthSignal,
  buildMagicWordSignal,
} from './task-outcome-signal-builder.js';

// Store
export type {
  AppendSignalInput,
  CreateEpisodeInput,
  EpisodeAttributionLookup,
  StoredEpisode,
  StoredSignal,
} from './task-outcome-store.js';
export { TaskOutcomeEpisodeStore } from './task-outcome-store.js';
