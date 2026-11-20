import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const threads = require('node:worker_threads');
const NativeWorker = threads.Worker;
let observerWorker;
threads.Worker = class extends NativeWorker {
  constructor(entry, options) {
    const injected = entry.pathname?.includes('event-loop-tripwire-bootstrap');
    super(
      injected ? new URL('./tripwire-inspector-fault-worker.mjs', import.meta.url) : entry,
      injected
        ? {
            ...options,
            workerData: { ...options.workerData, entry: entry.href, fault: process.argv[2], teardown: process.argv[3] },
          }
        : options,
    );
    if (injected) {
      observerWorker = this;
      this.on('message', (message) => {
        if (message.type === 'test-control') process.send(message);
        if (message.type === 'profiler_state') process.send({ type: 'test-profiler-state', safe: message.safe });
      });
      this.once('exit', (code) => process.send({ type: 'observer-exit', code }));
      this.once('error', (error) => process.send({ type: 'observer-error', code: error.code }));
    }
  }
};
syncBuiltinESMExports();
const { createEventLoopTripwire } = await import('../../dist/infrastructure/telemetry/cpu/event-loop-tripwire.js');
const { acquireCpuProfiler } = await import('../../dist/infrastructure/telemetry/cpu/cpu-profiler-lease.js');
const { recordProcessCpuProfile } = await import('../../dist/infrastructure/telemetry/cpu/process-cpu-session.js');
const keepAlive = setInterval(() => {}, 1000);
const handle = createEventLoopTripwire()({
  logDir: process.argv[4],
  bootId: 'fault-fixture',
  logger: {
    info(entry) {
      process.send({ type: 'log', entry });
    },
  },
});
process.on('message', async (message) => {
  if (message.type === 'block') {
    process.send({ type: 'entered' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    process.send({ type: 'block-done' });
  }
  if (message.type === 'release-disable') observerWorker.postMessage({ type: 'test-release-disable' });
  if (message.type === 'foreground') {
    process.send({ type: 'foreground-pending', id: message.id });
    const release = await acquireCpuProfiler();
    try {
      const capture = release ? await recordProcessCpuProfile(new AbortController().signal, 50) : undefined;
      process.send({ type: 'foreground-result', id: message.id, admitted: Boolean(release), status: capture?.status });
    } finally {
      release?.();
    }
  }
  if (message.type === 'close-observer') {
    await handle.close();
    process.send({ type: 'observer-closed' });
  }
  if (message.type === 'close') {
    await handle.close();
    clearInterval(keepAlive);
    process.disconnect();
  }
});
process.send({ type: 'ready', ready: await handle.ready });
