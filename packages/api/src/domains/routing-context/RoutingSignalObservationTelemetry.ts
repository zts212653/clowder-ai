import { trace } from '@opentelemetry/api';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { OPERATION_NAME, SIGNAL_KIND, STATUS } from '../../infrastructure/telemetry/genai-semconv.js';
import { routingSignalObservationTotal } from '../../infrastructure/telemetry/instruments.js';

export interface RoutingSignalObservationTelemetryEvent {
  source: 'quota_probe' | 'health_probe' | 'provider_error' | 'dispatch_success';
  subjectKind: 'cat' | 'provider' | 'quota_pool' | 'unknown';
  transition: 'assert' | 'recover' | 'validate';
  outcome: 'appended' | 'replayed' | 'no_open_assertion' | 'ignored' | 'rejected' | 'failed';
}

export interface RoutingSignalObservationTelemetrySink {
  record(event: RoutingSignalObservationTelemetryEvent): void | Promise<void>;
}

const NULL_SINK: RoutingSignalObservationTelemetrySink = { record: () => undefined };

/** Keeps descriptive observability advisory and outside routing truth writes. */
export class RoutingSignalObservationTelemetry {
  private readonly sink: RoutingSignalObservationTelemetrySink;

  constructor(options: { sink?: RoutingSignalObservationTelemetrySink } = {}) {
    this.sink = options.sink ?? NULL_SINK;
  }

  record(event: RoutingSignalObservationTelemetryEvent): void {
    try {
      void Promise.resolve(this.sink.record(event)).catch(() => undefined);
    } catch {
      // F153 export health must never become a routing-signal acceptance gate.
    }
  }
}

export function routingSignalObservationMetricAttributes(
  event: RoutingSignalObservationTelemetryEvent,
): Record<string, string> {
  return {
    [OPERATION_NAME]: `routing_context.signal_observation.${event.source}.${event.transition}`,
    [SIGNAL_KIND]: event.subjectKind,
    [STATUS]: event.outcome,
  };
}

const tracer = trace.getTracer('cat-cafe-api', '0.1.0');
const log = createModuleLogger('routing-signal-observation');

/** Emits only closed-enum dimensions; owner, evidence and raw errors never enter the payload. */
export class OpenTelemetryRoutingSignalObservationSink implements RoutingSignalObservationTelemetrySink {
  record(event: RoutingSignalObservationTelemetryEvent): void {
    const attributes = routingSignalObservationMetricAttributes(event);
    routingSignalObservationTotal.add(1, attributes);
    const span = tracer.startSpan('cat_cafe.routing_context.signal_observation', {
      attributes: {
        'routing.signal.source': event.source,
        'routing.signal.subject_kind': event.subjectKind,
        'routing.signal.transition': event.transition,
        'routing.signal.outcome': event.outcome,
        ...attributes,
      },
    });
    span.end();
    if (event.outcome === 'failed' || event.outcome === 'rejected') {
      log.warn(event, 'F293 routing signal observation rejected');
    } else {
      log.debug(event, 'F293 routing signal observation');
    }
  }
}
