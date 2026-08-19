import type { Redis } from 'ioredis';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import type { IReevalClosureEventLog } from '../reeval-closure-event-log.js';
import { enrichEvalHubLifecycle } from './eval-hub-lifecycle-projection.js';
import { loadEvalHubSummary } from './eval-hub-read-model.js';
import type { EvalHubSummary } from './eval-hub-read-model-types.js';
import { ensureEvalDomainThreads } from './eval-hub-thread-ensure.js';

export interface LoadEnrichedEvalHubSummaryOptions {
  harnessFeedbackRoot: string;
  userId: string;
  redis?: Redis;
  threadStore?: IThreadStore;
  lifecycleEventLog?: Pick<IReevalClosureEventLog, 'read'>;
  log: { warn(...args: unknown[]): void };
}

async function applyEvalCatOverrides(summary: EvalHubSummary, redis: Redis | undefined): Promise<void> {
  if (!redis) return;
  for (const domain of summary.domains) {
    const override = await getEvalCatOverride(redis, domain.domainId);
    if (override) {
      domain.evalCatId = override.catId;
      domain.evalCatHandle = override.handle;
    }
  }
}

async function ensureEvalThreadsBestEffort(summary: EvalHubSummary, options: LoadEnrichedEvalHubSummaryOptions) {
  if (!options.threadStore) return;
  try {
    await ensureEvalDomainThreads(
      options.threadStore,
      summary.domains.map((domain) => ({
        domainId: domain.domainId,
        systemThreadId: domain.systemThreadId,
        displayName: domain.displayName,
      })),
      options.userId,
    );
  } catch (error) {
    options.log.warn({ err: error }, 'eval-hub: thread ensure failed (best-effort, continuing)');
  }
}

export async function loadEnrichedEvalHubSummary(options: LoadEnrichedEvalHubSummaryOptions): Promise<EvalHubSummary> {
  const summary = loadEvalHubSummary({ harnessFeedbackRoot: options.harnessFeedbackRoot });
  await applyEvalCatOverrides(summary, options.redis);
  await ensureEvalThreadsBestEffort(summary, options);
  return enrichEvalHubLifecycle(summary, {
    harnessFeedbackRoot: options.harnessFeedbackRoot,
    ...(options.lifecycleEventLog ? { eventLog: options.lifecycleEventLog } : {}),
    assignedEvalCatIds: new Map(summary.domains.map((domain) => [domain.domainId, domain.evalCatId])),
  });
}
