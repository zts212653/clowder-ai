/**
 * Barrel exports for harness-eval infrastructure.
 *
 * Focused on the SOP eval pipeline (F192 E-sop). Other modules in this
 * directory are imported directly by their consumers — this barrel is
 * additive and does not replace existing direct imports.
 */

export type {
  CapabilityTipsEnableArtifactReader,
  CapabilityTipsEnableDomain,
  CapabilityTipsEnableEvidence,
} from './capability-tips/capability-tips-enable-gate.js';
export { validateCapabilityTipsEnablement } from './capability-tips/capability-tips-enable-gate.js';
export type {
  CapabilityTipsUsageRow,
  CapabilityTipsUsageSelector,
  CapabilityTipsUsageSnapshot,
} from './capability-tips/capability-tips-usage-adapter.js';
export {
  CapabilityTipsUsageAdapter,
  validateCapabilityTipsUsageSelector,
} from './capability-tips/capability-tips-usage-adapter.js';
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
export {
  DesignGateEpisodeSourceProviderImpl,
  validateDesignGateEpisodeSelector,
} from './design-gate/design-gate-episode-source-provider.js';
export type {
  DesignGateEpisodeBundle,
  DesignGateEpisodeMetricVector,
  DesignGateEpisodeSourceSelector,
} from './design-gate/design-gate-types.js';
export { generateDesignGateLiveVerdict } from './design-gate/eval-design-gate-live-verdict.js';
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
  ExternalCaseReplayResult,
  ExternalCaseReplayScenario,
} from './external-case-closure-eval.js';
export {
  buildExternalCaseClosureHealth,
  evaluateExternalCaseReplay,
} from './external-case-closure-eval.js';
export type {
  DomainNegativeControlCase,
  DomainNegativeControlCohort,
  DomainNegativeControlResultOptions,
} from './measurement/domain-negative-control.js';
export {
  buildDomainNegativeControlResult,
  DomainNegativeControlCohortSchema,
  parseDomainNegativeControlCohort,
} from './measurement/domain-negative-control.js';
export type { FrictionMeasurementBundleResultOptions } from './measurement/friction-measurement-bundle.js';
export { buildFrictionMeasurementBundleResult } from './measurement/friction-measurement-bundle.js';
export type { MeasurementBundleCensus } from './measurement/measurement-bundle-census.js';
export {
  assertMeasurementVerdictActionAllowed,
  MeasurementBundleCensusEntrySchema,
  MeasurementBundleCensusSchema,
  validateMeasurementBundleCensus,
} from './measurement/measurement-bundle-census.js';
export type {
  DecisionProcedureComponent,
  InterventionCard,
  MeasurementBundleCertificate,
  MeasurementBundleResult,
  MeasurementMetric,
} from './measurement/measurement-bundle-schema.js';
export {
  computeDecisionProcedureVersionSetHash,
  parseMeasurementBundleCertificate,
  validateMeasurementBundleResult,
} from './measurement/measurement-bundle-validation.js';
export type {
  SameVersionReplayOptions,
  SameVersionReplayReport,
} from './measurement/measurement-replay.js';
export { buildSameVersionReplayReport, SameVersionReplayReportSchema } from './measurement/measurement-replay.js';
export type {
  MemoryNegativeControlCohort,
  MemoryNegativeControlResultOptions,
} from './measurement/memory-negative-control.js';
export {
  buildMemoryNegativeControlResult,
  MemoryNegativeControlCohortSchema,
  parseMemoryNegativeControlCohort,
} from './measurement/memory-negative-control.js';
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
  DesignGateReviewPacket,
  SopTrace,
  SopTraceCommand,
  SopTraceDiffContext,
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
  StoredEpisode,
  TaskOutcomeAttribution,
  TaskOutcomeEpisode,
  TaskOutcomeVerdict,
} from './task-outcome/index.js';
export {
  CANCEL_REASONS,
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
  handleMagicWord,
  TASK_OUTCOME_ATTRIBUTIONS,
  TaskOutcomeEpisodeStore,
  VERDICT_CLASSES,
} from './task-outcome/index.js';
export { generateTrajectoryInspectorLiveVerdict } from './trajectory-inspector/eval-trajectory-inspector-live-verdict.js';
export { RepoTrajectoryInspectorEvidenceSource } from './trajectory-inspector/trajectory-inspector-repo-evidence-source.js';
export {
  type TrajectoryInspectorSourceProvider,
  TrajectoryInspectorSourceProviderImpl,
} from './trajectory-inspector/trajectory-inspector-source-provider.js';
export type {
  TrajectoryInspectorEpisode,
  TrajectoryInspectorEpisodeBundle,
  TrajectoryInspectorVector,
  TrajectoryInspectorWindowSelector,
} from './trajectory-inspector/trajectory-inspector-types.js';
export { validateTrajectoryInspectorWindowSelector } from './trajectory-inspector/trajectory-inspector-types.js';
export type { HandoffDecision, VerdictHandoffPacket } from './verdict-handoff.js';
// Verdict handoff
export { assertCanCrossThreadHandoff, parseVerdictHandoffPacket } from './verdict-handoff.js';
