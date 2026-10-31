import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RoutingSignalObservationTelemetry, routingSignalObservationMetricAttributes } = await import(
  '../dist/domains/routing-context/RoutingSignalObservationTelemetry.js'
);

describe('F293 routing signal observation telemetry', () => {
  it('exports only bounded outcome, source and subject-kind metric dimensions', () => {
    const attributes = routingSignalObservationMetricAttributes({
      source: 'health_probe',
      subjectKind: 'provider',
      transition: 'recover',
      outcome: 'replayed',
    });
    assert.deepEqual(attributes, {
      'operation.name': 'routing_context.signal_observation.health_probe.recover',
      'signal.kind': 'provider',
      status: 'replayed',
    });
    assert.equal(JSON.stringify(attributes).includes('owner'), false);
    assert.equal(JSON.stringify(attributes).includes('evidence'), false);
    assert.equal(JSON.stringify(attributes).includes('error'), false);
  });

  it('never lets synchronous or asynchronous sink failure escape into a producer', async () => {
    const sync = new RoutingSignalObservationTelemetry({
      sink: {
        record: () => {
          throw new Error('sync collector failure');
        },
      },
    });
    const asyncFailure = new RoutingSignalObservationTelemetry({
      sink: { record: () => Promise.reject(new Error('async collector failure')) },
    });
    const event = { source: 'health_probe', subjectKind: 'cat', transition: 'assert', outcome: 'appended' };

    assert.doesNotThrow(() => sync.record(event));
    assert.doesNotThrow(() => asyncFailure.record(event));
    await new Promise((resolve) => setImmediate(resolve));
  });
});
