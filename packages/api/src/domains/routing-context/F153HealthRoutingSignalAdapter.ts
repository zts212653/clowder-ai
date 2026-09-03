import { createHash } from 'node:crypto';
import type { RoutingSignalEventV1, RoutingSubjectRefV1 } from '@cat-cafe/shared';
import type { AutomaticRoutingSignalService } from './AutomaticRoutingSignalService.js';
import type { IRoutingSignalEventStore, RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import {
  type ProviderHealthObservationV1,
  type RoutingSignalObservationV1,
  routingSignalObservationV1Schema,
} from './RoutingSignalObservation.js';
import type {
  RoutingSignalObservationTelemetry,
  RoutingSignalObservationTelemetryEvent,
} from './RoutingSignalObservationTelemetry.js';

export interface RoutingHealthObservationPort {
  observeHealth(input: ProviderHealthObservationV1): Promise<readonly RoutingSignalEventAppendResult[]>;
}

export interface F153HealthRoutingSignalAdapterOptions {
  signalStore: Pick<IRoutingSignalEventStore, 'listBySubject'>;
  automaticSignalService: AutomaticRoutingSignalService;
  telemetry?: RoutingSignalObservationTelemetry;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function subjectIdentity(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

function observationTransitionId(observation: ProviderHealthObservationV1, transition: string, batch = 0): string {
  return `health:${digest(
    [observation.observationId, subjectIdentity(observation.subjectRef), observation.authority, transition, batch].join(
      '\0',
    ),
  )}`;
}

function reasonCode(
  authority: ProviderHealthObservationV1['authority'],
  state: ProviderHealthObservationV1['state'],
): string {
  return `health_${authority}_${state}`;
}

function closureSet(events: readonly RoutingSignalEventV1[]): Set<string> {
  const closed = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'asserted') continue;
    for (const eventId of event.closesSignalIds) closed.add(eventId);
  }
  return closed;
}

function isProviderHealth(observation: RoutingSignalObservationV1): observation is ProviderHealthObservationV1 {
  return observation.kind === 'provider_health';
}

export class F153HealthRoutingSignalAdapter implements RoutingHealthObservationPort {
  constructor(private readonly options: F153HealthRoutingSignalAdapterOptions) {}

  async observeHealth(inputValue: unknown): Promise<RoutingSignalEventAppendResult[]> {
    let observation: ProviderHealthObservationV1;
    try {
      const parsed = routingSignalObservationV1Schema.parse(inputValue);
      if (!isProviderHealth(parsed)) throw new TypeError('F153 health adapter requires a provider health observation');
      observation = parsed;
    } catch (error) {
      this.record({ source: 'health_probe', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' });
      throw error;
    }

    const transition = observation.state === 'available' ? 'recover' : 'assert';
    const subjectKind = observation.subjectRef.type;
    try {
      const results =
        transition === 'recover'
          ? await this.recoverOpenAssertions(observation)
          : [await this.assertHealth(observation)];
      if (results.length === 0) {
        this.record({ source: 'health_probe', subjectKind, transition, outcome: 'no_open_assertion' });
      } else {
        for (const result of results) {
          this.record({ source: 'health_probe', subjectKind, transition, outcome: result.outcome });
        }
      }
      return results;
    } catch (error) {
      this.record({ source: 'health_probe', subjectKind, transition, outcome: 'failed' });
      throw error;
    }
  }

  private assertHealth(observation: ProviderHealthObservationV1): Promise<RoutingSignalEventAppendResult> {
    if (observation.state === 'available') throw new TypeError('available health must use causal recovery');
    return this.options.automaticSignalService.assert({
      ownerId: observation.ownerId,
      observationId: observationTransitionId(observation, observation.state),
      subjectRef: observation.subjectRef,
      state: observation.state,
      reasonCode: reasonCode(observation.authority, observation.state),
      source: 'health_probe',
      observedAt: observation.observedAt,
      evidenceRef: observation.evidenceRef,
      validUntil: observation.validUntil,
    });
  }

  private async recoverOpenAssertions(
    observation: ProviderHealthObservationV1,
  ): Promise<RoutingSignalEventAppendResult[]> {
    const timeline = await this.options.signalStore.listBySubject(observation.ownerId, observation.subjectRef);
    const closed = closureSet(timeline);
    const allowedReasons = new Set([
      reasonCode(observation.authority, 'degraded'),
      reasonCode(observation.authority, 'unavailable'),
    ]);
    const openIds = timeline
      .filter(
        (event): event is Extract<RoutingSignalEventV1, { eventType: 'asserted' }> =>
          event.eventType === 'asserted' &&
          event.source === 'health_probe' &&
          event.observedAt <= observation.observedAt &&
          allowedReasons.has(event.reasonCode) &&
          !closed.has(event.eventId),
      )
      .map((event) => event.eventId)
      .sort();
    const results: RoutingSignalEventAppendResult[] = [];
    for (let offset = 0; offset < openIds.length; offset += 64) {
      results.push(
        await this.options.automaticSignalService.recover({
          ownerId: observation.ownerId,
          observationId: observationTransitionId(observation, 'available', offset / 64),
          subjectRef: observation.subjectRef,
          reasonCode: reasonCode(observation.authority, 'available'),
          source: 'health_probe',
          observedAt: observation.observedAt,
          evidenceRef: observation.evidenceRef,
          closesSignalIds: openIds.slice(offset, offset + 64),
          recoverableSources: ['health_probe'],
        }),
      );
    }
    return results;
  }

  private record(event: RoutingSignalObservationTelemetryEvent): void {
    this.options.telemetry?.record(event);
  }
}
