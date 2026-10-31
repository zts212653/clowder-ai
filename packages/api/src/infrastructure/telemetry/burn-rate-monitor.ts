/**
 * F153 Phase E L3: Burn-rate threshold monitor.
 *
 * Periodically reads in-process Prometheus metrics and checks against
 * configurable thresholds. Fires a callback after N consecutive breaches
 * (debouncing), auto-clears when metrics recover.
 *
 * Does NOT depend on SocketManager — caller wires the notification callback.
 */

import { createModuleLogger } from '../logger.js';
import { parsePrometheusText } from './metrics-snapshot-store.js';

const log = createModuleLogger('burn-rate');

export interface BurnRateThresholds {
  /** Error rate threshold (0-1). Default: 0.3 (30%). */
  errorRate: number;
  /** P95 latency threshold in seconds. Default: 120. */
  p95LatencyS: number;
  /** Active invocations threshold. Default: 50. */
  activeInvocations: number;
}

export interface BurnRateAlert {
  metric: string;
  currentValue: number;
  threshold: number;
}

export interface BurnRateMonitorConfig {
  /** Metrics reader function — returns Prometheus text. */
  getMetricsText: () => Promise<string>;
  /** Callback when alert state changes (fires on breach, clears on recovery). */
  onAlert: (alerts: BurnRateAlert[]) => void;
  onClear: () => void;
  /** Check interval in ms. Default: 60000. */
  intervalMs?: number;
  /** Consecutive breach count before firing alert. Default: 3. */
  debounceCount?: number;
  thresholds?: Partial<BurnRateThresholds>;
}

const DEFAULT_THRESHOLDS: BurnRateThresholds = {
  errorRate: Number.parseFloat(process.env.TELEMETRY_ALERT_ERROR_RATE ?? '0.3'),
  p95LatencyS: Number.parseFloat(process.env.TELEMETRY_ALERT_P95_LATENCY_S ?? '120'),
  activeInvocations: Number.parseInt(process.env.TELEMETRY_ALERT_ACTIVE_INVOCATIONS ?? '50', 10),
};

export class BurnRateMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveBreaches = 0;
  private alertActive = false;
  private readonly config: Required<Omit<BurnRateMonitorConfig, 'thresholds'>> & {
    thresholds: BurnRateThresholds;
  };

  constructor(config: BurnRateMonitorConfig) {
    this.config = {
      getMetricsText: config.getMetricsText,
      onAlert: config.onAlert,
      onClear: config.onClear,
      intervalMs: config.intervalMs ?? 60_000,
      debounceCount: config.debounceCount ?? 3,
      thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.config.intervalMs);
    this.timer.unref();
    log.info({ intervalMs: this.config.intervalMs }, 'Burn-rate monitor started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for testing — run one check cycle. */
  async check(): Promise<void> {
    try {
      const text = await this.config.getMetricsText();
      const metrics = parsePrometheusText(text);
      const alerts = this.evaluate(metrics);

      if (alerts.length > 0) {
        this.consecutiveBreaches++;
        if (this.consecutiveBreaches >= this.config.debounceCount && !this.alertActive) {
          this.alertActive = true;
          this.config.onAlert(alerts);
          log.warn({ alerts, streak: this.consecutiveBreaches }, 'Burn-rate alert triggered');
        }
      } else {
        if (this.alertActive) {
          this.alertActive = false;
          this.config.onClear();
          log.info('Burn-rate alert cleared');
        }
        this.consecutiveBreaches = 0;
      }
    } catch {
      log.warn('Burn-rate check failed — skipping cycle');
    }
  }

  /** Evaluate current metrics against thresholds. */
  private evaluate(metrics: Record<string, number>): BurnRateAlert[] {
    const alerts: BurnRateAlert[] = [];
    const t = this.config.thresholds;

    const errorRate = this.computeErrorRate(metrics);
    if (errorRate !== null && errorRate > t.errorRate) {
      alerts.push({ metric: 'error_rate', currentValue: errorRate, threshold: t.errorRate });
    }

    const p95 = this.findP95Latency(metrics);
    if (p95 !== null && p95 > t.p95LatencyS) {
      alerts.push({ metric: 'p95_latency_s', currentValue: p95, threshold: t.p95LatencyS });
    }

    const active = metrics['cat_cafe_active_invocations'] ?? null;
    if (active !== null && active > t.activeInvocations) {
      alerts.push({ metric: 'active_invocations', currentValue: active, threshold: t.activeInvocations });
    }

    return alerts;
  }

  private computeErrorRate(metrics: Record<string, number>): number | null {
    let okTotal = 0;
    let errorTotal = 0;
    for (const [key, value] of Object.entries(metrics)) {
      if (!key.startsWith('cat_cafe_invocation_completed')) continue;
      if (key.includes('status="ok"')) okTotal += value;
      else if (key.includes('status="error"')) errorTotal += value;
    }
    const total = okTotal + errorTotal;
    if (total === 0) return null;
    return errorTotal / total;
  }

  private findP95Latency(metrics: Record<string, number>): number | null {
    // Only use summary quantile — histogram bucket values are cumulative counts,
    // not latency seconds. Using le="120" count as seconds would cause false alerts.
    for (const [key, value] of Object.entries(metrics)) {
      if (key.startsWith('cat_cafe_cat_response_duration') && key.includes('quantile="0.95"')) {
        return value;
      }
    }
    return null;
  }

  isAlertActive(): boolean {
    return this.alertActive;
  }
}
