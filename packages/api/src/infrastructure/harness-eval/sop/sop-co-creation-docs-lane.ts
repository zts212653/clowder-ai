import { posix as pathPosix } from 'node:path';
import { matchesAny } from '../capability-wakeup/eval-capability-wakeup-trials-support.js';
import { matchesCommandPattern } from './sop-command-pattern.js';
import type { PredicateCoCreationDocsLane, SopEvalResult, SopRuleKind, SopSeverity } from './sop-predicate-types.js';
import { violation } from './sop-predicate-types.js';
import type { SopTrace, SopTraceCommand } from './sop-trace-adapter.js';

interface CoCreationDocsDecision {
  readonly lane: 'co_creation_docs' | 'regular_development';
  readonly delivery: 'direct_push' | 'pull_request';
  readonly cloudReview: 'required' | 'skip';
  readonly fullGate: 'required' | 'skip';
  readonly changedFiles: readonly string[];
}

export function evaluateCoCreationDocsLane(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateCoCreationDocsLane,
  trace: SopTrace,
): SopEvalResult {
  const changedFiles = normalizedFiles(trace.changedFiles, predicate.includeGlobs);
  if (!isApplicableDocsOnlyTrace(trace.changedFiles, changedFiles, predicate.includeGlobs)) {
    return { ruleId, status: 'pass' };
  }

  const classifier = trace.commands.find(
    (command) => commandSucceeded(command) && commandMatches(command.command, predicate.classifierMatch),
  );
  if (!classifier) {
    return evaluateMissingClassifier(ruleId, stageId, kind, severity, predicate, trace, changedFiles);
  }

  const decision = parseDecision(classifier);
  if (!decision) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'co_creation_docs_lane',
      'co-creation docs classifier output is missing or not parseable',
      `command:${classifier.command}`,
    );
  }

  const decisionFiles = normalizedFiles(decision.changedFiles, predicate.includeGlobs);
  if (!allFilesMatch(decision.changedFiles, predicate.includeGlobs)) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'co_creation_docs_lane',
      'co-creation docs classifier output contains files outside the docs-only scope',
      `classifier:[${decision.changedFiles.join(',')}]`,
    );
  }
  if (!sameFiles(changedFiles, decisionFiles)) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'co_creation_docs_lane',
      'co-creation docs classifier output does not cover the trace changed files',
      `trace:[${changedFiles.join(',')}] classifier:[${decisionFiles.join(',')}]`,
    );
  }

  if (decision.lane !== 'co_creation_docs') {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'co_creation_docs_lane',
      `docs-only trace received unexpected classifier lane=${decision.lane}`,
      `command:${classifier.command}`,
    );
  }

  if (decision.delivery === 'direct_push') {
    const overprocessed = firstMatchingCommand(trace, [predicate.worktreeMatch, predicate.pullRequestMatch]);
    if (overprocessed) {
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'co_creation_docs_lane',
        `classifier returned direct_push but session entered worktree/PR flow: "${overprocessed.command}"`,
        `command:${overprocessed.command}`,
      );
    }
  }

  if (decision.cloudReview === 'skip') {
    const cloud = firstMatchingCommand(trace, [predicate.cloudReviewMatch]);
    if (cloud) {
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'co_creation_docs_lane',
        `classifier returned cloudReview=skip but session triggered cloud review: "${cloud.command}"`,
        `command:${cloud.command}`,
      );
    }
  }

  if (decision.fullGate === 'skip') {
    const fullGate = firstMatchingCommand(trace, [predicate.fullGateMatch]);
    if (fullGate) {
      return violation(
        ruleId,
        stageId,
        kind,
        severity,
        'co_creation_docs_lane',
        `classifier returned fullGate=skip but session ran the full gate: "${fullGate.command}"`,
        `command:${fullGate.command}`,
      );
    }
  }

  return { ruleId, status: 'pass' };
}

function evaluateMissingClassifier(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateCoCreationDocsLane,
  trace: SopTrace,
  changedFiles: readonly string[],
): SopEvalResult {
  const governanceFile = changedFiles.find((path) => matchesAny(path, [...(predicate.classifierRequiredGlobs ?? [])]));
  if (governanceFile) {
    return violation(
      ruleId,
      stageId,
      kind,
      severity,
      'co_creation_docs_lane',
      `governance docs require classifier evidence before delivery: "${governanceFile}"`,
      `changed:[${changedFiles.join(',')}] governance:${governanceFile}`,
    );
  }
  const heavyCarrier = firstMatchingCommand(trace, [
    predicate.worktreeMatch,
    predicate.pullRequestMatch,
    predicate.cloudReviewMatch,
    predicate.fullGateMatch,
  ]);
  if (!heavyCarrier) return { ruleId, status: 'pass' };
  return violation(
    ruleId,
    stageId,
    kind,
    severity,
    'co_creation_docs_lane',
    `docs-only changes entered a heavy carrier without classifier evidence: "${heavyCarrier.command}"`,
    `changed:[${changedFiles.join(',')}] command:${heavyCarrier.command}`,
  );
}

function isApplicableDocsOnlyTrace(
  traceFiles: readonly string[],
  normalizedTraceFiles: readonly string[],
  includeGlobs: readonly string[],
): boolean {
  return normalizedTraceFiles.length > 0 && allFilesMatch(traceFiles, includeGlobs);
}

function normalizedFiles(paths: readonly string[], includeGlobs: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeLanePath).filter((path) => matchesAny(path, [...includeGlobs])))].sort();
}

function allFilesMatch(paths: readonly string[], includeGlobs: readonly string[]): boolean {
  return paths.every((path) => matchesAny(normalizeLanePath(path), [...includeGlobs]));
}

function normalizeLanePath(path: string): string {
  return pathPosix.normalize(path.trim().replaceAll('\\', '/')).replace(/^\.\//, '');
}

function parseDecision(command: SopTraceCommand): CoCreationDocsDecision | undefined {
  const summary = command.summary?.coCreationDocsLane ?? command.summary;
  if (isDecision(summary)) return summary;

  const stdout = command.stdout?.trim();
  if (!stdout) return undefined;
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return isDecision(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isDecision(value: unknown): value is CoCreationDocsDecision {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.lane === 'co_creation_docs' || record.lane === 'regular_development') &&
    (record.delivery === 'direct_push' || record.delivery === 'pull_request') &&
    (record.cloudReview === 'required' || record.cloudReview === 'skip') &&
    (record.fullGate === 'required' || record.fullGate === 'skip') &&
    Array.isArray(record.changedFiles) &&
    record.changedFiles.every((path) => typeof path === 'string')
  );
}

function commandSucceeded(command: SopTraceCommand): boolean {
  return command.exitCode === undefined || command.exitCode === 0;
}

function commandMatches(command: string, expression: string): boolean {
  return matchesCommandPattern(command, expression);
}

function firstMatchingCommand(trace: SopTrace, expressions: readonly string[]): SopTraceCommand | undefined {
  // Attempts count as workflow friction even when the command fails, so do not filter by exitCode here.
  return trace.commands.find((command) =>
    expressions.some((expression) => commandMatches(command.command, expression)),
  );
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
