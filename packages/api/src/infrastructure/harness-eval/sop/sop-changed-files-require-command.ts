import { canonicalizePathForGlobs, matchesAny } from '../capability-wakeup/eval-capability-wakeup-trials-support.js';
import {
  type ConventionGraphDomainId,
  conventionGraphCommandCoverageKeys,
  conventionGraphCommandHasFreshResults,
  conventionGraphCoverageKeysForPaths,
  conventionGraphDomainFromCommand,
  conventionGraphDomainsForPaths,
  conventionGraphPathsForDomain,
} from '../convention-graph-surfaces.js';
import { matchesCommandPattern } from './sop-command-pattern.js';
import type {
  PredicateChangedFilesRequireCommand,
  SopEvalResult,
  SopRuleKind,
  SopSeverity,
} from './sop-predicate-types.js';
import { violation } from './sop-predicate-types.js';
import type { SopTrace, SopTraceCommand } from './sop-trace-adapter.js';

export function evaluateChangedFilesRequireCommand(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  predicate: PredicateChangedFilesRequireCommand,
  trace: SopTrace,
): SopEvalResult {
  const includeGlobs = [...predicate.includeGlobs];
  const excludeGlobs = [...(predicate.excludeGlobs ?? [])];
  const changedFiles = trace.changedFiles;
  const matchedFiles = changedFiles
    .map((path) => canonicalizePathForGlobs(path, includeGlobs, excludeGlobs))
    .filter((path) => matchesAny(path, includeGlobs) && !matchesAny(path, excludeGlobs));

  if (matchedFiles.length === 0) {
    return { ruleId, status: 'pass' };
  }

  const matchedCommands = trace.commands.filter(
    (c) => matchesCommandPattern(c.command, predicate.mustMatch) && commandSucceeded(c),
  );

  const requiredDomains = conventionGraphDomainsForPaths(matchedFiles);
  if (requiredDomains.length > 0) {
    return evaluateConventionGraphEvidence(ruleId, stageId, kind, severity, trace, matchedFiles, matchedCommands);
  }

  if (matchedCommands.length > 0) {
    return { ruleId, status: 'pass' };
  }

  return violation(
    ruleId,
    stageId,
    kind,
    severity,
    'changed_files_require_command',
    `changed convention-surface files require successful command pattern "${predicate.mustMatch}"`,
    `changed:[${[...new Set(matchedFiles)].join(',')}]`,
  );
}

function evaluateConventionGraphEvidence(
  ruleId: string,
  stageId: string,
  kind: SopRuleKind,
  severity: SopSeverity,
  trace: SopTrace,
  matchedFiles: readonly string[],
  matchedCommands: readonly SopTraceCommand[],
): SopEvalResult {
  const requiredDomains = conventionGraphDomainsForPaths(matchedFiles);
  const matchedChangeEvents = conventionGraphChangeEventsForFiles(trace, matchedFiles);
  const coveredDomains = new Set<ConventionGraphDomainId>();
  for (const domain of requiredDomains) {
    if (conventionGraphChangedPathsCoveredBeforeEdit(domain, matchedFiles, matchedChangeEvents, matchedCommands)) {
      coveredDomains.add(domain);
    }
  }

  const missingDomains = requiredDomains.filter((domain) => !coveredDomains.has(domain));
  if (missingDomains.length === 0) {
    return { ruleId, status: 'pass' };
  }

  return violation(
    ruleId,
    stageId,
    kind,
    severity,
    'changed_files_require_command',
    `changed convention-surface files require pre-edit successful fresh convention-graph:code-consumers for domain(s): ${missingDomains.join(',')}`,
    `changed:[${[...new Set(matchedFiles)].join(',')}] missing_pre_edit_fresh_domains:[${missingDomains.join(',')}]`,
  );
}

function commandSucceeded(command: SopTraceCommand): boolean {
  return command.exitCode === undefined ? true : command.exitCode === 0;
}

type SopTraceChangedFileEvent = SopTrace['changedFileEvents'][number];

function conventionGraphChangeEventsForFiles(
  trace: SopTrace,
  matchedFiles: readonly string[],
): SopTraceChangedFileEvent[] {
  const matched = new Set(matchedFiles);
  return (trace.changedFileEvents ?? [])
    .map((event) => ({ ...event, path: canonicalizePathForGlobs(event.path, [...matched], []) }))
    .filter((event) => matched.has(event.path));
}

function conventionGraphChangedPathsCoveredBeforeEdit(
  domain: ConventionGraphDomainId,
  matchedFiles: readonly string[],
  events: readonly SopTraceChangedFileEvent[],
  commands: readonly SopTraceCommand[],
): boolean {
  const domainPaths = conventionGraphPathsForDomain(matchedFiles, domain);
  if (domainPaths.length === 0) return false;
  const firstChangeByPath = firstConventionGraphChangeByPath(events);
  return domainPaths.every((path) => {
    const firstChange = firstChangeByPath.get(path);
    if (!firstChange) return false;
    const expectedKeys = conventionGraphCoverageKeysForPaths([path], domain);
    if (expectedKeys.length === 0) return false;
    return commands.some((command) =>
      conventionGraphCommandCoversPathBeforeEdit(command, domain, expectedKeys, firstChange),
    );
  });
}

function firstConventionGraphChangeByPath(
  events: readonly SopTraceChangedFileEvent[],
): Map<string, SopTraceChangedFileEvent> {
  const byPath = new Map<string, SopTraceChangedFileEvent>();
  for (const event of [...events].sort((a, b) => compareOrder(a, b))) {
    if (!byPath.has(event.path)) byPath.set(event.path, event);
  }
  return byPath;
}

function conventionGraphCommandCoversPathBeforeEdit(
  command: SopTraceCommand,
  domain: ConventionGraphDomainId,
  expectedKeys: readonly string[],
  firstChange: SopTraceChangedFileEvent,
): boolean {
  if (conventionGraphDomainFromCommand(command.command) !== domain) return false;
  if (!conventionGraphCommandHasFreshResults(command)) return false;
  if (!commandHappenedBefore(command, firstChange)) return false;
  const commandKeys = new Set(conventionGraphCommandCoverageKeys(command, domain));
  return expectedKeys.some((key) => commandKeys.has(key));
}

function commandHappenedBefore(command: SopTraceCommand, change: SopTraceChangedFileEvent): boolean {
  if (command.eventNo !== undefined && change.eventNo !== undefined) {
    return command.eventNo < change.eventNo;
  }
  if (command.timestamp !== undefined && change.timestamp !== undefined) {
    return command.timestamp < change.timestamp;
  }
  return false;
}

function compareOrder(left: { eventNo?: number; timestamp?: number }, right: { eventNo?: number; timestamp?: number }) {
  if (left.eventNo !== undefined && right.eventNo !== undefined) return left.eventNo - right.eventNo;
  if (left.timestamp !== undefined && right.timestamp !== undefined) return left.timestamp - right.timestamp;
  if (left.eventNo !== undefined) return -1;
  if (right.eventNo !== undefined) return 1;
  return 0;
}
