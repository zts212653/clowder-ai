import { createHash } from 'node:crypto';
import type { AutomaticRoutingSignalService } from './AutomaticRoutingSignalService.js';
import {
  type RoutingDispatchFailureClass,
  type RoutingDispatchTerminalEvidence,
  type RoutingDispatchTerminalObserver,
  routingDispatchTerminalEvidenceSchema,
} from './RoutingDispatchSignalContract.js';
import type { RoutingSignalEventAppendResult } from './RoutingSignalEventStore.js';
import { ROUTING_HEALTH_MAX_VALIDITY_MS, routingSignalObservationV1Schema } from './RoutingSignalObservation.js';
import type {
  RoutingSignalObservationTelemetry,
  RoutingSignalObservationTelemetryEvent,
} from './RoutingSignalObservationTelemetry.js';

export interface RoutingDispatchSignalAdapterOptions {
  automaticSignalService: AutomaticRoutingSignalService;
  telemetry?: RoutingSignalObservationTelemetry;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
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
    if (evidence.status === 'succeeded') return this.recordSuccessfulProbe(evidence);

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
        observedAt: observation.failureObservedAt ?? observation.observedAt,
        evidenceRef: observation.evidenceRef,
        validUntil: (observation.failureObservedAt ?? observation.observedAt) + ROUTING_HEALTH_MAX_VALIDITY_MS,
      });
      this.record({ source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: result.outcome });
      return [result];
    } catch (error) {
      this.record({ source: 'provider_error', subjectKind: 'cat', transition: 'assert', outcome: 'failed' });
      throw error;
    }
  }

  private async recordSuccessfulProbe(
    evidence: RoutingDispatchTerminalEvidence,
  ): Promise<RoutingSignalEventAppendResult[]> {
    routingSignalObservationV1Schema.parse({ v: 1, kind: 'dispatch_terminal', ...evidence });
    try {
      // One atomic, replayable fact covers the complete causal interval, including
      // earlier failures whose durable terminal arrives after this success.
      const result = await this.options.automaticSignalService.recover({
        ownerId: evidence.ownerId,
        observationId: `dispatch:${digest(evidence.observationId)}`,
        subjectRef: { type: 'cat', catId: evidence.catId },
        reasonCode: 'dispatch_success_probe',
        source: 'dispatch_success',
        observedAt: evidence.observedAt,
        probeStartedAt: evidence.preflightDecision.observedAt,
        evidenceRef: evidence.evidenceRef,
        closesSignalIds: [],
        recoverableSources: ['provider_error', 'health_probe'],
      });
      this.record({ source: 'dispatch_success', subjectKind: 'cat', transition: 'recover', outcome: result.outcome });
      return [result];
    } catch (error) {
      this.record({ source: 'dispatch_success', subjectKind: 'cat', transition: 'recover', outcome: 'failed' });
      throw error;
    }
  }

  private record(event: RoutingSignalObservationTelemetryEvent): void {
    this.options.telemetry?.record(event);
  }
}
