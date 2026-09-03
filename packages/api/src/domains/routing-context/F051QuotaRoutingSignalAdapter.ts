import { createHash } from 'node:crypto';
import type { RoutingSignalEventV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';
import type { AutomaticRoutingSignalService } from './AutomaticRoutingSignalService.js';
import type { IRoutingSignalEventStore, RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import { type RoutingSignalObservationV1, routingSignalObservationV1Schema } from './RoutingSignalObservation.js';
import type {
  RoutingSignalObservationTelemetry,
  RoutingSignalObservationTelemetryEvent,
} from './RoutingSignalObservationTelemetry.js';

type QuotaSnapshotObservation = Extract<RoutingSignalObservationV1, { kind: 'quota_snapshot' }>;
type QuotaSnapshotItem = QuotaSnapshotObservation['items'][number];
type QuotaPoolSubjectRef = Extract<RoutingSubjectRefV1, { type: 'quota_pool' }>;

export interface RoutingQuotaSnapshotObserver {
  observeSnapshot(input: QuotaSnapshotObservation): Promise<readonly RoutingSignalEventAppendResult[]>;
}

export interface F051QuotaRoutingSignalAdapterOptions {
  signalStore: Pick<IRoutingSignalEventStore, 'listBySubject'>;
  automaticSignalService: AutomaticRoutingSignalService;
  telemetry?: RoutingSignalObservationTelemetry;
}

const DEFAULT_VALIDITY_MS = 5 * 60_000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function providerQualifiedQuotaPoolId(providerId: string, poolId: string): string {
  const provider = providerId.trim();
  const pool = poolId.trim();
  if (!provider || !pool) throw new TypeError('Provider and quota pool ids must be non-empty');
  return `quota:${digest(`${provider}\0${pool}`)}`;
}

function transitionObservationId(
  observationId: string,
  qualifiedPoolId: string,
  transition: string,
  batch = 0,
): string {
  return `quota:${digest([observationId, qualifiedPoolId, transition, batch].join('\0'))}`;
}

function utilization(item: QuotaSnapshotObservation['items'][number]): number {
  return item.percentKind === 'remaining' ? 100 - item.usedPercent : item.usedPercent;
}

function validityBoundary(item: QuotaSnapshotItem, observedAt: number): number {
  return item.resetsAt !== undefined && item.resetsAt > observedAt ? item.resetsAt : observedAt + DEFAULT_VALIDITY_MS;
}

function selectLimitingItems(observation: QuotaSnapshotObservation): Map<string, QuotaSnapshotItem> {
  const itemsByPool = new Map<string, QuotaSnapshotItem>();
  for (const item of observation.items) {
    if (!item.poolId) continue;
    const qualifiedPoolId = providerQualifiedQuotaPoolId(observation.providerId, item.poolId);
    const selected = itemsByPool.get(qualifiedPoolId);
    if (
      !selected ||
      utilization(item) > utilization(selected) ||
      (utilization(item) === utilization(selected) &&
        validityBoundary(item, observation.observedAt) < validityBoundary(selected, observation.observedAt))
    ) {
      itemsByPool.set(qualifiedPoolId, item);
    }
  }
  return itemsByPool;
}

function closureSet(events: readonly RoutingSignalEventV1[]): Set<string> {
  const closed = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'asserted') continue;
    for (const eventId of event.closesSignalIds) closed.add(eventId);
  }
  return closed;
}

export class F051QuotaRoutingSignalAdapter implements RoutingQuotaSnapshotObserver {
  constructor(private readonly options: F051QuotaRoutingSignalAdapterOptions) {}

  async observeSnapshot(inputValue: QuotaSnapshotObservation): Promise<RoutingSignalEventAppendResult[]> {
    const parsed = routingSignalObservationV1Schema.parse(inputValue);
    if (parsed.kind !== 'quota_snapshot') throw new TypeError('F051 quota adapter requires a quota snapshot');
    const results: RoutingSignalEventAppendResult[] = [];
    for (const [qualifiedPoolId, item] of selectLimitingItems(parsed)) {
      const subjectRef: QuotaPoolSubjectRef = { type: 'quota_pool', poolId: qualifiedPoolId };
      results.push(...(await this.observeExactPoolWithTelemetry(parsed, item, subjectRef)));
    }
    return results;
  }

