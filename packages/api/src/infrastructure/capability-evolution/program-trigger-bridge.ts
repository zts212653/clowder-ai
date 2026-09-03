import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type EvalDomainRegistryEntry,
  parseEvalDomainRegistryFile,
} from '../harness-eval/domain/eval-domain-registry.js';
import {
  dispatchEvalDomainTrigger,
  type EvalDomainTriggerDispatchResult,
} from '../harness-eval/domain/eval-domain-trigger-dispatch.js';
import type { IEvalDomainTriggerStore } from '../harness-eval/domain/eval-domain-trigger-store.js';
import { buildEvalCatInvocation } from '../harness-eval/eval-cat-invocation.js';
import { computeNextCronFire } from '../harness-eval/hub/eval-hub-read-model-helpers.js';
import type { ExecuteContext, ScheduleInvokeTrigger } from '../scheduler/types.js';

const DOMAIN_ID = 'eval:capability-evolution';
const DOMAIN_FILENAME = 'eval-capability-evolution.yaml';

function loadDomain(harnessFeedbackRoot: string): EvalDomainRegistryEntry {
  const domain = parseEvalDomainRegistryFile(
    parseYaml(readFileSync(join(harnessFeedbackRoot, 'eval-domains', DOMAIN_FILENAME), 'utf8')),
  );
  if (domain.domainId !== DOMAIN_ID || domain.enabled === false || domain.triggerPolicy.mode !== 'threshold_or_time') {
    throw new Error('F311 capability-evolution trigger domain is not registered and enabled in F192');
  }
  return domain;
}

export function createEvolutionProgramTriggerRegistrationProvider(input: {
  harnessFeedbackRoot: string;
  now?: () => Date;
}) {
  try {
    const domain = loadDomain(input.harnessFeedbackRoot);
    const policy = domain.triggerPolicy;
    if (policy.mode !== 'threshold_or_time') {
      return () => undefined;
    }
    const registration = {
      status: 'registered' as const,
      registrationRef: { ownerFeatureId: 'F192', ownerStateRef: `eval-domain:${domain.domainId}` },
      domainId: domain.domainId,
      channels: ['event', 'quota', 'time'] as const,
      policy,
    };
    const now = input.now ?? (() => new Date());
    return () => ({
      ...registration,
      nextEvaluationAt: computeNextCronFire(domain.frequency, now()).toISOString(),
    });
  } catch {
    return () => undefined;
  }
}

export function loadEvolutionProgramTriggerRegistration(input: { harnessFeedbackRoot: string; now?: Date }) {
  const fixedNow = input.now;
  return createEvolutionProgramTriggerRegistrationProvider({
    harnessFeedbackRoot: input.harnessFeedbackRoot,
    ...(fixedNow ? { now: () => fixedNow } : {}),
  })();
}

interface DispatchEvolutionProgramThresholdTriggerInput {
  harnessFeedbackRoot: string;
  programEventId: string;
  previousConnectedOwnerSurfaces: number;
  currentConnectedOwnerSurfaces: number;
  store?: IEvalDomainTriggerStore;
  deliver?: ExecuteContext['deliver'];
  invokeTrigger?: ScheduleInvokeTrigger;
  defaultUserId?: string;
  nowMs?: number;
  wiredPublishDomains?: ReadonlySet<EvalDomainRegistryEntry['domainId']>;
}

export async function dispatchEvolutionProgramThresholdTrigger(
  input: DispatchEvolutionProgramThresholdTriggerInput,
): Promise<EvalDomainTriggerDispatchResult> {
  const domain = loadDomain(input.harnessFeedbackRoot);
  const policy = domain.triggerPolicy;
  if (policy.mode !== 'threshold_or_time') {
    throw new Error('capability-evolution requires threshold_or_time');
  }
  const invocation = buildEvalCatInvocation(
    { domain, trendRefs: [], verdictRefs: [], legacyCleanup: { status: 'disabled' } },
    { wiredPublishDomains: input.wiredPublishDomains },
  );
  return dispatchEvalDomainTrigger({
    domain,
    invocation,
    channel: 'threshold_event',
    event: {
      eventId: input.programEventId,
      eventSource: policy.eventSource,
      counter: policy.threshold.counter,
      previousValue: input.previousConnectedOwnerSurfaces,
      currentValue: input.currentConnectedOwnerSurfaces,
    },
    triggerReason: `Capability Evolution owner surfaces ${input.previousConnectedOwnerSurfaces}→${input.currentConnectedOwnerSurfaces}`,
    store: input.store,
    deliver: input.deliver,
    invokeTrigger: input.invokeTrigger,
    defaultUserId: input.defaultUserId,
    nowMs: input.nowMs,
  });
}

/**
 * Opens an evaluation round through F192's own time channel.
 *
 * The Program never decides that a round has opened. It asks F192, and F192's window/dedupe policy
 * answers; the returned `dedupeKey` is F192's identity for that dispatch, which is what lets the
 * Program's `evaluation_triggered` receipt name something F192 can resolve instead of an id F311
 * made up.
 */
export async function dispatchEvolutionProgramRoundTrigger(input: {
  harnessFeedbackRoot: string;
  programId: string;
  store?: IEvalDomainTriggerStore;
  deliver?: DispatchEvolutionProgramThresholdTriggerInput['deliver'];
  invokeTrigger?: DispatchEvolutionProgramThresholdTriggerInput['invokeTrigger'];
  defaultUserId?: string;
  wiredPublishDomains?: ReadonlySet<string>;
  nowMs?: number;
}): Promise<EvalDomainTriggerDispatchResult> {
  const domain = loadDomain(input.harnessFeedbackRoot);
  const invocation = buildEvalCatInvocation(
    { domain, trendRefs: [], verdictRefs: [], legacyCleanup: { status: 'disabled' } },
    { wiredPublishDomains: input.wiredPublishDomains },
  );
  return dispatchEvalDomainTrigger({
    domain,
    invocation,
    channel: 'time',
    triggerReason: `Capability Evolution evaluation round for ${input.programId}`,
    store: input.store,
    deliver: input.deliver,
    invokeTrigger: input.invokeTrigger,
    defaultUserId: input.defaultUserId,
    nowMs: input.nowMs,
  });
}
