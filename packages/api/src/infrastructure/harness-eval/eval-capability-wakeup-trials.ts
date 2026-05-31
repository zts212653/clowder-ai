import {
  buildEvidenceScope,
  canonicalizePathForGlobs,
  collectUsageCandidates,
  hasLivePreviewForOpportunity,
  matchesAny,
  matchesScope,
} from './eval-capability-wakeup-trials-support.js';
import type {
  CapabilityInvocationTrace,
  CapabilityName,
  CapabilityTrace,
  CapabilityTrialOutcome,
  CapabilityWakeupRule,
  CapabilityWakeupTrial,
  FileChangeThenCapabilityPredicate,
  MultiMsgTextVolumeThresholdPredicate,
  ScenarioThenCapabilityPredicate,
  TextPatternThenCapabilityPredicate,
} from './eval-capability-wakeup-types.js';

export function evaluateCapabilityWakeupTrace(
  trace: CapabilityTrace,
  rules: CapabilityWakeupRule[],
): CapabilityWakeupTrial[] {
  const trials: CapabilityWakeupTrial[] = [];
  for (let index = 0; index < trace.invocations.length; index += 1) {
    const current = trace.invocations[index]!;
    const next = trace.invocations[index + 1];
    for (const rule of rules) {
      const trial = evaluateRule(trace, current, next, rule);
      if (trial) trials.push(trial);
    }
  }
  return trials;
}

export function nextInvocation(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
): CapabilityInvocationTrace | undefined {
  return trace.invocations[current.invocationIndex + 1];
}

export function collectWindowText(
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
): string[] {
  return [...current.textEvents, ...(next?.textEvents ?? [])].map((event) => event.content);
}

export function capabilityUsageEvidence(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  capability: CapabilityName,
  matchedPaths: string[] = [],
): string[] {
  const evidence: string[] = [];
  const scope = buildEvidenceScope(trace, current, next);
  for (const candidate of collectUsageCandidates(trace, current, next)) {
    if (!matchesScope(candidate, scope)) {
      continue;
    }
    if (candidate.capability !== capability || !candidate.successful) continue;
    if (
      capability === 'workspace-navigator' &&
      !workspaceNavigationMatches(candidate, matchedPaths, trace.worktreeId)
    ) {
      continue;
    }
    evidence.push(`${candidate.source}:${candidate.sourceId}`);
  }

  return [...new Set(evidence)];
}

export function detectZeroFrictionDefault(
  capability: CapabilityName,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
): boolean {
  const texts = collectWindowText(current, next);
  const combined = texts.join('\n');
  if (capability === 'rich-messaging') return combined.trim().length > 0;
  if (capability === 'workspace-navigator') {
    return current.referencedPaths.some((path) => combined.includes(path));
  }
  if (capability === 'browser-preview') {
    return /localhost:\d+|http:\/\/localhost|preview|browser/i.test(combined);
  }
  return combined.trim().length > 0;
}

function workspaceNavigationMatches(
  candidate: { action?: string; path?: string; worktreeId?: string },
  matchedPaths: string[],
  worktreeId: string | undefined,
): boolean {
  const action = candidate.action;
  if (typeof action === 'string' && action !== 'open' && action !== 'reveal') return false;
  const path = candidate.path;
  if (typeof path === 'string') {
    if (!matchedPaths.includes(path)) return false;
  } else if (matchedPaths.length > 0) {
    return false;
  }
  if (worktreeId && candidate.worktreeId !== worktreeId) return false;
  return true;
}

function evaluateRule(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule,
): CapabilityWakeupTrial | null {
  switch (rule.predicate.type) {
    case 'file_change_then_capability':
      return evaluateFileChangePredicate(
        trace,
        current,
        next,
        rule as CapabilityWakeupRule & { predicate: FileChangeThenCapabilityPredicate },
      );
    case 'multi_msg_text_volume_threshold':
      return evaluateTextVolumePredicate(
        trace,
        current,
        next,
        rule as CapabilityWakeupRule & { predicate: MultiMsgTextVolumeThresholdPredicate },
      );
    case 'text_pattern_then_capability':
      return evaluateTextPatternPredicate(
        trace,
        current,
        next,
        rule as CapabilityWakeupRule & { predicate: TextPatternThenCapabilityPredicate },
      );
    case 'scenario_then_capability_predicate':
      return evaluateScenarioPredicate(
        trace,
        current,
        next,
        rule as CapabilityWakeupRule & { predicate: ScenarioThenCapabilityPredicate },
      );
    default:
      return null;
  }
}

