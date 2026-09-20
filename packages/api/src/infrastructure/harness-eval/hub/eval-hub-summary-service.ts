import type { Redis } from 'ioredis';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import { getEvalCatOverride } from '../domain/eval-domain-override.js';
import { lifecycleSpaceOf } from '../lifecycle-space.js';
import type { IReevalClosureEventLog } from '../reeval-closure-event-log.js';
import { enrichEvalHubLifecycle } from './eval-hub-lifecycle-projection.js';
import { loadEvalHubSummary } from './eval-hub-read-model.js';
import type { EvalHubSummary } from './eval-hub-read-model-types.js';
import { ensureEvalDomainThreads } from './eval-hub-thread-ensure.js';

export interface LoadEnrichedEvalHubSummaryOptions {
  harnessFeedbackRoot: string;
  artifactStoreRoot?: string;
  userId: string;
  /** The owner whose lifecycle space is the install's. */
  configuredOwnerUserId: string;
  redis?: Redis;
  threadStore?: IThreadStore;
  /** The install space's lifecycle log. */
  lifecycleEventLog?: Pick<IReevalClosureEventLog, 'read'>;
  /** Opens another owner's lifecycle log; the summary only ever opens the requesting user's. */
  ownerLifecycleEventLog?: (ownerUserId: string) => Pick<IReevalClosureEventLog, 'read'>;
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
  // Runtime artifacts are read only from the requesting user's own partition, and
  // lifecycles only from the requesting user's own space.
  const summary = loadEvalHubSummary({
    harnessFeedbackRoot: options.harnessFeedbackRoot,
    ...(options.artifactStoreRoot
      ? { artifactStore: { root: options.artifactStoreRoot, ownerUserId: options.userId } }
      : {}),
  });
  await applyEvalCatOverrides(summary, options.redis);
  await ensureEvalThreadsBestEffort(summary, options);
  const space = lifecycleSpaceOf(options.userId, options);
  if (!space) return summary;
  const eventLog =
    space.kind === 'install' ? options.lifecycleEventLog : options.ownerLifecycleEventLog?.(options.userId);
  return enrichEvalHubLifecycle(summary, {
    space,
    ...(eventLog ? { eventLog } : {}),
    assignedEvalCatIds: new Map(summary.domains.map((domain) => [domain.domainId, domain.evalCatId])),
  });
}