  private async observeExactPoolWithTelemetry(
    observation: QuotaSnapshotObservation,
    item: QuotaSnapshotItem,
    subjectRef: QuotaPoolSubjectRef,
  ): Promise<RoutingSignalEventAppendResult[]> {
    const transition = utilization(item) < 90 ? 'recover' : 'assert';
    try {
      const results = await this.observeExactPool(observation, item, subjectRef);
      if (results.length === 0) {
        this.record({ source: 'quota_probe', subjectKind: 'quota_pool', transition, outcome: 'no_open_assertion' });
      } else {
        for (const result of results) {
          this.record({ source: 'quota_probe', subjectKind: 'quota_pool', transition, outcome: result.outcome });
        }
      }
      return results;
    } catch (error) {
      this.record({ source: 'quota_probe', subjectKind: 'quota_pool', transition, outcome: 'failed' });
      throw error;
    }
  }

  private async observeExactPool(
    observation: QuotaSnapshotObservation,
    item: QuotaSnapshotItem,
    subjectRef: QuotaPoolSubjectRef,
  ): Promise<RoutingSignalEventAppendResult[]> {
    const used = utilization(item);
    if (used < 90) return this.recoverOpenPoolAssertions(observation, subjectRef);
    const state = used >= 100 ? 'unavailable' : 'scarce';
    const futureReset =
      item.resetsAt !== undefined && item.resetsAt > observation.observedAt ? item.resetsAt : undefined;
    return [
      await this.options.automaticSignalService.assert({
        ownerId: observation.ownerId,
        observationId: transitionObservationId(observation.observationId, subjectRef.poolId, state),
        subjectRef,
        state,
        reasonCode: state === 'unavailable' ? 'quota_pool_exhausted' : 'quota_pool_near_limit',
        source: 'quota_probe',
        observedAt: observation.observedAt,
        evidenceRef: observation.evidenceRef,
        ...(futureReset !== undefined
          ? { resetAt: futureReset }
          : { validUntil: observation.observedAt + DEFAULT_VALIDITY_MS }),
      }),
    ];
  }

  private async recoverOpenPoolAssertions(
    observation: QuotaSnapshotObservation,
    subjectRef: QuotaPoolSubjectRef,
  ): Promise<RoutingSignalEventAppendResult[]> {
    const timeline = await this.options.signalStore.listBySubject(observation.ownerId, subjectRef);
    const closed = closureSet(timeline);
    const openIds = timeline
      .filter(
        (event): event is Extract<RoutingSignalEventV1, { eventType: 'asserted' }> =>
          event.eventType === 'asserted' &&
          event.source === 'quota_probe' &&
          event.observedAt <= observation.observedAt &&
          !closed.has(event.eventId),
      )
      .map((event) => event.eventId)
      .sort();
    const results: RoutingSignalEventAppendResult[] = [];
    for (let offset = 0; offset < openIds.length; offset += 64) {
      const batch = openIds.slice(offset, offset + 64);
      results.push(
        await this.options.automaticSignalService.recover({
          ownerId: observation.ownerId,
          observationId: transitionObservationId(
            observation.observationId,
            subjectRef.poolId,
            'available',
            offset / 64,
          ),
          subjectRef,
          reasonCode: 'quota_pool_available',
          source: 'quota_probe',
          observedAt: observation.observedAt,
          evidenceRef: observation.evidenceRef,
          closesSignalIds: batch,
          recoverableSources: ['quota_probe'],
        }),
      );
    }
    return results;
  }

  private record(event: RoutingSignalObservationTelemetryEvent): void {
    this.options.telemetry?.record(event);
  }
}
