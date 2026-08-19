import { matchesCommandPattern } from './sop-command-pattern.js';
import type {
  PredicateCommandPattern,
  PredicateCommandSequence,
  SopEvalResult,
  SopRuleKind,
  SopSeverity,
} from './sop-predicate-types.js';
import { violation } from './sop-predicate-types.js';
import type { SopTrace } from './sop-trace-adapter.js';

export function evaluateCommandPattern(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateCommandPattern,
  trace: SopTrace,
): SopEvalResult {
  const mustMatch = predicate.mustMatch;
  if (mustMatch) {
    const found = trace.commands.some(
      (c) => matchesCommandPattern(c.command, mustMatch) && (c.exitCode === undefined || c.exitCode === 0),
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

  const mustNotMatch = predicate.mustNotMatch;
  if (mustNotMatch) {
    const matched = trace.commands.find((c) => matchesCommandPattern(c.command, mustNotMatch));
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

export function evaluateCommandSequence(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateCommandSequence,
  trace: SopTrace,
): SopEvalResult {
  const cmdStrings = commandStringsInScope(predicate, trace);
  if (!cmdStrings) return { ruleId, status: 'pass' };

  const hasAbsent = !!(predicate.absent && predicate.absent.length > 0);
  const context = { ruleId, stageId, kind, severity };

  return (
    evaluateMustInclude(context, predicate, cmdStrings, hasAbsent) ??
    evaluateAntiPattern(context, predicate, cmdStrings, hasAbsent) ??
    evaluateAbsent(context, predicate, cmdStrings) ?? { ruleId, status: 'pass' }
  );
}

function commandStringsInScope(predicate: PredicateCommandSequence, trace: SopTrace): string[] | undefined {
  const cwdContains = predicate.cwdContains;
  const commands = cwdContains ? trace.commands.filter((c) => c.cwd?.includes(cwdContains)) : trace.commands;
  if (cwdContains && commands.length === 0) return undefined;
  return commands.map((c) => c.command);
}

interface SequenceContext {
  readonly ruleId: string;
  readonly stageId: string;
  readonly kind: SopRuleKind;
  readonly severity: SopSeverity;
}

function evaluateMustInclude(
  context: SequenceContext,
  predicate: PredicateCommandSequence,
  cmdStrings: readonly string[],
  hasAbsent: boolean,
): SopEvalResult | undefined {
  if (predicate.mustInclude) {
    for (const pattern of predicate.mustInclude) {
      if (commandMatches(pattern, cmdStrings)) continue;
      if (hasAbsent) return { ruleId: context.ruleId, status: 'pass' };
      return violation(
        context.ruleId,
        context.stageId,
        context.kind,
        context.severity,
        'command_sequence',
        `required command "${pattern}" missing from sequence`,
        `commands:[${cmdStrings.join(',')}]`,
      );
    }
  }
  return undefined;
}

function evaluateAntiPattern(
  context: SequenceContext,
  predicate: PredicateCommandSequence,
  cmdStrings: readonly string[],
  hasAbsent: boolean,
): SopEvalResult | undefined {
  if (predicate.antiPattern) {
    let searchFrom = 0;
    let allFound = true;
    for (const pattern of predicate.antiPattern) {
      const idx = findPatternIndex(pattern, cmdStrings, searchFrom);
      if (idx === -1) {
        allFound = false;
        break;
      }
      searchFrom = idx + 1;
    }
    if (allFound && !hasAbsent) {
      return violation(
        context.ruleId,
        context.stageId,
        context.kind,
        context.severity,
        'command_sequence',
        `anti-pattern detected: [${predicate.antiPattern.join(' → ')}]`,
        `commands:[${cmdStrings.join(',')}]`,
      );
    }
    if (!allFound && hasAbsent) {
      return { ruleId: context.ruleId, status: 'pass' };
    }
  }
  return undefined;
}

function evaluateAbsent(
  context: SequenceContext,
  predicate: PredicateCommandSequence,
  cmdStrings: readonly string[],
): SopEvalResult | undefined {
  for (const pattern of predicate.absent ?? []) {
    if (commandMatches(pattern, cmdStrings)) continue;
    return violation(
      context.ruleId,
      context.stageId,
      context.kind,
      context.severity,
      'command_sequence',
      `required command "${pattern}" absent from session`,
      `commands:[${cmdStrings.join(',')}]`,
    );
  }
  return undefined;
}

function commandMatches(pattern: string, cmdStrings: readonly string[]): boolean {
  return findPatternIndex(pattern, cmdStrings, 0) !== -1;
}

function findPatternIndex(pattern: string, cmdStrings: readonly string[], searchFrom: number): number {
  return cmdStrings.findIndex((cmd, i) => {
    if (i < searchFrom) return false;
    return matchesCommandPattern(cmd, pattern);
  });
}
