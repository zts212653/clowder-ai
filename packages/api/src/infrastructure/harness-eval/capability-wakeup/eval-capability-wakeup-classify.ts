import { capabilityUsageEvidence, collectWindowText, nextInvocation } from './eval-capability-wakeup-trials.js';
import {
  CAPABILITY_SKILL_IDS,
  type CapabilityMissLabel,
  type CapabilityName,
  type CapabilityTrace,
  type CapabilityWakeupTrial,
  type ClassifiedCapabilityWakeupTrial,
  DOUBT_PATTERNS,
  HOW_TO_PATH_HINTS,
} from './eval-capability-wakeup-types.js';

export function classifyCapabilityWakeupTrials(
  trace: CapabilityTrace,
  trials: CapabilityWakeupTrial[],
): ClassifiedCapabilityWakeupTrial[] {
  const priorMissesByCapability = new Map<CapabilityName, number>();
  return trials.map((trial) => {
    if (trial.outcome !== 'miss') return { ...trial, label: trial.outcome };

    const current = trace.invocations.find(
      (invocation) => invocation.invocationId === trial.window.currentInvocationId,
    );
    if (!current) return { ...trial, label: 'unclassified' };

    const text = collectWindowText(current, nextInvocation(trace, current)).join('\n');
    if (DOUBT_PATTERNS.some((pattern) => pattern.test(text))) {
      incrementPriorMiss(priorMissesByCapability, trial.capability);
      return { ...trial, label: 'reachability_doubt' };
    }

    const priorUse = hasPriorCapabilityUse(trace, trial.capability, current.invocationIndex);
    const howToEstablished = priorUse || hasHowToProof(trace, trial.capability, current.invocationIndex);
    const priorMissCount = priorMissesByCapability.get(trial.capability) ?? 0;

    if (!howToEstablished) {
      incrementPriorMiss(priorMissesByCapability, trial.capability);
      return { ...trial, label: 'cognitive' };
    }
    if (priorUse && trial.zeroFrictionDefault) {
      incrementPriorMiss(priorMissesByCapability, trial.capability);
      return { ...trial, label: 'behavioral' };
    }
    if (
      hasAttentionAmplifier(
        trace.invocations.length,
        current.invocationIndex,
        current.textEvents.length + current.toolEvents.length,
        priorMissCount,
      )
    ) {
      incrementPriorMiss(priorMissesByCapability, trial.capability);
      return { ...trial, label: 'attention_dilution' };
    }

    incrementPriorMiss(priorMissesByCapability, trial.capability);
    return { ...trial, label: 'unclassified' };
  });
}

function hasPriorCapabilityUse(trace: CapabilityTrace, capability: CapabilityName, beforeIndex: number): boolean {
  return trace.invocations
    .filter((invocation) => invocation.invocationIndex < beforeIndex)
    .some((invocation) => capabilityUsageEvidence(trace, invocation, undefined, capability).length > 0);
}

function hasHowToProof(trace: CapabilityTrace, capability: CapabilityName, atOrBeforeIndex: number): boolean {
  const hints = HOW_TO_PATH_HINTS[capability] ?? [];
  const skills = new Set(CAPABILITY_SKILL_IDS[capability] ?? []);
  return trace.invocations
    .filter((invocation) => invocation.invocationIndex <= atOrBeforeIndex)
    .some((invocation) => {
      if (invocation.skillLoadEvents.some((event) => skills.has(event.skillId))) return true;
      return invocation.referencedPaths.some((path) => hints.some((hint) => path.includes(hint)));
    });
}

function hasAttentionAmplifier(
  totalInvocations: number,
  currentIndex: number,
  unrelatedActivity: number,
  priorMissCount: number,
): boolean {
  const lateInvocation = totalInvocations >= 4 && currentIndex >= Math.floor(totalInvocations * 0.75);
  return lateInvocation || priorMissCount >= 2 || unrelatedActivity >= 3;
}

function incrementPriorMiss(counter: Map<CapabilityName, number>, capability: CapabilityName): void {
  counter.set(capability, (counter.get(capability) ?? 0) + 1);
}
