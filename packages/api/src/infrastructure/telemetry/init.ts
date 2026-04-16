/**
 * F152: OpenTelemetry SDK initialization — unified entry point.
 *
 * Three signals (traces, metrics, logs) share one NodeSDK instance.
 * Disabled via OTEL_SDK_DISABLED=true for zero overhead.
 *
 * Usage: import { initTelemetry } from './infrastructure/telemetry/init.js';
 *        const shutdown = initTelemetry();  // call at startup
 *        // on graceful shutdown: await shutdown();
 */

import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { createModuleLogger } from '../logger.js';
import { validateSalt } from './hmac.js';
import { createMetricAllowlistViews } from './metric-allowlist.js';
import { RedactingLogProcessor, RedactingSpanProcessor } from './redactor.js';

const log = createModuleLogger('telemetry');

export interface TelemetryConfig {
  serviceName?: string;
  serviceVersion?: string;
  /** Port for Prometheus /metrics scrape endpoint. Default: 9464 */
  prometheusPort?: number;
  /** Set true to also export via OTLP (requires OTEL_EXPORTER_OTLP_ENDPOINT). */
  otlpEnabled?: boolean;
}

const DEFAULT_CONFIG: Required<TelemetryConfig> = {
  serviceName: 'cat-cafe-api',
  serviceVersion: '0.1.0',
  prometheusPort: process.env.PROMETHEUS_PORT ? Number(process.env.PROMETHEUS_PORT) : 9464,
  otlpEnabled: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
};

let sdk: NodeSDK | null = null;

/**
 * Initialize OTel SDK. Returns an async shutdown function.
 * No-op if OTEL_SDK_DISABLED=true.
 */
export function initTelemetry(config?: TelemetryConfig): () => Promise<void> {
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    log.info('OTel SDK disabled (OTEL_SDK_DISABLED=true)');
    return async () => {};
  }

  const cfg = { ...DEFAULT_CONFIG, ...config };

  // P2 fix: validate HMAC salt at startup, not on first redaction call.
  // If salt is missing in non-dev environments, disable OTel gracefully
  // rather than crashing the server — telemetry should never be a crash source.
  try {
    validateSalt();
  } catch (err) {
    log.error({ err }, 'OTel SDK disabled: HMAC salt validation failed');
    return async () => {};
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_SERVICE_VERSION]: cfg.serviceVersion,
  });

  // --- Traces: Redacting processor wraps OTLP exporter ---
  const spanProcessor = cfg.otlpEnabled
    ? new RedactingSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()))
    : undefined;

  // --- Metrics: Prometheus scrape + optional OTLP push ---
  const prometheusExporter = new PrometheusExporter({
    port: cfg.prometheusPort,
    preventServerStart: false,
  });

  const metricReaders: import('@opentelemetry/sdk-metrics').IMetricReader[] = [prometheusExporter];
  if (cfg.otlpEnabled) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
      }),
    );
  }

  // --- Logs: Redacting processor wraps OTLP exporter ---
  const logProcessor = cfg.otlpEnabled
    ? new RedactingLogProcessor(new BatchLogRecordProcessor(new OTLPLogExporter()))
    : undefined;

  // --- Views: enforce metric attribute allowlist ---
  const views = createMetricAllowlistViews();

  sdk = new NodeSDK({
    resource,
    spanProcessors: spanProcessor ? [spanProcessor] : [],
    metricReaders,
    logRecordProcessors: logProcessor ? [logProcessor] : [],
    views,
  });

  sdk.start();
  log.info(
    {
      prometheus: cfg.prometheusPort,
      otlp: cfg.otlpEnabled,
    },
    'OTel SDK initialized',
  );

  return async () => {
    if (sdk) {
      await sdk.shutdown();
      sdk = null;
      log.info('OTel SDK shut down');
    }
  };
}
