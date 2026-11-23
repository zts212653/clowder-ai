import { type Profiler, Session } from 'node:inspector';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { ProfilerControlTimeline } from './event-loop-tripwire-controls.js';
import { openTripwireLog } from './event-loop-tripwire-log.js';
import type { TripwireProfileSegment } from './event-loop-tripwire-profile.js';
import { tripwireReport } from './event-loop-tripwire-report.js';
import { EventLoopTripwireState, type LoopStallSpan } from './event-loop-tripwire-state.js';

if (isMainThread || !parentPort) throw new Error('tripwire_requires_worker');
const port = parentPort;
const options = workerData as {
  shared: SharedArrayBuffer;
  heartbeatMs: number;
  thresholdMs: number;
  windowMs: number;
  samplingIntervalUs: number;
  logDir: string;
  bootId?: string;
};
const sink = openTripwireLog(options.logDir);
const heartbeat = new BigInt64Array(options.shared, 0, 1);
const controls = new Int32Array(options.shared, 8, 2);
const state = new EventLoopTripwireState(options.heartbeatMs, options.thresholdMs);
const controlTimeline = new ProfilerControlTimeline();
const session = new Session();
session.connectToMainThread();
let bootId = options.bootId;
let current: { requested: number; acknowledged: number; epoch: number } | undefined;
let last: TripwireProfileSegment | undefined;
let epoch = 0;
let enabled = false;
let ready = false;
let closed = false;
let sinkFailed = false;
let capturing = false;
let operationQueued = false;
let healthySince: number | undefined;
let queue = Promise.resolve();
const pending = new Set<LoopStallSpan>();
const completed = new WeakSet<LoopStallSpan>();
const cursors = new WeakMap<LoopStallSpan, number>();
const notifications = new WeakMap<LoopStallSpan, number>();
const readHeartbeat = () => Number(Atomics.load(heartbeat, 0)) / 1000;

function emit(report: object) {
  const record = { pid: process.pid, bootId, observedAt: Date.now(), ...report };
  const result = sink.write(record);
  if (result.summary) port.postMessage({ type: 'report', report: { pid: process.pid, bootId, ...result.summary } });
  if (result.status === 'suppressed') return;
  const independentRecord = result.status === 'written';
  if (!independentRecord && !sinkFailed) {
    sinkFailed = true;
    port.postMessage({ type: 'status', status: 'unavailable', reason: 'independent_log_failed' });
  }
  port.postMessage({ type: 'report', report: { ...record, independentRecord } });
}

function notify(span: LoopStallSpan, phase: 'onset' | 'still_blocked' | 'recovered') {
  const now = performance.now();
  notifications.set(span, now);
  emit({
    kind: 'event_loop_stall',
    phase,
    episode: `${process.pid}:${Math.round(span.startMs * 1000)}`,
    startMs: span.startMs,
    thresholdMs: options.thresholdMs,
    attribution: current || capturing ? 'pending' : 'unknown',
    reason: span.reason ?? (current || capturing ? 'sample_pending' : missingProfileReason(span)),
    controlOverlapMs: controlTimeline.overlap(span.startMs, span.endMs ?? now),
    topFrames: [],
    // Notification only, never a second duration to add to the timed profile intervals.
  });
}

async function command(method: string, params: object = {}) {
  const entered = performance.now();
  controlTimeline.begin(entered);
  try {
    return await new Promise<{ profile?: Profiler.Profile }>((resolve, reject) => {
      session.post(method, params, (error, response) =>
        error ? reject(error) : resolve((response ?? {}) as { profile?: Profiler.Profile }),
      );
    });
  } finally {
    const acknowledged = performance.now();
    controlTimeline.finish(acknowledged);
    port.postMessage({ type: 'beat' });
    if (method === 'Profiler.start' || method === 'Profiler.stop')
      emit({
        kind: 'event_loop_profiler_control',
        method,
        requestedAtMs: entered,
        acknowledgedAtMs: acknowledged,
        controlMs: acknowledged - entered,
      });
  }
}

function schedule(run: () => Promise<void>) {
  queue = queue.then(run).catch(() => {
    port.postMessage({ type: 'status', status: 'unavailable', reason: 'profiler_failed' });
    void shutdown().catch(() => port.close());
  });
}

function publish(span: LoopStallSpan) {
  if (completed.has(span)) return;
  const end = span.endMs ?? performance.now();
  const from = cursors.get(span) ?? span.startMs;
  const segments = last && last.stopAcknowledgedMs >= from ? [last] : [];
  if (end > from || span.reason) {
    emit({
      ...tripwireReport(
        span,
        end,
        from,
        segments,
        options.thresholdMs,
        segments.length ? undefined : missingProfileReason(span),
      ),
      controlOverlapMs: controlTimeline.overlap(from, end),
    });
    cursors.set(span, end);
  }
  if (span.endMs !== undefined) {
    completed.add(span);
    pending.delete(span);
  }
}

