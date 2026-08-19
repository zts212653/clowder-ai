import { conventionGraphDomainsForPaths } from '../convention-graph-surfaces.js';
import {
  canonicalizePathForGlobs,
  hasLivePreviewForOpportunity,
  matchesAny,
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
import {
  capabilityUsageEvidence,
  firstMatchedChangeTimestamp,
  firstMatchedChangeTimestampsByDomain,
  latestTimestamp,
} from './eval-capability-wakeup-usage-evidence.js';

export { capabilityUsageEvidence } from './eval-capability-wakeup-usage-evidence.js';

export function evaluateCapabilityWakeupTrace(
  trace: CapabilityTrace,
  rules: CapabilityWakeupRule[],
): CapabilityWakeupTrial[] {
  const trials: CapabilityWakeupTrial[] = [];
  for (let index = 0; index < trace.invocations.length; index += 1) {
    const previous = trace.invocations[index - 1];
    const current = trace.invocations[index];
    if (!current) continue;
    const next = trace.invocations[index + 1];
    for (const rule of rules) {
      const trial = evaluateRule(trace, previous, current, next, rule);
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

function evaluateRule(
  trace: CapabilityTrace,
  previous: CapabilityInvocationTrace | undefined,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule,
): CapabilityWakeupTrial | null {
  switch (rule.predicate.type) {
    case 'file_change_then_capability':
      return evaluateFileChangePredicate(
        trace,
        previous,
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
  previous: CapabilityInvocationTrace | undefined,
  current: CapabilityInvocationTrace,
  next: CapabilityInvocationTrace | undefined,
  rule: CapabilityWakeupRule & { predicate: FileChangeThenCapabilityPredicate },
): CapabilityWakeupTrial | null {
  const excludeGlobs = rule.predicate.excludeGlobs ? [...rule.predicate.excludeGlobs] : [];
  const matchedFiles = current.changedFiles
    .map((path) => canonicalizePathForGlobs(path, rule.predicate.includeGlobs, excludeGlobs))
    .filter((path) => matchesAny(path, rule.predicate.includeGlobs) && !matchesAny(path, excludeGlobs));
  if (matchedFiles.length === 0) return null;

  const evidence = [`changed:${matchedFiles.join(',')}`];
  if (rule.predicate.requirePathMention && !mentionsAnyPath(collectWindowText(current, next), matchedFiles)) {
    return null;
  }
  if (rule.predicate.requireLivePreview && !hasLivePreviewForOpportunity(trace, current, next)) {
    return makeTrial(trace, current, next, rule, 'false_positive', evidence, ['preview_live_port=false']);
  }

  const requiredConventionDomains =
    rule.capability === 'convention-graph-discovery' ? conventionGraphDomainsForPaths(matchedFiles) : [];
  const beforeTimestampByConventionDomain =
    rule.predicate.evidenceWindow === 'pre_change' && requiredConventionDomains.length > 0
      ? firstMatchedChangeTimestampsByDomain(
          current,
          matchedFiles,
          rule.predicate.includeGlobs,
          excludeGlobs,
          requiredConventionDomains,
        )
      : undefined;
  const beforeTimestamp = beforeTimestampByConventionDomain
    ? latestTimestamp(Object.values(beforeTimestampByConventionDomain))
    : firstMatchedChangeTimestamp(current, matchedFiles, rule.predicate.includeGlobs, excludeGlobs);
  const usedEvidence = capabilityUsageEvidence(trace, current, next, rule.capability, matchedFiles, {
    previous,
    evidenceWindow: rule.predicate.evidenceWindow,
    beforeTimestamp,
    beforeTimestampByConventionDomain,
  });
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
