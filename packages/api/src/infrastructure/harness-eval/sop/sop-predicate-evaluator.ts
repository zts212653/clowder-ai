/**
 * F192 E-sop AC-E18: Predicate Evaluator.
 *
 * Evaluates SopDefinition predicates against a SopTrace.
 * Each predicate type has a dedicated evaluator function.
 * Returns per-rule pass / violation / skipped results.
 */

import type { SopTrace } from './sop-trace-adapter.js';

// ---- Predicate type definitions (mirrors sop-definition.generated.ts shapes) ----

interface PredicateManualOnly {
  readonly type: 'manual_only';
  readonly reason: string;
}

interface PredicateCommandPattern {
  readonly type: 'command_pattern';
  readonly mustMatch?: string;
  readonly mustNotMatch?: string;
}

interface PredicateCommandSequence {
  readonly type: 'command_sequence';
  readonly mustInclude?: readonly string[];
  readonly antiPattern?: readonly string[];
  readonly absent?: readonly string[];
  readonly cwdContains?: string;
}

interface PredicateShaDedup {
  readonly type: 'sha_dedup';
  readonly scope: string;
}

interface PredicateEnvCheck {
  readonly type: 'env_check';
  readonly key: string;
  readonly mustInclude?: string;
  readonly mustNotInclude?: string;
}

interface PredicateGitState {
  readonly type: 'git_state_predicate';
  readonly repository: string;
  readonly branch: string;
  readonly checks: readonly string[];
  readonly beforeCommand?: string;
}

interface PredicateHandleCheck {
  readonly type: 'handle_check';
  readonly constraint: string;
}

export type SopPredicate =
  | PredicateManualOnly
  | PredicateCommandPattern
  | PredicateCommandSequence
  | PredicateShaDedup
  | PredicateEnvCheck
  | PredicateGitState
  | PredicateHandleCheck;

// ---- Rule owner ----

export interface RuleOwner {
  readonly type: string;
  readonly skill: string;
}

// ---- Evaluation results ----