function missingProfileReason(span: LoopStallSpan) {
  if (Atomics.load(controls, 0)) return 'profiler_paused';
  if (cursors.has(span)) return 'stopped_during_stall';
  return ready ? 'sampler_rearming' : 'sampler_not_ready';
}

function finishSpan(span: LoopStallSpan) {
  pending.add(span);
  if (span.reason) {
    epoch++;
    last = undefined;
    publish(span);
    if (current && !operationQueued) queueStop();
  } else if (capturing || current) notify(span, 'recovered');
  else publish(span);
}

function observe() {
  if (closed) return;
  const now = performance.now();
  const beat = readHeartbeat();
  const previous = state.current;
  const finished = state.poll(now, Date.now(), beat);
  if (now - beat <= options.heartbeatMs * 2 && !state.current) healthySince ??= now;
  else healthySince = undefined;
  if (finished) finishSpan(finished);
  const opened = state.current;
  if (opened && opened !== previous) {
    // Never wait for an Inspector callback: uninterruptible native calls must still leave this record.
    notify(opened, 'onset');
    if (current && !operationQueued) {
      queueStop();
    }
  }
  if (opened && now - (notifications.get(opened) ?? now) >= 5000) notify(opened, 'still_blocked');
  if (!opened && pending.size === 0 && !capturing) controlTimeline.prune(beat);
}

function queueStop() {
  operationQueued = true;
  schedule(async () => {
    try {
      await stopProfile();
    } finally {
      operationQueued = false;
    }
  });
}

async function stopProfile() {
  if (!current) return;
  const active = current;
  current = undefined;
  capturing = true;
  try {
    // Stop is cheaper than starting a successor; do not add a heap-sized start to an existing stall.
    const stopRequestedMs = performance.now();
    const { profile } = await command('Profiler.stop');
    if (!profile) throw Error('profile_missing');
    last =
      active.epoch === epoch
        ? {
            profile,
            startRequestedMs: active.requested,
            startAcknowledgedMs: active.acknowledged,
            stopRequestedMs,
            stopAcknowledgedMs: performance.now(),
          }
        : undefined;
    observe();
    for (const span of pending) publish(span);
    if (state.current) publish(state.current);
  } finally {
    capturing = false;
    healthySince = undefined;
  }
}

function canArm() {
  return (
    !closed &&
    !state.current &&
    Atomics.load(controls, 0) === 0 &&
    performance.now() - readHeartbeat() <= options.heartbeatMs * 2
  );
}

async function arm() {
  if (!canArm()) return;
  if (!enabled) {
    await command('Profiler.enable');
    enabled = true;
  }
  if (!canArm()) return;
  await command('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs });
  if (!canArm()) return;
  const requested = performance.now();
  await command('Profiler.start');
  current = { requested, acknowledged: performance.now(), epoch };
  last = undefined;
  port.postMessage({ type: 'status', status: 'sampler_ready', armedAt: Date.now() });
  if (!ready) {
    ready = true;
    port.postMessage({ type: 'ready' });
  }
}

async function pause() {
  observe();
  await stopProfile();
  for (const span of pending) publish(span);
  last = undefined;
  healthySince = undefined;
}

async function shutdown() {
  if (closed) return;
  observe();
  closed = true;
  clearInterval(timer);
  try {
    await pause();
  } finally {
    try {
      session.disconnect();
    } catch {
      /* Always close the independent sink and port. */
    }
    const summary = sink.close();
    if (summary) port.postMessage({ type: 'report', report: { pid: process.pid, bootId, ...summary } });
    port.postMessage({ type: 'closed' });
    port.close();
  }
}

port.on('message', (message: { type: string; id?: number; bootId?: string }) => {
  if (message.type === 'boot') bootId = message.bootId;
  if (message.type === 'close') schedule(shutdown);
  if (message.type === 'pause')
    schedule(async () => {
      await pause();
      port.postMessage({ type: 'paused', id: message.id });
    });
  // Resume is deliberately deferred to the next healthy/idle observation.
  if (message.type === 'resume') healthySince = undefined;
});
const timer = setInterval(() => {
  observe();
  if (closed || operationQueued) return;
  if (!ready && Atomics.load(controls, 0) !== 0) {
    ready = true;
    port.postMessage({ type: 'ready' });
  }
  const expired = current && performance.now() - current.acknowledged >= options.windowMs;
  if (current && (state.current || expired)) {
    queueStop();
  } else if (!current && healthySince !== undefined && performance.now() - healthySince >= 100 && canArm()) {
    operationQueued = true;
    schedule(async () => {
      try {
        await arm();
      } finally {
        operationQueued = false;
      }
    });
  }
}, options.heartbeatMs);
