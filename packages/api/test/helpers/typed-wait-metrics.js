import { metrics } from '@opentelemetry/api';
import { PrometheusExporter, PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { buildEventBackedRoutingExitEval } from '../../dist/infrastructure/harness-eval/f177-event-backed-routing-eval.js';
import {
  routingEventWaitFalseBypassTotal,
  routingEventWaitRejectedTotal,
} from '../../dist/infrastructure/telemetry/instruments.js';
import { createMetricAllowlistViews } from '../../dist/infrastructure/telemetry/metric-allowlist.js';
import { parsePrometheusText } from '../../dist/infrastructure/telemetry/metrics-snapshot-store.js';

export function createTypedWaitMetricReader() {
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter], views: createMetricAllowlistViews() });
  metrics.setGlobalMeterProvider(provider);
  routingEventWaitFalseBypassTotal.add(0);
  routingEventWaitRejectedTotal.add(0);
  return {
    async read() {
      const { resourceMetrics } = await exporter.collect();
      const text = new PrometheusSerializer().serialize(resourceMetrics);
      const component = buildEventBackedRoutingExitEval(parsePrometheusText(text));
      return {
        text,
        falseBypass: component.frictionCounts['event_wait.false_bypass_total'],
        ...component.activationCounts,
      };
    },
    async close() {
      await provider.shutdown();
      metrics.disable();
    },
  };
}
