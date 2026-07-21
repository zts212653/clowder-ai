import {
  ADAPTIVE_SOP_PLAN_SCHEMA_VERSION,
  type AdaptiveSopPlan,
  AdaptiveSopPlanSchema,
  SOP_ADMISSION_DECISION_SCHEMA_VERSION,
  SOP_TRIAL_EPISODE_SCHEMA_VERSION,
  type SopAdmissionDecision,
  SopAdmissionDecisionSchema,
  type SopTrialEpisode,
  SopTrialEpisodeSchema,
} from '@cat-cafe/shared';
import type { z } from 'zod';

export type AdaptiveSopContractErrorCode =
  | 'unsupported_schema_version'
  | 'invalid_contract'
  | 'semantic_invariant_violation';

type AdaptiveSopContractName = 'AdaptiveSopPlan' | 'SopAdmissionDecision' | 'SopTrialEpisode' | 'SopAdmissionFacts';

export class AdaptiveSopContractError extends Error {
  readonly code: AdaptiveSopContractErrorCode;
  readonly contract: AdaptiveSopContractName;
  readonly supportedVersion: string;
  readonly receivedVersion?: string;
  readonly issues: readonly string[];

  constructor(input: {
    code: AdaptiveSopContractErrorCode;
    contract: AdaptiveSopContractName;
    supportedVersion: string;
    receivedVersion?: string;
    issues: readonly string[];
  }) {
    super(`${input.contract} ${input.code}: ${input.issues.join('; ')}`);
    this.name = 'AdaptiveSopContractError';
    this.code = input.code;
    this.contract = input.contract;
    this.supportedVersion = input.supportedVersion;
    this.receivedVersion = input.receivedVersion;
    this.issues = input.issues;
  }
}

export function parseAdaptiveSopPlan(input: unknown): AdaptiveSopPlan {
  const parsed = parseVersionedContract(
    input,
    'AdaptiveSopPlan',
    ADAPTIVE_SOP_PLAN_SCHEMA_VERSION,
    AdaptiveSopPlanSchema,
  );
  assertSemanticInvariants('AdaptiveSopPlan', ADAPTIVE_SOP_PLAN_SCHEMA_VERSION, validatePlanSemantics(parsed));
  return parsed;
}

export function parseSopAdmissionDecision(input: unknown): SopAdmissionDecision {
  const parsed = parseVersionedContract(
    input,
    'SopAdmissionDecision',
    SOP_ADMISSION_DECISION_SCHEMA_VERSION,
    SopAdmissionDecisionSchema,
  );
  const issues: string[] = [];
  if (parsed.status === 'revise') {
    collectDuplicateIssues('violations', parsed.violations, issues);
    collectDuplicateIssues('requiredFacts', parsed.requiredFacts, issues);
  }
  assertSemanticInvariants('SopAdmissionDecision', SOP_ADMISSION_DECISION_SCHEMA_VERSION, issues);
  return parsed;
}

export function parseSopTrialEpisode(input: unknown): SopTrialEpisode {
  assertSupportedVersion(input, 'SopTrialEpisode', SOP_TRIAL_EPISODE_SCHEMA_VERSION);
  if (!isRecord(input)) {
    throw invalidContract('SopTrialEpisode', SOP_TRIAL_EPISODE_SCHEMA_VERSION, ['contract must be an object']);
  }

  const plan = parseAdaptiveSopPlan(input.plan);
  const admission = parseSopAdmissionDecision(input.admission);
  const parsed = parseVersionedContract(
    { ...input, plan, admission },
    'SopTrialEpisode',
    SOP_TRIAL_EPISODE_SCHEMA_VERSION,
    SopTrialEpisodeSchema,
  );
  assertSemanticInvariants('SopTrialEpisode', SOP_TRIAL_EPISODE_SCHEMA_VERSION, validateEpisodeSemantics(parsed));
  return parsed;
}

