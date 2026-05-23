import { type EvalDomainRegistryEntry, parseEvalDomainRegistryEntry } from './eval-domain-registry.js';

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
  domainId: 'eval:a2a';
  targetThreadId: string;
  evalCat: EvalDomainRegistryEntry['evalCat'];
  instructions: string;
  context: {
    trendRefs: string[];
    verdictRefs: string[];
    sourceAdapter: EvalDomainRegistryEntry['sourceAdapter'];
    legacyScheduledTaskIds: string[];
    legacyCleanup: LegacyCleanupStatus;
    sla: EvalDomainRegistryEntry['sla'];
  };
}

export function buildEvalCatInvocation(input: EvalCatInvocationInput): EvalCatInvocationPacket {
  const domain = parseEvalDomainRegistryEntry(input.domain);
  return {
    domainId: domain.domainId,
    targetThreadId: domain.systemThreadId,
    evalCat: domain.evalCat,
    instructions:
      'Enter the eval:a2a domain thread, load the longitudinal context, compare day-over-day trends, and produce a verdict handoff packet when evidence supports fix/build/keep/delete_sunset. Include legacy scheduled task status in the analysis to prevent duplicate triggers.',
    context: {
      trendRefs: input.trendRefs,
      verdictRefs: input.verdictRefs,
      sourceAdapter: domain.sourceAdapter,
      legacyScheduledTaskIds: domain.legacyScheduledTaskIds,
      legacyCleanup: input.legacyCleanup,
      sla: domain.sla,
    },
  };
}
