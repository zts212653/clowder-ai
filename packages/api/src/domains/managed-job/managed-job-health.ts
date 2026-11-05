import { existsSync, statSync } from 'node:fs';
import { metrics, trace } from '@opentelemetry/api';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { STATUS } from '../../infrastructure/telemetry/genai-semconv.js';
import type { DurableGateInspection, DurableManagedGateJob } from './managed-job-types.js';

const log = createModuleLogger('managed-job/health');
const processStartedAt = Date.now() - process.uptime() * 1000;
const seen = new Map<string, { signature: string; adopted: boolean }>();
const states = [
  'unknown',
  'queued',
  'running',
  'waiting',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
];
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {});
const number = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** This census describes persisted job evidence; it never claims to enumerate every OS process. */
export function summarizeManagedJobHealth(
  history: readonly RecordValue[],
  inspection: DurableGateInspection['state'],
  now: number,
) {
  const latest = history.at(-1) ?? {};
  const born = number(latest.createdAt);
  const started = history.find((entry) => ['running', 'waiting', 'cancelling'].includes(String(entry.state)));
  const result = record(latest.result);
  const tokens = new Set(
    history.flatMap((entry) => (typeof entry.attemptToken === 'string' ? [entry.attemptToken] : [])),
  );
  const epochs = new Map<number, Set<string>>();
  for (const entry of history) {
    if (typeof entry.attemptToken !== 'string') continue;
    const epoch = number(entry.attemptResumeEpoch);
    const attempts = epochs.get(epoch) ?? new Set<string>();
    attempts.add(entry.attemptToken);
    epochs.set(epoch, attempts);
  }
  const terminal = latest.state === 'terminal';
  const status =
    latest.terminalStatus === 'green'
      ? 'succeeded'
      : latest.terminalStatus === 'partial'
        ? 'failed'
        : latest.terminalStatus;
  const state = String(terminal ? status : latest.state);
  return {
    state: states.includes(state) ? state : 'unknown',
    queueDurationMs: started
      ? Math.max(0, number(started.updatedAt) - born)
      : terminal || !born
        ? null
        : Math.max(0, now - born),
    runtimeDurationMs: terminal
      ? number(result.durationMs)
      : started
        ? Math.max(0, now - number(started.updatedAt))
        : 0,
    logBytes: number(record(result.log).bytes),
    duplicateAttempts: [...epochs.values()].reduce((total, attempts) => total + Math.max(0, attempts.size - 1), 0),
    unresolvedExecution: !terminal && inspection === 'pending' && tokens.size > 0 && latest.cleanupProven !== true,
    userMessageCancellation: record(latest.cancel).reason === 'user_message',
  };
}

export type ManagedJobHealth = ReturnType<typeof summarizeManagedJobHealth>;
let census: Record<string, number> = {};
let instruments: { adoption: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> } | undefined;
function telemetry() {
  if (!instruments) {
    const meter = metrics.getMeter('cat-cafe-api', '0.1.0');
    for (const [key, name, unit] of [
      ['unresolved', 'unresolved_execution', '{job}'],
      ['duplicates', 'duplicate_attempts', '{attempt}'],
      ['userCancel', 'user_message_cancel', '{job}'],
      ['logBytes', 'log_volume', 'By'],
      ['queueMs', 'max_queue_duration', 'ms'],
      ['runtimeMs', 'max_runtime_duration', 'ms'],
    ]) {
      meter
        .createObservableGauge(`cat_cafe.managed_job.${name}`, { unit })
        .addCallback((result) => result.observe(census[key] ?? 0));
    }
    meter.createObservableGauge('cat_cafe.managed_job.census').addCallback((result) => {
      for (const state of states) result.observe(census[state] ?? 0, { [STATUS]: state });
    });
    instruments = { adoption: meter.createHistogram('cat_cafe.managed_job.restart_adoption_latency', { unit: 'ms' }) };
  }
  return instruments;
}

