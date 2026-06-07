/**
 * Barrel exports for harness-eval infrastructure.
 *
 * Focused on the SOP eval pipeline (F192 E-sop). Other modules in this
 * directory are imported directly by their consumers — this barrel is
 * additive and does not replace existing direct imports.
 */

export type {
  CapabilityName,
  CapabilityPredicate,
  CapabilityPreviewAvailability,
  CapabilityTrace,
  CapabilityTraceInput,
  CapabilityWakeupRule,
  CapabilityWakeupTrial,
  ClassifiedCapabilityWakeupTrial,
} from './capability-wakeup/eval-capability-wakeup-adapter.js';
export {
  buildCapabilityTrace,
  buildCapabilityWakeupVerdictHandoff,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from './capability-wakeup/eval-capability-wakeup-adapter.js';
export type {
  CapabilityWakeupLiveVerdictArtifact,
  GenerateCapabilityWakeupLiveVerdictInput,
} from './capability-wakeup/eval-capability-wakeup-live-verdict.js';
export { generateCapabilityWakeupLiveVerdict } from './capability-wakeup/eval-capability-wakeup-live-verdict.js';
export type { CommunityEvalDomainEntry } from './domain/community-eval-domain.js';
export { loadCommunityDomains, parseCommunityEvalDomainEntry } from './domain/community-eval-domain.js';
// Community path (AC-E14 / AC-E15)
export type { SanitizedIssuePacket } from './domain/community-issue-packet.js';
export { parseSanitizedIssuePacket, sanitizeVerdictForExport } from './domain/community-issue-packet.js';
export type { EvalDomainScheduleOpts } from './domain/eval-domain-daily.js';
// Scheduling (frequency-aware)
export { createEvalDomainDailySpec, createEvalDomainWeeklySpec } from './domain/eval-domain-daily.js';
export type { EvalDomainRegistryEntry } from './domain/eval-domain-registry.js';
// Domain registry
export { parseEvalDomainRegistryEntry, parseEvalDomainRegistryFile } from './domain/eval-domain-registry.js';
export type {
  BuildSopVerdictInput,
  RuleHandoffTargetResolver,
  RunSopEvalInput,
  SopReevalInput,
  SopReevalResult,
  SopSessionContext,
} from './sop/eval-sop-adapter.js';
// SOP verdict adapter + production orchestrator
export { buildSopVerdictHandoff, reevalSopVerdict, runSopEval } from './sop/eval-sop-adapter.js';
export type {
  SopDefinitionInput,
  SopEvalResult,
  SopPredicate,
  SopRuleInput,
  SopStageInput,
  SopViolation,
} from './sop/sop-predicate-evaluator.js';
export { evaluatePredicate, evaluateSopDefinition } from './sop/sop-predicate-evaluator.js';
export type {
  SopTrace,
  SopTraceCommand,
  SopTraceGitState,
  SopTraceHandles,
  SopTraceInput,
} from './sop/sop-trace-adapter.js';
// SOP trace + evaluation
export { buildSopTrace } from './sop/sop-trace-adapter.js';
// Task outcome (F192 Phase G)
export type {
  AssembledEpisode,
  CancelReason,
  PermissionCancelInput,
  StoredEpisode,
  TaskOutcomeEpisode,
  TaskOutcomeVerdict,
} from './task-outcome/index.js';
export {
  CANCEL_REASONS,
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
  handleMagicWord,
  handlePermissionCancel,
  TaskOutcomeEpisodeStore,
  VERDICT_CLASSES,
} from './task-outcome/index.js';
export type { HandoffDecision, VerdictHandoffPacket } from './verdict-handoff.js';
// Verdict handoff
export { assertCanCrossThreadHandoff, parseVerdictHandoffPacket } from './verdict-handoff.js';
