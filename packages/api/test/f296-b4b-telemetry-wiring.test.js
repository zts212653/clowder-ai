import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { metrics, trace } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
trace.setGlobalTracerProvider(provider);

const { createMetricAllowlistViews } = await import('../dist/infrastructure/telemetry/metric-allowlist.js');
const metricExporter = new PrometheusExporter({ preventServerStart: true });
const metricProvider = new MeterProvider({ readers: [metricExporter], views: createMetricAllowlistViews() });
metrics.setGlobalMeterProvider(metricProvider);

after(async () => {
  await provider.shutdown();
  await metricProvider.shutdown();
  trace.disable();
  metrics.disable();
});

const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
const { ContextEpochOwner } = await import('../dist/domains/cats/services/session/ContextEpochOwner.js');
const { InMemoryContextEpochStore } = await import('../dist/domains/cats/services/stores/ports/ContextEpochStore.js');

function preflightService() {
  return {
    l0CompilerFn: async () => ({ ok: true, content: '' }),
    contextCapability: () => ({
      provider: 'openai',
      carrier: 'app_server',
      reportsRuntimeWindow: false,
      authoritativeUsage: false,
      usageTelemetry: 'unavailable',
      nativeWindowControl: false,
      nativeCompressionControl: false,
      observesCompression: true,
      reason: 'F296 B4b production-seam test',
    }),
    async *invoke() {
      throw new Error('preflight carrier must not fall back to invoke()');
    },
    async *invokeWithContinuityPreflight(preflight) {
      await preflight.settle({ evidence: { kind: 'started', runtimeSessionId: 'runtime-secret-id' } });
      yield { type: 'text', catId: 'codex', content: 'provider output', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('F296 B4b telemetry reaches the real final-generation and provider-receipt seams', () => {
  test('a production invocation emits bounded continuity, projection, latency and ledger attributes', async () => {
    exporter.reset();
    await collect(
      invokeSingleCat(
        {
          registry: {
            create: () => ({ invocationId: 'invocation-secret-id', callbackToken: 'callback-secret' }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            resolveWorkingDirectory: () => '/tmp/test',
          },
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3004',
          contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
        },
        {
          catId: 'codex',
          service: preflightService(),
          prompt: 'PROMPT-BODY-MUST-NOT-LEAK',
          userId: 'user-secret-id',
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-secret-id',
          isLastCat: true,
          contextPromptFactory: async () => ({
            prompt: 'FINAL-PROJECTION-BODY-MUST-NOT-LEAK',
            promptMessageIds: ['message-secret-id'],
            deltaSize: 'small',
          }),
        },
      ),
    );

    const attributes = Object.assign({}, ...exporter.getFinishedSpans().map((span) => span.attributes));
    assert.equal(attributes['context_projection.disposition'], 'fresh');
    assert.equal(attributes['context_projection.reason'], 'no_prior_session');
    assert.equal(attributes['context_projection.transition'], 'scope_first_seen');
    assert.equal(attributes['context_projection.mode'], 'cold');
    assert.equal(attributes['context_projection.delta_size'], 'small');
    assert.equal(attributes['context_projection.tier_t0_count'], 0);
    assert.equal(attributes['context_projection.tier_t0_bytes'], 0);
    assert.ok(attributes['context_projection.delivery_latency_ms'] >= 0);
    assert.equal(attributes['context_projection.ledger_outcome'], 'no_reservation');

    const serialized = JSON.stringify(attributes);
    for (const forbidden of [
      'PROMPT-BODY-MUST-NOT-LEAK',
      'FINAL-PROJECTION-BODY-MUST-NOT-LEAK',
      'user-secret-id',
      'thread-secret-id',
      'message-secret-id',
      'runtime-secret-id',
      'callback-secret',
    ]) {
      assert.ok(!serialized.includes(forbidden), `trace attributes leaked ${forbidden}`);
    }

    const { resourceMetrics } = await metricExporter.collect();
    const prometheus = new PrometheusSerializer().serialize(resourceMetrics);
    for (const metric of [
      'cat_cafe_context_projection_transition_total',
      'cat_cafe_context_projection_tier_count',
      'cat_cafe_context_projection_tier_bytes',
      'cat_cafe_context_projection_delivery_latency',
      'cat_cafe_context_projection_ledger_outcome_total',
    ]) {
      assert.ok(prometheus.includes(metric), `production seam did not export ${metric}`);
    }
    for (const label of [
      'context_projection_disposition="fresh"',
      'context_projection_reason="no_prior_session"',
      'context_projection_transition="scope_first_seen"',
      'context_projection_mode="cold"',
      'context_projection_delta_size="small"',
      'context_projection_tier="T0"',
      'context_projection_ledger_outcome="no_reservation"',
    ]) {
      assert.ok(prometheus.includes(label), `bounded label missing after F152 allowlist: ${label}`);
    }
    for (const forbidden of [
      'PROMPT-BODY-MUST-NOT-LEAK',
      'FINAL-PROJECTION-BODY-MUST-NOT-LEAK',
      'user-secret-id',
      'thread-secret-id',
      'message-secret-id',
      'runtime-secret-id',
      'invocation-secret-id',
    ]) {
      assert.ok(!prometheus.includes(forbidden), `metric export leaked ${forbidden}`);
    }
  });
});