export function collectManagedJobHealth(
  job: DurableManagedGateJob,
  inspection: DurableGateInspection,
  history: readonly RecordValue[],
  now: number,
): ManagedJobHealth {
  const health = summarizeManagedJobHealth(history, inspection.state, now);
  try {
    if (existsSync(job.logPath)) health.logBytes = statSync(job.logPath).size;
  } catch {
    // Log rotation must not block job reconciliation; the terminal hash receipt remains authoritative.
  }
  return health;
}

/** The API owns observation deduplication even when I/O ran in a short-lived worker. */
export function observeManagedJobHealthSnapshot(
  job: DurableManagedGateJob,
  inspection: DurableGateInspection,
  health: ManagedJobHealth,
  latest: RecordValue,
  now: number,
): ManagedJobHealth {
  const revision = number(latest.revision) || number(latest.updatedAt);
  const previous = seen.get(job.jobId);
  const signature = `${revision}:${inspection.state}`;
  if (previous?.signature !== signature) {
    const adoptionLatencyMs =
      !previous?.adopted && number(latest.createdAt) < processStartedAt && inspection.state === 'adopted'
        ? Math.max(0, now - processStartedAt)
        : undefined;
    if (adoptionLatencyMs !== undefined) telemetry().adoption.record(adoptionLatencyMs);
    const fields = {
      jobId: job.jobId,
      originTaskId: job.originTaskId,
      originInvocationId: job.definition?.originInvocationId,
      revision,
      inspection: inspection.state,
      observation: previous === undefined ? 'snapshot' : 'change',
      adoptionLatencyMs,
      ...health,
    };
    if (health.unresolvedExecution || health.duplicateAttempts > 0 || health.userMessageCancellation)
      log.warn(fields, 'Managed job evidence needs attention');
    else log.info(fields, 'Managed job evidence observed');
    const span = trace.getTracer('cat-cafe-managed-job').startSpan('cat_cafe.managed_job.observe', {
      attributes: {
        'job.id': job.jobId,
        'job.origin_task_id': job.originTaskId,
        'job.revision': revision,
        'job.state': health.state,
        ...(health.queueDurationMs === null ? {} : { 'job.queue_ms': health.queueDurationMs }),
        'job.runtime_ms': health.runtimeDurationMs,
        'job.log_bytes': health.logBytes,
        'job.unresolved_execution': health.unresolvedExecution,
        'job.duplicate_attempts': health.duplicateAttempts,
        ...(adoptionLatencyMs === undefined ? {} : { 'job.restart_adoption_ms': adoptionLatencyMs }),
      },
    });
    span.end();
    if (seen.size >= 4096) seen.delete(seen.keys().next().value!);
    seen.set(job.jobId, { signature, adopted: previous?.adopted === true || inspection.state === 'adopted' });
  }
  return health;
}

export function observeManagedJobHealth(
  job: DurableManagedGateJob,
  inspection: DurableGateInspection,
  history: readonly RecordValue[],
  now: number,
): ManagedJobHealth {
  return observeManagedJobHealthSnapshot(
    job,
    inspection,
    collectManagedJobHealth(job, inspection, history, now),
    history.at(-1) ?? {},
    now,
  );
}

export function publishManagedJobCensus(health: readonly ManagedJobHealth[]): void {
  telemetry();
  census = {};
  for (const sample of health) {
    census[sample.state] = (census[sample.state] ?? 0) + 1;
    census.unresolved = (census.unresolved ?? 0) + Number(sample.unresolvedExecution);
    census.duplicates = (census.duplicates ?? 0) + sample.duplicateAttempts;
    census.userCancel = (census.userCancel ?? 0) + Number(sample.userMessageCancellation);
    census.logBytes = (census.logBytes ?? 0) + sample.logBytes;
    census.queueMs = Math.max(census.queueMs ?? 0, sample.state === 'queued' ? (sample.queueDurationMs ?? 0) : 0);
    census.runtimeMs = Math.max(
      census.runtimeMs ?? 0,
      ['running', 'waiting', 'cancelling'].includes(sample.state) ? sample.runtimeDurationMs : 0,
    );
  }
}
