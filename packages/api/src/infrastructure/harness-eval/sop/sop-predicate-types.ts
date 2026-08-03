export type SopRuleKind = 'hard_rule' | 'pitfall';
export type SopSeverity = 'blocker' | 'warn' | 'info';

// Predicate type definitions mirror sop-definition.generated.ts shapes.
export interface PredicateManualOnly {
  readonly type: 'manual_only';
  readonly reason: string;
}

export interface PredicateChangedFilesRequireCommand {
  readonly type: 'changed_files_require_command';
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly mustMatch: string;
}

export interface PredicateCommandPattern {
  readonly type: 'command_pattern';
  readonly mustMatch?: string;
  readonly mustNotMatch?: string;
}

export interface PredicateCoCreationDocsLane {
  readonly type: 'co_creation_docs_lane';
  readonly includeGlobs: readonly string[];
  readonly classifierRequiredGlobs?: readonly string[];
  readonly classifierMatch: string;
  readonly worktreeMatch: string;
  readonly pullRequestMatch: string;
  readonly cloudReviewMatch: string;
  readonly fullGateMatch: string;
}

export interface PredicateCommandSequence {
  readonly type: 'command_sequence';
  readonly mustInclude?: readonly string[];
  readonly antiPattern?: readonly string[];
  readonly absent?: readonly string[];
  readonly cwdContains?: string;
}

export interface PredicateShaDedup {
  readonly type: 'sha_dedup';
  readonly scope: string;
}

export interface PredicateEnvCheck {
  readonly type: 'env_check';
  readonly key: string;
  readonly mustInclude?: string;
  readonly mustNotInclude?: string;
}

export interface PredicateGitState {
  readonly type: 'git_state_predicate';
  readonly repository: string;
  readonly branch: string;
  readonly checks: readonly string[];
  readonly beforeCommand?: string;
}

export interface PredicateHandleCheck {
  readonly type: 'handle_check';
  readonly constraint: string;
}

export type SopPredicate =
  | PredicateManualOnly
  | PredicateChangedFilesRequireCommand
  | PredicateCoCreationDocsLane
  | PredicateCommandPattern
  | PredicateCommandSequence
  | PredicateShaDedup
  | PredicateEnvCheck
  | PredicateGitState
  | PredicateHandleCheck;

export interface RuleOwner {
  readonly type: string;
  readonly skill: string;
}

export interface SopViolation {
  readonly ruleId: string;
  readonly stageId: string;
  readonly kind: SopRuleKind;
  readonly severity: SopSeverity;
  readonly predicateType: string;
  readonly message: string;
  readonly traceAnchor: string;
  readonly owner?: RuleOwner;
}

export interface SopEvalResult {
  readonly ruleId: string;
  readonly status: 'pass' | 'violation' | 'skipped';
  readonly violation?: SopViolation;
  readonly reason?: string;
}

export interface SopRuleInput {
  readonly id: string;
  readonly kind: SopRuleKind;
  readonly text: string;
  readonly severity: SopSeverity;
  readonly predicate: SopPredicate;
  readonly owner?: RuleOwner;
}

export interface SopStageInput {
  readonly id: string;
  readonly hardRules: readonly SopRuleInput[];
  readonly pitfalls: readonly SopRuleInput[];
}

export interface SopDefinitionInput {
  readonly id: string;
  readonly stages: readonly SopStageInput[];
}

export function violation(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicateType: string,
  message: string,
  traceAnchor: string,
): SopEvalResult {
  return {
    ruleId,
    status: 'violation',
    violation: { ruleId, stageId, kind, severity, predicateType, message, traceAnchor },
  };
}