function parseVersionedContract<T>(
  input: unknown,
  contract: AdaptiveSopContractName,
  supportedVersion: string,
  schema: z.ZodType<T>,
): T {
  assertSupportedVersion(input, contract, supportedVersion);
  const result = schema.safeParse(input);
  if (!result.success) {
    throw invalidContract(
      contract,
      supportedVersion,
      result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }
  return result.data;
}

function assertSupportedVersion(input: unknown, contract: AdaptiveSopContractName, supportedVersion: string): void {
  if (!isRecord(input) || typeof input.schemaVersion !== 'string') {
    throw invalidContract(contract, supportedVersion, ['schemaVersion is required']);
  }
  if (input.schemaVersion !== supportedVersion) {
    throw new AdaptiveSopContractError({
      code: 'unsupported_schema_version',
      contract,
      supportedVersion,
      receivedVersion: input.schemaVersion,
      issues: [`supported=${supportedVersion}`, `received=${input.schemaVersion}`],
    });
  }
}

function invalidContract(
  contract: AdaptiveSopContractName,
  supportedVersion: string,
  issues: readonly string[],
): AdaptiveSopContractError {
  return new AdaptiveSopContractError({
    code: 'invalid_contract',
    contract,
    supportedVersion,
    issues,
  });
}

function assertSemanticInvariants(
  contract: AdaptiveSopContractName,
  supportedVersion: string,
  issues: readonly string[],
): void {
  if (issues.length === 0) return;
  throw new AdaptiveSopContractError({
    code: 'semantic_invariant_violation',
    contract,
    supportedVersion,
    issues,
  });
}

function validatePlanSemantics(plan: AdaptiveSopPlan): string[] {
  const issues: string[] = [];
  collectDuplicateIssues(
    'decisions.stepId',
    plan.decisions.map((decision) => decision.stepId),
    issues,
  );
  collectDuplicateIssues('executionOrder', plan.executionOrder, issues);
  if (plan.repositoryFacts.changedFiles) {
    collectDuplicateIssues('repositoryFacts.changedFiles', plan.repositoryFacts.changedFiles, issues);
  }

  collectRiskEvidenceIssues(plan, issues);
  collectReplacementEvidenceIssues(plan, issues);
  collectExecutionOrderIssues(plan, issues);
  return issues;
}

function collectRiskEvidenceIssues(plan: AdaptiveSopPlan, issues: string[]): void {
  for (const [index, risk] of plan.risks.entries()) {
    if (risk.evidence.length === 0 && risk.uncertainty.length === 0) {
      issues.push(`risks.${index} requires evidence or explicit uncertainty`);
    }
  }
}

function collectReplacementEvidenceIssues(plan: AdaptiveSopPlan, issues: string[]): void {
  for (const decision of plan.decisions) {
    if (
      (decision.action === 'omit' || decision.action === 'replace') &&
      (!decision.replacementEvidence || decision.replacementEvidence.length === 0)
    ) {
      issues.push(`decisions.${decision.stepId}.replacementEvidence is required for ${decision.action}`);
    }
  }
}

function collectExecutionOrderIssues(plan: AdaptiveSopPlan, issues: string[]): void {
  const decisionById = new Map(plan.decisions.map((decision) => [decision.stepId, decision]));
  const executableIds = new Set(
    plan.decisions.filter((decision) => decision.action !== 'omit').map((decision) => decision.stepId),
  );
  const orderedIds = new Set(plan.executionOrder);
  for (const stepId of plan.executionOrder) {
    const decision = decisionById.get(stepId);
    if (!decision) issues.push(`executionOrder references unknown stepId ${stepId}`);
    else if (decision.action === 'omit') issues.push(`executionOrder contains omitted stepId ${stepId}`);
  }
  for (const stepId of executableIds) {
    if (!orderedIds.has(stepId)) issues.push(`executionOrder is missing ${stepId}`);
  }
}

function validateEpisodeSemantics(episode: SopTrialEpisode): string[] {
  const issues: string[] = [];
  collectDuplicateIssues('missingFields', episode.missingFields, issues);

  if (episode.admission.status === 'admitted' && episode.admission.episodeId !== episode.plan.episodeId) {
    issues.push('admission.episodeId must match plan.episodeId');
  }

  collectStepTimeIssues(episode, issues);
  collectTelemetryIssues(episode, issues);

  return issues;
}

function collectStepTimeIssues(episode: SopTrialEpisode, issues: string[]): void {
  for (const [index, step] of episode.actualSteps.entries()) {
    if (Date.parse(step.completedAt) < Date.parse(step.startedAt)) {
      issues.push(`actualSteps.${index}.completedAt precedes startedAt`);
    }
  }
}

function collectTelemetryIssues(episode: SopTrialEpisode, issues: string[]): void {
  const observedMissing = observedMissingFields(episode);
  const declaredMissing = new Set(episode.missingFields);
  for (const path of observedMissing) {
    if (!declaredMissing.has(path)) issues.push(`missingFields must include ${path}`);
  }
  if (episode.telemetryComplete && (observedMissing.size > 0 || declaredMissing.size > 0)) {
    issues.push('telemetryComplete cannot be true when values or declared fields are missing');
  }
  if (!episode.telemetryComplete && declaredMissing.size === 0) {
    issues.push('telemetryComplete=false requires at least one missingFields entry');
  }
}

function observedMissingFields(episode: SopTrialEpisode): Set<string> {
  const fields = new Set<string>();
  if (episode.outcome.requestedOutcomeMet === 'unknown') fields.add('outcome.requestedOutcomeMet');
  if (episode.outcome.testsPassed === 'unknown') fields.add('outcome.testsPassed');
  if (episode.outcome.escapedRegression === 'unknown') fields.add('outcome.escapedRegression');
  for (const [key, value] of Object.entries(episode.cost)) {
    if (value === 'missing') fields.add(`cost.${key}`);
  }
  return fields;
}

function collectDuplicateIssues(label: string, values: readonly string[], issues: string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issues.push(`${label} contains duplicate ${value}`);
    seen.add(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
