import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { ExecuteContext, ScheduleInvokeTrigger } from '../../scheduler/types.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { type EvalDomainRegistryEntry, parseEvalDomainRegistryFile } from '../domain/eval-domain-registry.js';
import {
  dispatchEvalDomainTrigger,
  type EvalDomainTriggerDispatchResult,
} from '../domain/eval-domain-trigger-dispatch.js';
import type { IEvalDomainTriggerStore } from '../domain/eval-domain-trigger-store.js';
import { buildEvalCatInvocation } from '../eval-cat-invocation.js';
import { ensureEvalDomainThreads } from '../hub/eval-hub-thread-ensure.js';
import type { DesignGateThresholdTransitionProvider } from './design-gate-episode-source-provider.js';

interface ObserveDesignGateThresholdTriggerInput {
  provider: DesignGateThresholdTransitionProvider;
  domain: EvalDomainRegistryEntry;
  store: IEvalDomainTriggerStore;
  deliver?: ExecuteContext['deliver'];
  invokeTrigger?: ScheduleInvokeTrigger;
  defaultUserId?: string;
  wiredPublishDomains?: ReadonlySet<EvalDomainRegistryEntry['domainId']>;
  threadStore?: IThreadStore;
  redis?: import('ioredis').Redis;
  nowMs?: number;
}

export type ObserveDesignGateThresholdTriggerResult = EvalDomainTriggerDispatchResult | { outcome: 'invalid_source' };

export function loadDesignGateThresholdDomain(harnessFeedbackRoot: string): EvalDomainRegistryEntry | undefined {
  const domain = parseEvalDomainRegistryFile(
    parseYaml(readFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-design-gate.yaml'), 'utf8')),
  );
  return domain.enabled === false ? undefined : domain;
}

interface DesignGateSourceWatcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type DesignGateSourceWatchFactory = (
  root: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => DesignGateSourceWatcher;

interface StartDesignGateThresholdObserverInput {
  sourceMapRoot: string;
  observe: () => Promise<{ outcome: string }>;
  logger: {
    info: (details: { outcome: string }, message: string) => void;
    warn: (details: { error: unknown }, message: string) => void;
  };
  watchFactory?: DesignGateSourceWatchFactory;
}

export interface DesignGateThresholdObserverHandle {
  close(): void;
  waitForIdle(): Promise<void>;
}

export function startDesignGateThresholdObserver(
  input: StartDesignGateThresholdObserverInput,
): DesignGateThresholdObserverHandle {
  let closed = false;
  let pending = false;
  let active: Promise<void> | null = null;
  let watcher: DesignGateSourceWatcher | null = null;

  const drain = async () => {
    while (pending && !closed) {
      pending = false;
      try {
        const result = await input.observe();
        input.logger.info({ outcome: result.outcome }, '[api] F192 Phase I: design-gate threshold observation');
      } catch (error) {
        input.logger.warn({ error }, '[api] F192 Phase I: design-gate threshold observation failed closed');
      }
    }
  };
  const enqueue = () => {
    if (closed) return;
    pending = true;
    if (!active) {
      active = Promise.resolve()
        .then(drain)
        .finally(() => {
          active = null;
          if (pending && !closed) enqueue();
        });
    }
  };

  try {
    const watchFactory: DesignGateSourceWatchFactory =
      input.watchFactory ?? ((root, options, listener) => watch(root, { ...options, encoding: 'utf8' }, listener));
    watcher = watchFactory(input.sourceMapRoot, { persistent: false }, (_eventType, filename) => {
      if (filename === null || String(filename).endsWith('.yaml')) enqueue();
    });
    watcher.on('error', (error) => {
      input.logger.warn({ error }, '[api] F192 Phase I: design-gate source-map observer degraded to fallback');
    });
  } catch (error) {
    input.logger.warn({ error }, '[api] F192 Phase I: design-gate source-map observer unavailable');
  }
  enqueue();

  return {
    close() {
      closed = true;
      pending = false;
      watcher?.close();
    },
    async waitForIdle() {
      while (active) await active;
    },
  };
}

export async function observeDesignGateThresholdTrigger(
  input: ObserveDesignGateThresholdTriggerInput,
): Promise<ObserveDesignGateThresholdTriggerResult> {
  let transition: Awaited<ReturnType<DesignGateThresholdTransitionProvider['resolveLatestTransition']>>;
  try {
    transition = await input.provider.resolveLatestTransition();
  } catch {
    return { outcome: 'invalid_source' };
  }
  if (!transition.sourceValid) return { outcome: 'invalid_source' };

  let effectiveDomain = input.domain;
  if (input.threadStore) {
    await ensureEvalDomainThreads(
      input.threadStore,
      [
        {
          domainId: input.domain.domainId,
          systemThreadId: input.domain.systemThreadId,
          displayName: input.domain.displayName,
        },
      ],
      input.defaultUserId,
    );
  }
  if (input.redis) {
    try {
      const override = await getEvalCatOverride(input.redis, input.domain.domainId);
      if (override) {
        effectiveDomain = {
          ...input.domain,
          evalCat: { catId: override.catId, handle: override.handle, model: override.model },
        };
      }
    } catch {
      // Receipt safety remains authoritative; a missing optional cat override falls back to registry truth.
    }
  }

  const policy = effectiveDomain.triggerPolicy;
  if (policy.mode !== 'threshold_or_time') return { outcome: 'invalid_source' };
  const invocation = buildEvalCatInvocation(
    {
      domain: effectiveDomain,
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'disabled' },
    },
    { wiredPublishDomains: input.wiredPublishDomains },
  );

  return dispatchEvalDomainTrigger({
    domain: effectiveDomain,
    invocation,
    channel: 'threshold_event',
    event: {
      eventId: transition.eventId,
      eventSource: policy.eventSource,
      counter: policy.threshold.counter,
      previousValue: transition.previousEligibleEpisodes,
      currentValue: transition.currentEligibleEpisodes,
    },
    triggerReason: `Threshold eval: ${input.domain.domainId} ${transition.previousEligibleEpisodes}→${transition.currentEligibleEpisodes}`,
    store: input.store,
    deliver: input.deliver,
    invokeTrigger: input.invokeTrigger,
    defaultUserId: input.defaultUserId,
    nowMs: input.nowMs,
  });
}
