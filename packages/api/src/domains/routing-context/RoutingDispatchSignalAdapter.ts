import { createHash } from 'node:crypto';
import { type RoutingSignalEventV1, type RoutingSubjectRefV1 } from '@cat-cafe/shared';
import type { AutomaticRoutingSignalService } from './AutomaticRoutingSignalService.js';
import {
  type RoutingDispatchFailureClass,
  type RoutingDispatchTerminalEvidence,
  type RoutingDispatchTerminalObserver,
  routingDispatchTerminalEvidenceSchema,
} from './RoutingDispatchSignalContract.js';
import type { IRoutingSignalEventStore, RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import { ROUTING_HEALTH_MAX_VALIDITY_MS, routingSignalObservationV1Schema } from './RoutingSignalObservation.js';
import type {
  RoutingSignalObservationTelemetry,
  RoutingSignalObservationTelemetryEvent,
} from './RoutingSignalObservationTelemetry.js';

export interface RoutingDispatchSignalAdapterOptions {
  signalStore: Pick<IRoutingSignalEventStore, 'get' | 'listBySubject'>;
  automaticSignalService: AutomaticRoutingSignalService;
  telemetry?: RoutingSignalObservationTelemetry;
}

const MAX_REFERENCED_SIGNAL_IDS = 256;
const ROUTING_SIGNAL_EVENT_ID = /^routing-signal:[a-f0-9]{32}$/;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function subjectIdentity(subject: RoutingSubjectRefV1): string {
  if (subject.type === 'cat') return `cat:${subject.catId}`;
  if (subject.type === 'provider') return `provider:${subject.providerId}`;
  return `quota_pool:${subject.poolId}`;
}

function closureSet(events: readonly RoutingSignalEventV1[]): Set<string> {
  const closed = new Set<string>();
  for (const event of events) {
    if (event.eventType === 'asserted') continue;
    for (const eventId of event.closesSignalIds) closed.add(eventId);
  }
  return closed;
}

function referencedSignalIds(evidence: RoutingDispatchTerminalEvidence): string[] {
  const target = evidence.preflightDecision.targets.find((entry) => entry.targetCatId === evidence.catId);
  if (!target) return [];
  const ids = new Set<string>();
  for (const reason of target.reasons) {
    for (const sourceRef of reason.sourceRefs) {
      if (!ROUTING_SIGNAL_EVENT_ID.test(sourceRef)) continue;
      ids.add(sourceRef);
      if (ids.size >= MAX_REFERENCED_SIGNAL_IDS) return [...ids];
    }
  }
  return [...ids];
}

function isRecoverableAssertion(
  evidence: RoutingDispatchTerminalEvidence,
  event: RoutingSignalEventV1 | null,
): event is Extract<RoutingSignalEventV1, { eventType: 'asserted' }> {
  if (event?.eventType !== 'asserted' || event.observedAt > evidence.preflightDecision.observedAt) return false;
  if (event.source === 'provider_error') {
    return event.subjectRef.type === 'cat' && event.subjectRef.catId === evidence.catId;
  }
  if (event.source !== 'health_probe') return false;
  return event.subjectRef.type === 'cat' && event.subjectRef.catId === evidence.catId;
}

export class RoutingDispatchSignalAdapter implements RoutingDispatchTerminalObserver {
  constructor(private readonly options: RoutingDispatchSignalAdapterOptions) {}

  async observeTerminal(inputValue: RoutingDispatchTerminalEvidence): Promise<RoutingSignalEventAppendResult[]> {
    let evidence: RoutingDispatchTerminalEvidence;
    try {
      evidence = routingDispatchTerminalEvidenceSchema.parse(inputValue);
    } catch (error) {
      this.record({ source: 'provider_error', subjectKind: 'unknown', transition: 'validate', outcome: 'rejected' });
      throw error;
    }

    if (evidence.status === 'failed' && evidence.failureClass !== undefined) {
      return this.assertStableFailure({
        ...evidence,
        status: 'failed',
        failureClass: evidence.failureClass,
      });
    }
    if (evidence.status === 'succeeded') return this.recoverReferencedAssertions(evidence);

    this.record({ source: 'provider_error', subjectKind: 'cat', transition: 'validate', outcome: 'ignored' });
    return [];
  }

  private async assertStableFailure(
    evidence: RoutingDispatchTerminalEvidence & { status: 'failed'; failureClass: RoutingDispatchFailureClass },
  ): Promise<RoutingSignalEventAppendResult[]> {
    const observation = routingSignalObservationV1Schema.parse({
      v: 1,
      kind: 'dispatch_terminal',
      ...evidence,
    });
    if (observation.kind !== 'dispatch_terminal' || observation.status !== 'failed') {
      throw new TypeError('stable dispatch failure requires a failed terminal observation');
    }
    try {
      const result = await this.options.automaticSignalService.assert({
        ownerId: observation.ownerId,
        observationId: `dispatch:${digest(`${observation.observationId}\0${evidence.failureClass}`)}`,
        subjectRef: { type: 'cat', catId: observation.catId },
        state: 'unavailable',
        reasonCode: evidence.failureClass,
        source: 'provider_error',
        observedAt: observation.observedAt,
        evidenceRef: observation.evidenceRef,
        validUntil: observation.observedAt + ROUTING_HEALTH_MAX_VALIDITY_MS,
      });
      this.record({ source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: result.outcome });
      return [result];
    } catch (error) {
      this.record({ source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: 'failed' });
      throw error;
    }
  }

  private async recoverReferencedAssertions(
    evidence: RoutingDispatchTerminalEvidence,
  ): Promise<RoutingSignalEventAppendResult[]> {
    routingSignalObservationV1Schema.parse({ v: 1, kind: 'dispatch_terminal', ...evidence });
    try {
      const candidateEvents: RoutingSignalEventV1[] = [];
      const ids = referencedSignalIds(evidence);
      for (let offset = 0; offset < ids.length; offset += 64) {
        const events = await Promise.all(
          ids.slice(offset, offset + 64).map((eventId) => this.options.signalStore.get(evidence.ownerId, eventId)),
        );
        for (const event of events) {
          if (isRecoverableAssertion(evidence, event)) candidateEvents.push(event);
        }
      }

      const groups = new Map<string, { subjectRef: RoutingSubjectRefV1; eventIds: string[] }>();
      for (const event of candidateEvents) {
        const key = subjectIdentity(event.subjectRef);
        const group = groups.get(key) ?? { subjectRef: event.subjectRef, eventIds: [] };
        group.eventIds.push(event.eventId);
        groups.set(key, group);
      }

      const results: RoutingSignalEventAppendResult[] = [];
      for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const timeline = await this.options.signalStore.listBySubject(evidence.ownerId, group.subjectRef);
        const closed = closureSet(timeline);
        const openIds = group.eventIds.filter((eventId) => !closed.has(eventId)).sort();
        for (let offset = 0; offset < openIds.length; offset += 64) {
          const result = await this.options.automaticSignalService.recover({
            ownerId: evidence.ownerId,
            observationId: `dispatch:${digest(`${evidence.observationId}\0${key}\0${offset / 64}`)}`,
            subjectRef: group.subjectRef,
            reasonCode: 'dispatch_success_probe',
            source: 'dispatch_success',
            observedAt: evidence.observedAt,
            evidenceRef: evidence.evidenceRef,
            closesSignalIds: openIds.slice(offset, offset + 64),
            recoverableSources: ['provider_error', 'health_probe'],
          });
          results.push(result);
          this.record({
            source: 'dispatch_success',
            subjectKind: group.subjectRef.type,
            transition: 'recover',
            outcome: result.outcome,
          });
        }
      }
      if (results.length === 0) {
        this.record({
          source: 'dispatch_success',
          subjectKind: 'cat',
          transition: 'recover',
          outcome: 'no_open_assertion',
        });
      }
      return results;
    } catch (error) {
      this.record({ source: 'dispatch_success', subjectKind: 'unknown', transition: 'recover', outcome: 'failed' });
      throw error;
    }
  }

  private record(event: RoutingSignalObservationTelemetryEvent): void {
    this.options.telemetry?.record(event);
  }
}
