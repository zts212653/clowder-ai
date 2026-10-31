import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { LiveResponseTrace } from '../src/domains/concierge/live/live-response-trace.js';
import { LocalTraceExporter } from '../src/infrastructure/telemetry/local-trace-exporter.js';
import { LocalTraceStore } from '../src/infrastructure/telemetry/local-trace-store.js';
import { RedactingSpanProcessor } from '../src/infrastructure/telemetry/redactor.js';

test('Live observation points reach the existing redacted F153 store before call end, without the per-span event cap', async () => {
  const store = new LocalTraceStore({ maxSpans: 256 });
  const noop = { onStart() {}, onEnd() {}, shutdown: async () => {}, forceFlush: async () => {} };
  const provider = new NodeTracerProvider({
    spanProcessors: [new RedactingSpanProcessor(noop), new SimpleSpanProcessor(new LocalTraceExporter(store))],
  });
  const tracer = provider.getTracer('isolated-live-observation-test');
  const t = new LiveResponseTrace(
    { userId: 'private-owner', threadId: 'private-home', catId: 'codex61-sol', callId: 'private-call' },
    (attributes) => tracer.startSpan('test.live_response', { attributes }),
  );
  try {
    for (let index = 0; index < 140; index++)
      t.mark('native_accepted', {
        nativeTurnId: `private-turn-${index}`,
        sourceRefs: ['thread:private-home#private-message'],
      });
    const spans = store.query({ limit: 200 });
    assert.equal(spans.length, 140, 'points export while the call is active, with no 128-event truncation');
    const event = spans[0].events[0];
    assert.equal(event.name, 'live.native_accepted');
    assert.equal(spans[0].attributes['live.clock_domain'], 'unix_epoch_ms');
    assert.notEqual(spans[0].attributes.callId, 'private-call');
    assert.notEqual(event.attributes?.nativeTurnId, 'private-turn-139');
    assert.ok(
      !JSON.stringify(spans).includes('private-message'),
      'source reference arrays receive the same identifier redaction',
    );
  } finally {
    t.close();
    await provider.shutdown();
  }
});