function evaluateFileChangePredicate(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule & { predicate: FileChangeThenCapabilityPredicate },
): CapabilityWakeupTrial | null {
  const matchedFiles = current.changedFiles
    .map((path) => canonicalizePathForGlobs(path, rule.predicate.includeGlobs, rule.predicate.excludeGlobs ?? []))
    .filter(
      (path) => matchesAny(path, rule.predicate.includeGlobs) && !matchesAny(path, rule.predicate.excludeGlobs ?? []),
    );
  if (matchedFiles.length === 0) return null;

  const evidence = [`changed:${matchedFiles.join(',')}`];
  if (rule.predicate.requirePathMention && !mentionsAnyPath(collectWindowText(current, next), matchedFiles)) {
    return null;
  }
  if (rule.predicate.requireLivePreview && !hasLivePreviewForOpportunity(trace, current, next)) {
    return makeTrial(trace, current, next, rule, 'false_positive', evidence, ['preview_live_port=false']);
  }

  const usedEvidence = capabilityUsageEvidence(trace, current, next, rule.capability, matchedFiles);
  return makeTrial(trace, current, next, rule, usedEvidence.length > 0 ? 'negative' : 'miss', evidence, usedEvidence);
}

function evaluateTextVolumePredicate(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule & { predicate: MultiMsgTextVolumeThresholdPredicate },
): CapabilityWakeupTrial | null {
  const tokenCount = current.textEvents.reduce((sum, event) => sum + event.tokenCount, 0);
  const structuredSignals = current.textEvents.reduce((sum, event) => sum + event.structuredSignalCount, 0);
  if (tokenCount < rule.predicate.minTokenCount || structuredSignals < rule.predicate.minStructuredSignals) {
    return null;
  }

  const usedEvidence = capabilityUsageEvidence(trace, current, next, rule.capability);
  return makeTrial(
    trace,
    current,
    next,
    rule,
    usedEvidence.length > 0 ? 'negative' : 'miss',
    [`token_count=${tokenCount}`, `structured_signals=${structuredSignals}`],
    usedEvidence,
  );
}

function evaluateTextPatternPredicate(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule & { predicate: TextPatternThenCapabilityPredicate },
): CapabilityWakeupTrial | null {
  const texts = current.textEvents.map((event) => event.content);
  const matched = rule.predicate.patterns.every((pattern) => texts.some((text) => new RegExp(pattern, 'i').test(text)));
  if (!matched) return null;

  const usedEvidence = capabilityUsageEvidence(trace, current, next, rule.capability);
  return makeTrial(
    trace,
    current,
    next,
    rule,
    usedEvidence.length > 0 ? 'negative' : 'miss',
    [`patterns:${rule.predicate.patterns.join('|')}`],
    usedEvidence,
  );
}

function evaluateScenarioPredicate(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule & { predicate: ScenarioThenCapabilityPredicate },
): CapabilityWakeupTrial | null {
  if (!(rule.predicate.scenarioKey in current.scenarioDetections)) return null;
  if (!current.scenarioDetections[rule.predicate.scenarioKey]) {
    return makeTrial(
      trace,
      current,
      next,
      rule,
      'false_positive',
      [`scenario:${rule.predicate.scenarioKey}=false`],
      [],
    );
  }

  const usedEvidence = capabilityUsageEvidence(trace, current, next, rule.capability);
  return makeTrial(
    trace,
    current,
    next,
    rule,
    usedEvidence.length > 0 ? 'negative' : 'miss',
    [`scenario:${rule.predicate.scenarioKey}=true`],
    usedEvidence,
  );
}

function makeTrial(
  trace: CapabilityTrace,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule,
  outcome: CapabilityTrialOutcome,
  opportunityEvidence: string[],
  usageEvidence: string[],
): CapabilityWakeupTrial {
  return {
    ruleId: rule.id,
    capability: rule.capability,
    sessionId: trace.sessionId,
    threadId: trace.threadId,
    catId: trace.catId,
    ...(trace.family ? { family: trace.family } : {}),
    window: {
      currentInvocationId: current.invocationId,
      ...(next ? { nextInvocationId: next.invocationId } : {}),
      invocationIndex: current.invocationIndex,
    },
    eventNoSpan: { start: current.eventNoStart, end: next?.eventNoEnd ?? current.eventNoEnd },
    timeSpan: { startMs: current.startTime, endMs: next?.endTime ?? current.endTime },
    outcome,
    zeroFrictionDefault: detectZeroFrictionDefault(rule.capability, current, next),
    opportunityEvidence,
    usageEvidence,
  };
}

function mentionsAnyPath(texts: string[], paths: string[]): boolean {
  return texts.some((text) => paths.some((path) => text.includes(path)));
}