export interface SopViolation {
  readonly ruleId: string;
  readonly stageId: string;
  readonly kind: 'hard_rule' | 'pitfall';
  readonly severity: 'blocker' | 'warn' | 'info';
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

// ---- Rule shape (subset of generated SopDefinition) ----

export interface SopRuleInput {
  readonly id: string;
  readonly kind: 'hard_rule' | 'pitfall';
  readonly text: string;
  readonly severity: 'blocker' | 'warn' | 'info';
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

// ---- Core dispatcher ----

export function evaluatePredicate(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
  predicate: SopPredicate,
  trace: SopTrace,
  owner?: RuleOwner,
): SopEvalResult {
  let result: SopEvalResult;
  switch (predicate.type) {
    case 'manual_only':
      return { ruleId, status: 'skipped', reason: predicate.reason };
    case 'command_pattern':
      result = evaluateCommandPattern(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'command_sequence':
      result = evaluateCommandSequence(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'sha_dedup':
      result = evaluateShaDedup(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'env_check':
      result = evaluateEnvCheck(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'git_state_predicate':
      result = evaluateGitState(ruleId, stageId, kind, severity, predicate, trace);
      break;
    case 'handle_check':
      result = evaluateHandleCheck(ruleId, stageId, kind, severity, predicate, trace);
      break;
    default:
      return { ruleId, status: 'skipped', reason: `unknown predicate type: ${(predicate as { type: string }).type}` };
  }

  // Attach rule owner to violations (AC-E21: per-rule owner handoff)
  if (result.violation && owner) {
    return { ...result, violation: { ...result.violation, owner } };
  }
  return result;
}

// ---- Predicate evaluators ----

function evaluateCommandPattern(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
  predicate: PredicateCommandPattern,
  trace: SopTrace,
): SopEvalResult {
  if (predicate.mustMatch) {
    const patterns = predicate.mustMatch.split('|');
    // A command only counts as "matched" when it was invoked AND succeeded
    // (exitCode === 0 or absent). A non-zero exitCode means the check failed
    // and the blocker is not truly satisfied.
    const found = trace.commands.some(
      (c) =>
        patterns.some((pattern) => new RegExp(pattern).test(c.command)) &&
        (c.exitCode === undefined || c.exitCode === 0),
    );
    if (!found) {
      const cmdSummary = trace.commands
        .map((c) => (c.exitCode != null ? `${c.command}(exit:${c.exitCode})` : c.command))
        .join(',');
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'command_pattern',
        `required command pattern "${predicate.mustMatch}" not found (or failed) in session commands`,
        `commands:[${cmdSummary}]`,
      );
    }
  }

  if (predicate.mustNotMatch) {
    // mustNotMatch checks command invocation regardless of exit code —
    // running a forbidden command is a violation even if it failed.
    const patterns = predicate.mustNotMatch.split('|');
    const matched = trace.commands.find((c) => patterns.some((pattern) => new RegExp(pattern).test(c.command)));
    if (matched) {
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'command_pattern',
        `forbidden command pattern "${predicate.mustNotMatch}" matched: "${matched.command}"`,
        `command:${matched.command}`,
      );
    }
  }

  return { ruleId, status: 'pass' };
}

function evaluateCommandSequence(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
  predicate: PredicateCommandSequence,
  trace: SopTrace,
): SopEvalResult {
  let commands = trace.commands;
  if (predicate.cwdContains) {
    commands = commands.filter((c) => c.cwd?.includes(predicate.cwdContains!));
    // No commands match the cwd filter → rule not applicable to this trace
    if (commands.length === 0) {
      return { ruleId, status: 'pass' };
    }
  }
  const cmdStrings = commands.map((c) => c.command);

  const hasAbsent = !!(predicate.absent && predicate.absent.length > 0);

  // mustInclude: all patterns must match at least one command.
  // When combined with absent, mustInclude acts as a precondition gate —
  // if the gate fails the scenario doesn't apply (pass, not violation).
  if (predicate.mustInclude) {
    for (const pattern of predicate.mustInclude) {
      const patterns = pattern.split('|');
      const found = cmdStrings.some((cmd) => patterns.some((p) => new RegExp(p).test(cmd)));
      if (!found) {
        if (hasAbsent) {
          // Gate fails → scenario not applicable → pass
          return { ruleId, status: 'pass' };
        }
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'command_sequence',
          `required command "${pattern}" missing from sequence`,
          `commands:[${cmdStrings.join(',')}]`,
        );
      }
    }
  }

  // antiPattern: sequence of commands that should NOT appear in order.
  // When combined with absent, antiPattern acts as a precondition gate —
  // if the anti-pattern is NOT detected, the scenario doesn't apply.
  if (predicate.antiPattern) {
    let searchFrom = 0;
    let allFound = true;
    for (const pattern of predicate.antiPattern) {
      const patterns = pattern.split('|');
      const idx = cmdStrings.findIndex((cmd, i) => i >= searchFrom && patterns.some((p) => new RegExp(p).test(cmd)));
      if (idx === -1) {
        allFound = false;
        break;
      }
      searchFrom = idx + 1;
    }
    if (allFound && !hasAbsent) {
      // Standalone antiPattern (no absent) → violation
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'command_sequence',
        `anti-pattern detected: [${predicate.antiPattern.join(' → ')}]`,
        `commands:[${cmdStrings.join(',')}]`,
      );
    }
    if (!allFound && hasAbsent) {
      // Anti-pattern gate fails → scenario not applicable → pass
      return { ruleId, status: 'pass' };
    }
    // allFound && hasAbsent → fall through to absent check
  }

  // absent: patterns whose ABSENCE from the trace constitutes a violation.
  // "absent" describes the violation condition — the listed commands SHOULD be
  // present; their absence means something required was skipped.
  if (hasAbsent) {
    for (const pattern of predicate.absent!) {
      const patterns = pattern.split('|');
      const found = cmdStrings.some((cmd) => patterns.some((p) => new RegExp(p).test(cmd)));
      if (!found) {
        return violation(
          ruleId,
          stageId,
          kind,
          severity,
          'command_sequence',
          `required command "${pattern}" absent from session`,
          `commands:[${cmdStrings.join(',')}]`,
        );
      }
    }
  }

  return { ruleId, status: 'pass' };
}

function evaluateShaDedup(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
  predicate: PredicateShaDedup,
  trace: SopTrace,
): SopEvalResult {
  const sha = trace.shaContext[predicate.scope];
  if (!sha) {
    // No SHA context for this scope — cannot check, treat as pass
    return { ruleId, status: 'pass' };
  }

  // Check if same SHA appears in multiple commands (duplicate trigger detection)
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

function evaluateEnvCheck(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
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

function evaluateGitState(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
  predicate: PredicateGitState,
  trace: SopTrace,
): SopEvalResult {
  const git = trace.gitState;

  // Scope gate: branch must match (if specified)
  if (predicate.branch && git.branch !== predicate.branch) {
    return { ruleId, status: 'pass' };
  }

  // Scope gate: repository must match worktreeRoot (if both specified)
  if (predicate.repository && git.worktreeRoot && !git.worktreeRoot.includes(predicate.repository)) {
    return { ruleId, status: 'pass' };
  }

  // Scope gate: beforeCommand must be present in trace commands
  if (predicate.beforeCommand) {
    const found = trace.commands.some((c) => c.command.includes(predicate.beforeCommand!));
    if (!found) {
      return { ruleId, status: 'pass' };
    }
  }

  for (const check of predicate.checks) {
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
        // Unknown check — skip (forward-compatible)
        break;
    }
  }

  return { ruleId, status: 'pass' };
}

function evaluateHandleCheck(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
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
      break;
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
      // Unknown constraint — pass (forward-compatible)
      break;
  }

  return { ruleId, status: 'pass' };
}

// ---- Full SOP definition evaluation ----

export function evaluateSopDefinition(definition: SopDefinitionInput, trace: SopTrace): SopEvalResult[] {
  const results: SopEvalResult[] = [];

  for (const stage of definition.stages) {
    const allRules = [...stage.hardRules, ...stage.pitfalls];
    for (const rule of allRules) {
      results.push(evaluatePredicate(rule.id, stage.id, rule.kind, rule.severity, rule.predicate, trace, rule.owner));
    }
  }

  return results;
}

// ---- Helper ----

function violation(
  ruleId: string,
  stageId: string,
  kind: 'hard_rule' | 'pitfall',
  severity: 'blocker' | 'warn' | 'info',
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
