import type {
  CapabilityMissLabel,
  CapabilityName,
  ClassifiedCapabilityWakeupTrial,
} from './eval-capability-wakeup-types.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './eval-domain-registry.js';
import {
  assertCanCrossThreadHandoff,
  parseVerdictHandoffPacket,
  type VerdictHandoffPacket,
} from './verdict-handoff.js';

export function buildCapabilityWakeupVerdictHandoff(input: {
  domain: EvalDomainRegistryEntry;
  capability: CapabilityName;
  trials: ClassifiedCapabilityWakeupTrial[];
  createdAt?: string;
}): VerdictHandoffPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  if (domain.domainId !== 'eval:capability-wakeup') {
    throw new Error(`Capability wakeup verdict adapter requires eval:capability-wakeup domain, got ${domain.domainId}`);
  }

  const relevant = input.trials.filter((trial) => trial.capability === input.capability);
  if (relevant.length === 0) throw new Error(`No trials recorded for capability ${input.capability}`);

  const negatives = relevant.filter((trial) => trial.outcome === 'negative');
  const misses = relevant.filter((trial) => trial.outcome === 'miss');
  const falsePositives = relevant.filter((trial) => trial.outcome === 'false_positive');
  const denominator = misses.length + negatives.length;
  const missRate = denominator === 0 ? 0 : misses.length / denominator;
  const hasMisses = misses.length > 0;
  const dominant = hasMisses ? dominantMissLabel(misses) : 'unclassified';
  const verdict = resolveVerdict(missRate, dominant);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const packet = parseVerdictHandoffPacket({
    id: `vhp_eval_capability_wakeup_${slug(createdAt)}_${slug(input.capability)}`,
    domainId: domain.domainId,
    createdAt,
    phenomenon: `${input.capability} miss rate ${(missRate * 100).toFixed(0)}% (${misses.length}/${denominator})`,
    harnessUnderEval: {
      featureId: domain.handoffTargetResolver.featureId,
      componentId: input.capability,
      name: input.capability,
    },
    evidencePacket: {
      snapshotRefs: [`snapshot:capability-wakeup/${slug(input.capability)}`],
      attributionRefs:
        misses.length > 0
          ? misses.map((trial) => `attribution:${trial.ruleId}:${trial.window.currentInvocationId}`)
          : ['attribution:no-finding'],
      metricRefs: ['miss_rate', 'miss_count', 'negative_count', 'false_positive_count'],
      sampleTraceRefs: relevant
        .map((trial) => `session:${trial.sessionId}/invocation:${trial.window.currentInvocationId}`)
        .slice(0, 5) || ['session:unknown'],
    },
    dailyTrend: {
      window: `${domain.sla.reevalWithinHours}h`,
      current: {
        miss_rate: missRate,
        miss_count: misses.length,
        negative_count: negatives.length,
        false_positive_count: falsePositives.length,
      },
      baseline: {},
      threshold: {},
      direction: verdict === 'keep_observe' ? 'flat' : 'regressed',
    },
    rootCauseHypothesis: {
      summary: hasMisses
        ? rootCauseSummary(input.capability, dominant)
        : `No current evidence that ${input.capability} needs a fix/build decision.`,
      confidence: hasMisses ? (misses.length > 1 ? 'high' : misses.length === 1 ? 'medium' : 'low') : 'medium',
      alternatives: hasMisses
        ? misses.map((trial) => trial.opportunityEvidence[0] ?? `rule:${trial.ruleId}`).slice(0, 5)
        : ['Current window contains only successful or false-positive trials.'],
    },
    verdict,
    ...(verdict === 'build' || verdict === 'delete_sunset' ? { governance: { cvoAcceptRequired: true } } : {}),
    ownerAsk: {
      targetFeatureId: domain.handoffTargetResolver.featureId,
      targetOwnerCatId: domain.handoffTargetResolver.ownerCatId,
      requestedAction: hasMisses
        ? ownerAskFor(input.capability, dominant)
        : 'No action required; keep observing the next scheduled eval.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: new Date(Date.parse(createdAt) + domain.sla.reevalWithinHours * 3_600_000).toISOString(),
      closureCondition: `next eval lowers ${input.capability} miss rate below threshold`,
    },
    counterarguments: [
      'Small sample sizes can overstate dominant root cause; keep collecting weekly traces before changing tier policy.',
    ],
  });

  const handoffDecision = assertCanCrossThreadHandoff(packet);
  if (!handoffDecision.ok) {
    throw new Error(handoffDecision.reason ?? 'capability wakeup verdict handoff packet is incomplete');
  }
  return packet;
}

function dominantMissLabel(trials: ClassifiedCapabilityWakeupTrial[]): CapabilityMissLabel {
  const counts = new Map<CapabilityMissLabel, number>();
  for (const trial of trials) {
    counts.set(trial.label, (counts.get(trial.label) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? 'unclassified';
}

function resolveVerdict(missRate: number, dominant: CapabilityMissLabel): VerdictHandoffPacket['verdict'] {
  if (missRate < 0.05) return 'keep_observe';
  if (dominant === 'behavioral') return 'build';
  return 'fix';
}

function rootCauseSummary(capability: CapabilityName, label: CapabilityMissLabel): string {
  if (label === 'behavioral') return `${capability}: knew-how proven but zero-friction default kept winning`;
  if (label === 'attention_dilution') return `${capability}: how-to existed but attention drifted away at action time`;
  if (label === 'reachability_doubt')
    return `${capability}: the session expressed first-person doubt about reachability or invocation path`;
  if (label === 'cognitive')
    return `${capability}: capability or invocation path never entered the active reasoning path`;
  return `${capability}: insufficient evidence to separate cognitive vs attention root cause`;
}

function ownerAskFor(capability: CapabilityName, label: CapabilityMissLabel): string {
  if (label === 'behavioral')
    return `Design a forcing-function hook for ${capability} using the weekly miss-rate data.`;
  if (label === 'attention_dilution')
    return `Prototype a just-in-time reminder for ${capability} and compare it against the current advisory-only flow.`;
  if (label === 'reachability_doubt')
    return `Tighten reachability/how-to guidance for ${capability} in the ref and skill surfaces, then rerun eval.`;
  return `Add or sharpen how-to guidance for ${capability} in the ref/skill surfaces, then rerun eval.`;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
