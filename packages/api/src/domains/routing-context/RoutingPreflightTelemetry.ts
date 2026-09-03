import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { OPERATION_NAME, STATUS } from '../../infrastructure/telemetry/genai-semconv.js';
import { routingPreflightDuration, routingPreflightEventTotal } from '../../infrastructure/telemetry/instruments.js';

interface RoutingPreflightTelemetryBase {
  kind: 'attempt' | 'audit' | 'circuit_transition' | 'instance_started';
  scope: 'process';
  processInstanceId: string;
  restartEpoch: number;
  observedAt: number;
}

export type RoutingPreflightTelemetryEvent =
  | (RoutingPreflightTelemetryBase & {
      kind: 'attempt';
      attemptKind: 'closed' | 'half_open' | 'suppressed';
      outcome:
        | 'circuit_open'
        | 'fresh'
        | 'half_open_busy'
        | 'resolver_degraded'
        | 'resolver_error'
        | 'resolver_timeout';
      durationMs: number;
    })
  | (RoutingPreflightTelemetryBase & {
      kind: 'audit';
      disposition: 'dedupe_suppressed' | 'emitted';
      failureClass: string;
    })
  | (RoutingPreflightTelemetryBase & {
      kind: 'circuit_transition';
      from: 'closed' | 'half_open' | 'open';
      to: 'closed' | 'half_open' | 'open';
      reason: 'failure_threshold' | 'fresh_probe' | 'probe_failed' | 'probe_interval_elapsed';
    })
  | (RoutingPreflightTelemetryBase & { kind: 'instance_started' });

type RoutingPreflightTelemetryEnvelopeKey = Exclude<keyof RoutingPreflightTelemetryBase, 'kind'>;

export interface RoutingPreflightTelemetrySink {
  record(event: RoutingPreflightTelemetryEvent): void | Promise<void>;
}

interface RoutingPreflightObserverOptions {
  clock: { now(): number };
  sink?: RoutingPreflightTelemetrySink;
  processInstanceId?: string;
  restartEpoch?: number;
}

const NULL_TELEMETRY_SINK: RoutingPreflightTelemetrySink = { record: () => undefined };
const PROCESS_INSTANCE_ID = `api-${process.pid}-${randomUUID()}`;
const PROCESS_RESTART_EPOCH = Date.now();

/** Adds process identity and keeps telemetry failures outside the dispatch path. */
export class RoutingPreflightObserver {
  private readonly sink: RoutingPreflightTelemetrySink;
  private readonly processInstanceId: string;
  private readonly restartEpoch: number;

  constructor(private readonly options: RoutingPreflightObserverOptions) {
    this.sink = options.sink ?? NULL_TELEMETRY_SINK;
    this.processInstanceId = options.processInstanceId ?? PROCESS_INSTANCE_ID;
    this.restartEpoch = options.restartEpoch ?? PROCESS_RESTART_EPOCH;
    this.emit({ kind: 'instance_started' });
  }

  attempt(
    attemptKind: Extract<RoutingPreflightTelemetryEvent, { kind: 'attempt' }>['attemptKind'],
    outcome: Extract<RoutingPreflightTelemetryEvent, { kind: 'attempt' }>['outcome'],
    durationMs: number,
  ): void {
    this.emit({ kind: 'attempt', attemptKind, outcome, durationMs: Math.max(0, durationMs) });
  }

  audit(
    disposition: Extract<RoutingPreflightTelemetryEvent, { kind: 'audit' }>['disposition'],
    failureClass: string,
  ): void {
    this.emit({ kind: 'audit', disposition, failureClass });
  }

  transition(
    from: Extract<RoutingPreflightTelemetryEvent, { kind: 'circuit_transition' }>['from'],
    to: Extract<RoutingPreflightTelemetryEvent, { kind: 'circuit_transition' }>['to'],
    reason: Extract<RoutingPreflightTelemetryEvent, { kind: 'circuit_transition' }>['reason'],
  ): void {
    this.emit({ kind: 'circuit_transition', from, to, reason });
  }

  private emit(
    details:
      | { kind: 'instance_started' }
      | Omit<Extract<RoutingPreflightTelemetryEvent, { kind: 'attempt' }>, RoutingPreflightTelemetryEnvelopeKey>
      | Omit<Extract<RoutingPreflightTelemetryEvent, { kind: 'audit' }>, RoutingPreflightTelemetryEnvelopeKey>
      | Omit<
          Extract<RoutingPreflightTelemetryEvent, { kind: 'circuit_transition' }>,
          RoutingPreflightTelemetryEnvelopeKey
        >,
  ): void {
    const event = {
      ...details,
      scope: 'process',
      processInstanceId: this.processInstanceId,
      restartEpoch: this.restartEpoch,
      observedAt: this.options.clock.now(),
    } as RoutingPreflightTelemetryEvent;
    try {
      void Promise.resolve(this.sink.record(event)).catch(() => undefined);
    } catch {
      // Operational telemetry is advisory and must never become a dispatch gate.
    }
  }
}

export function routingPreflightMetricAttributes(event: RoutingPreflightTelemetryEvent): Record<string, string> {
  const status =
    event.kind === 'attempt'
      ? event.outcome
      : event.kind === 'audit'
        ? event.disposition
        : event.kind === 'circuit_transition'
          ? `${event.from}_to_${event.to}`
          : 'started';
  return {
    [OPERATION_NAME]: `routing_context.preflight.${event.kind}`,
    [STATUS]: status,
  };
}

const tracer = trace.getTracer('cat-cafe-api', '0.1.0');
const log = createModuleLogger('routing-preflight');

/** Emits bounded metrics plus payload-free F153 traces/logs. */
export class OpenTelemetryRoutingPreflightSink implements RoutingPreflightTelemetrySink {
  record(event: RoutingPreflightTelemetryEvent): void {
    const metricAttributes = routingPreflightMetricAttributes(event);
    routingPreflightEventTotal.add(1, metricAttributes);
    if (event.kind === 'attempt') routingPreflightDuration.record(event.durationMs, metricAttributes);

    const span = tracer.startSpan('cat_cafe.routing_context.preflight', {
      attributes: {
        'routing.preflight.event': event.kind,
        'routing.preflight.scope': event.scope,
        'routing.preflight.process_instance_id': event.processInstanceId,
        'routing.preflight.restart_epoch': event.restartEpoch,
        ...metricAttributes,
        ...(event.kind === 'attempt'
          ? { 'routing.preflight.attempt_kind': event.attemptKind, 'routing.preflight.duration_ms': event.durationMs }
          : {}),
        ...(event.kind === 'circuit_transition' ? { 'routing.preflight.transition_reason': event.reason } : {}),
        ...(event.kind === 'audit' ? { 'routing.preflight.failure_class': event.failureClass } : {}),
      },
    });
    span.end();

    if (event.kind === 'instance_started' || event.kind === 'circuit_transition') {
      log.info(event, 'F293 process-local routing preflight health');
    } else if (event.kind === 'attempt' && event.outcome !== 'fresh') {
      log.warn(event, 'F293 routing preflight degraded');
    } else {
      log.debug(event, 'F293 routing preflight observation');
    }
  }
}
