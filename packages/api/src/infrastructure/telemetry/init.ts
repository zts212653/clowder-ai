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
import { BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
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
  /**
   * TELEMETRY_DEBUG: emit UNREDACTED spans to console via ConsoleSpanExporter.
   * Default-deny: only allowed in NODE_ENV=development|test.
   * All other environments (including unset NODE_ENV from profile-driven
   * startup) require TELEMETRY_DEBUG_FORCE=true.
   */
  debugMode?: boolean;
}

/**
 * Default-deny guardrail for TELEMETRY_DEBUG.
 *
 * Returns true only when debug is requested AND the environment is safe:
 * - NODE_ENV=development or NODE_ENV=test → allowed
 * - Any other NODE_ENV (including unset, which is the normal state for
 *   profile-driven startup via start-dev.sh --profile=production/opensource)
 *   → blocked unless TELEMETRY_DEBUG_FORCE=true
 *
 * Exported for direct testing of guardrail logic.
 */
export function shouldEnableDebugMode(requested: boolean): boolean {
  if (!requested) return false;
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') return true;
  return process.env.TELEMETRY_DEBUG_FORCE === 'true';
}

const DEFAULT_CONFIG: Required<TelemetryConfig> = {
  serviceName: 'cat-cafe-api',
  serviceVersion: '0.1.0',
  prometheusPort: process.env.PROMETHEUS_PORT ? Number(process.env.PROMETHEUS_PORT) : 9464,
  otlpEnabled: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  debugMode: process.env.TELEMETRY_DEBUG === 'true',
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

  // Apply default-deny guardrail to debugMode regardless of source (env or config param).
  const debugRequested = cfg.debugMode;
  cfg.debugMode = shouldEnableDebugMode(cfg.debugMode ?? false);
  if (debugRequested && !cfg.debugMode) {
    log.warn('TELEMETRY_DEBUG blocked — NODE_ENV is not development/test (set TELEMETRY_DEBUG_FORCE=true to override)');
  }

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

  // --- Traces: build span processor pipeline ---
  // ORDERING MATTERS: debug exporter must come BEFORE RedactingSpanProcessor.
  // RedactingSpanProcessor.onEnd() mutates shared span.attributes in-place;
  // SimpleSpanProcessor.onEnd() calls export() synchronously, so the debug
  // exporter captures unredacted values before the redactor runs.
  const spanProcessors: import('@opentelemetry/sdk-trace-node').SpanProcessor[] = [];
  if (cfg.debugMode) {
    log.warn('TELEMETRY_DEBUG enabled — spans exported UNREDACTED to console. Do NOT use in production.');
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }
  if (cfg.otlpEnabled) {
    spanProcessors.push(new RedactingSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter())));
  }

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
    spanProcessors,
    metricReaders,
    logRecordProcessors: logProcessor ? [logProcessor] : [],
    views,
  });

  sdk.start();
  log.info(
    {
      prometheus: cfg.prometheusPort,
      otlp: cfg.otlpEnabled,
      debug: cfg.debugMode,
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
