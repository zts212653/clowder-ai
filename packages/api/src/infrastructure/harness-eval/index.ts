/**
 * Barrel exports for harness-eval infrastructure.
 *
 * Focused on the SOP eval pipeline (F192 E-sop). Other modules in this
 * directory are imported directly by their consumers — this barrel is
 * additive and does not replace existing direct imports.
 */

export type { CommunityEvalDomainEntry } from './community-eval-domain.js';
export { loadCommunityDomains, parseCommunityEvalDomainEntry } from './community-eval-domain.js';
// Community path (AC-E14 / AC-E15)
export type { SanitizedIssuePacket } from './community-issue-packet.js';
export { parseSanitizedIssuePacket, sanitizeVerdictForExport } from './community-issue-packet.js';
export type {
  CapabilityName,
  CapabilityPredicate,
  CapabilityPreviewAvailability,
  CapabilityTrace,
  CapabilityTraceInput,
  CapabilityWakeupRule,
  CapabilityWakeupTrial,
  ClassifiedCapabilityWakeupTrial,
} from './eval-capability-wakeup-adapter.js';
export {
  buildCapabilityTrace,
  buildCapabilityWakeupVerdictHandoff,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from './eval-capability-wakeup-adapter.js';
export type {
  CapabilityWakeupLiveVerdictArtifact,
  GenerateCapabilityWakeupLiveVerdictInput,
} from './eval-capability-wakeup-live-verdict.js';
export { generateCapabilityWakeupLiveVerdict } from './eval-capability-wakeup-live-verdict.js';
export type { EvalDomainScheduleOpts } from './eval-domain-daily.js';
// Scheduling (frequency-aware)
export { createEvalDomainDailySpec, createEvalDomainWeeklySpec } from './eval-domain-daily.js';
export type { EvalDomainRegistryEntry } from './eval-domain-registry.js';
// Domain registry
export { parseEvalDomainRegistryEntry, parseEvalDomainRegistryFile } from './eval-domain-registry.js';
export type {
  BuildSopVerdictInput,
  RuleHandoffTargetResolver,
  RunSopEvalInput,
  SopReevalInput,
  SopReevalResult,
  SopSessionContext,
} from './eval-sop-adapter.js';
// SOP verdict adapter + production orchestrator
export { buildSopVerdictHandoff, reevalSopVerdict, runSopEval } from './eval-sop-adapter.js';
export type {
  SopDefinitionInput,
  SopEvalResult,
  SopPredicate,
  SopRuleInput,
  SopStageInput,
  SopViolation,
} from './sop-predicate-evaluator.js';
export { evaluatePredicate, evaluateSopDefinition } from './sop-predicate-evaluator.js';
export type {
  SopTrace,
  SopTraceCommand,
  SopTraceGitState,
  SopTraceHandles,
  SopTraceInput,
} from './sop-trace-adapter.js';
// SOP trace + evaluation
export { buildSopTrace } from './sop-trace-adapter.js';
export type { HandoffDecision, VerdictHandoffPacket } from './verdict-handoff.js';
// Verdict handoff
export { assertCanCrossThreadHandoff, parseVerdictHandoffPacket } from './verdict-handoff.js';
