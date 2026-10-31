import type {
  PredicateEnvCheck,
  PredicateGitState,
  PredicateHandleCheck,
  PredicateShaDedup,
  SopEvalResult,
  SopRuleKind,
  SopSeverity,
} from './sop-predicate-types.js';
import { violation } from './sop-predicate-types.js';
import type { SopTrace } from './sop-trace-adapter.js';

export function evaluateShaDedup(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateShaDedup,
  trace: SopTrace,
): SopEvalResult {
  const sha = trace.shaContext[predicate.scope];
  if (!sha) {
    return { ruleId, status: 'pass' };
  }

  const shaCommands = trace.commands.filter((c) => c.command.includes(sha));
  if (shaCommands.length > 1) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'sha_dedup',
      `duplicate trigger detected for SHA ${sha} in scope "${predicate.scope}" (${shaCommands.length} occurrences)`,
      `sha:${sha}`,
    );
  }

  return { ruleId, status: 'pass' };
}

export function evaluateEnvCheck(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateEnvCheck,
  trace: SopTrace,
): SopEvalResult {
  const value = trace.envSnapshot[predicate.key];

  if (predicate.mustInclude && (!value || !value.includes(predicate.mustInclude))) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'env_check',
      `env ${predicate.key}="${value ?? '<unset>'}" must include "${predicate.mustInclude}"`,
      `env:${predicate.key}=${value ?? '<unset>'}`,
    );
  }

  if (predicate.mustNotInclude && value && value.includes(predicate.mustNotInclude)) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'env_check',
      `env ${predicate.key}="${value}" must NOT include "${predicate.mustNotInclude}"`,
      `env:${predicate.key}=${value}`,
    );
  }

  return { ruleId, status: 'pass' };
}

export function evaluateGitState(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateGitState,
  trace: SopTrace,
): SopEvalResult {
  const git = trace.gitState;

  if (predicate.branch && git.branch !== predicate.branch) {
    return { ruleId, status: 'pass' };
  }

  if (predicate.repository && git.worktreeRoot && !git.worktreeRoot.includes(predicate.repository)) {
    return { ruleId, status: 'pass' };
  }

  if (predicate.beforeCommand) {
    const beforeCommand = predicate.beforeCommand;
    const found = trace.commands.some((c) => c.command.includes(beforeCommand));
    if (!found) {
      return { ruleId, status: 'pass' };
    }
  }

  for (const check of predicate.checks) {
    const result = evaluateGitStateCheck(ruleId, stageId, kind, severity, check, git);
    if (result) return result;
  }

  return { ruleId, status: 'pass' };
}

function evaluateGitStateCheck(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  check: string,
  git: SopTrace['gitState'],
): SopEvalResult | undefined {
  switch (check) {
    case 'ahead_zero':
      if (git.ahead !== 0) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'git_state_predicate',
          `git state: ahead=${git.ahead}, expected 0`,
          `git:ahead=${git.ahead}`,
        );
      }
      break;
    case 'behind_zero':
      if (git.behind !== 0) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'git_state_predicate',
          `git state: behind=${git.behind}, expected 0`,
          `git:behind=${git.behind}`,
        );
      }
      break;
    case 'clean_worktree':
      if (!git.clean) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'git_state_predicate',
          'git state: worktree is not clean',
          'git:dirty',
        );
      }
      break;
    default:
      break;
  }
  return undefined;
}

export function evaluateHandleCheck(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateHandleCheck,
  trace: SopTrace,
): SopEvalResult {
  const { author, reviewer, guardian } = trace.handles;

  switch (predicate.constraint) {
    case 'reviewer_not_author':
      if (author && reviewer && author === reviewer) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'handle_check',
          `reviewer "${reviewer}" is the same as author "${author}"`,
          `handles:author=${author},reviewer=${reviewer}`,
        );
      }
      if (!reviewer) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'handle_check',
          'no reviewer assigned',
          'handles:reviewer=<unset>',
        );
      }
      break;
    case 'vision_guardian_not_author_or_reviewer':
      return evaluateGuardianCheck(ruleId, stageId, kind, severity, author, reviewer, guardian);
    case 'guardian_handoff_present':
      if (!guardian) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'handle_check',
          'guardian handoff not present',
          'handles:guardian=<unset>',
        );
      }
      break;
    default:
      break;
  }

  return { ruleId, status: 'pass' };
}

function evaluateGuardianCheck(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  author: string | undefined,
  reviewer: string | undefined,
  guardian: string | undefined,
): SopEvalResult {
  if (!guardian) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'handle_check',
      'no guardian assigned',
      'handles:guardian=<unset>',
    );
  }
  if (guardian === author) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'handle_check',
      `guardian "${guardian}" is the same as author`,
      `handles:guardian=${guardian},author=${author}`,
    );
  }
  if (guardian === reviewer) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'handle_check',
      `guardian "${guardian}" is the same as reviewer`,
      `handles:guardian=${guardian},reviewer=${reviewer}`,
    );
  }
  return { ruleId, status: 'pass' };
}
