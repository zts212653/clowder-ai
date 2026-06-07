import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './domain/eval-domain-registry.js';

export interface LegacyCleanupStatus {
  status: 'not_checked' | 'dry_run_ready' | 'redirected' | 'disabled';
  reportRef?: string;
}

export interface EvalCatInvocationInput {
  domain: EvalDomainRegistryEntry;
  trendRefs: string[];
  verdictRefs: string[];
  legacyCleanup: LegacyCleanupStatus;
}

export interface EvalCatInvocationPacket {
  domainId: EvalDomainRegistryEntry['domainId'];
  targetThreadId: string;
  evalCat: EvalDomainRegistryEntry['evalCat'];
  instructions: string;
  context: {
    trendRefs: string[];
    verdictRefs: string[];
    sourceAdapter: EvalDomainRegistryEntry['sourceAdapter'];
    legacyScheduledTaskIds: string[];
    fixtures: EvalDomainRegistryEntry['fixtures'];
    legacyCleanup: LegacyCleanupStatus;
    sla: EvalDomainRegistryEntry['sla'];
  };
}

const DOMAIN_INSTRUCTIONS: Record<EvalDomainRegistryEntry['domainId'], string> = {
  'eval:a2a':
    'Enter the eval:a2a domain thread, load the longitudinal context, compare day-over-day trends, and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset. Include legacy scheduled task status in the analysis to prevent duplicate triggers.',
  'eval:memory':
    'Enter the eval:memory domain thread, load recall quality and library health trends, compare day-over-day recall metrics (MRR, precision@K, abandonment) and library health indicators (orphan edges, stale anchors, verification debt), and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset.',
  'eval:sop':
    'Enter the eval:sop domain thread, load the SOP definition for the target domain, trace session commands / env / git state against machine-checkable predicates, and produce a per-rule violation report. Hand off actionable violations to the rule owner (skill maintainer) with trace evidence.',
  'eval:capability-wakeup':
    'Enter the eval:capability-wakeup domain thread, prioritize workspace-navigator first, compare weekly miss-rate trends across capability wakeup traces, separate cognitive / behavioral / attention-dilution misses, and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset.',
  'eval:task-outcome':
    'Enter the eval:task-outcome domain thread. Analyze task outcome episodes: review permission cancel signals (tool_name, reason, frequency), magic word triggers (word, context), and A1 world truth events (merge/revert). Bind signals to episodes, compare weekly cancel rates and verdict distributions, identify patterns (per-cat, per-task-type), and produce a verdict handoff packet. Verdict is categorical (success/corrected_success/needs_investigation/harness_fix_needed/routing_failure/taste_mismatch/abandoned), not a score. Proxy signals navigate, they do not judge.',
};

function domainInstructions(domainId: EvalDomainRegistryEntry['domainId']): string {
  return DOMAIN_INSTRUCTIONS[domainId];
}

export function buildEvalCatInvocation(input: EvalCatInvocationInput): EvalCatInvocationPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  return {
    domainId: domain.domainId,
    targetThreadId: domain.systemThreadId,
    evalCat: domain.evalCat,
    instructions: domainInstructions(domain.domainId),
    context: {
      trendRefs: input.trendRefs,
      verdictRefs: input.verdictRefs,
      sourceAdapter: domain.sourceAdapter,
      legacyScheduledTaskIds: domain.legacyScheduledTaskIds,
      fixtures: domain.fixtures,
      legacyCleanup: input.legacyCleanup,
      sla: domain.sla,
    },
  };
}
