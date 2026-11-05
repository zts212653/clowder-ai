import { PerformanceObserver } from 'node:perf_hooks';

const sqliteSource = '2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618';
const numeric = (value) => (Number.isFinite(value) ? value : null);
const pick = (value, keys) => (value ? Object.fromEntries(keys.map((key) => [key, numeric(value[key])])) : null);
const difference = (before, after) =>
  before && after
    ? Object.fromEntries(
        Object.keys(before).map((key) => [
          key,
          before[key] === null || after[key] === null ? null : after[key] - before[key],
        ]),
      )
    : null;

function observeGc(callback) {
  const collect = (entries) => {
    for (const entry of entries) callback(entry);
  };
  const observer = new PerformanceObserver((list) => collect(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  return { drain: () => collect(observer.takeRecords()), close: () => observer.disconnect() };
}

/** Test-only: no SQL, filesystem reads, resource sampling or logging inside prepare/run wrappers. */
export function createIndexWriterDiagnostics(database, options = {}) {
  const now = options.now ?? (() => performance.now());
  let observerErrors = 0;
  const safe = (operation) => {
    try {
      return operation();
    } catch {
      observerErrors++;
      return null;
    }
  };
  const resources = () => ({
    cpu: pick(safe(options.cpuUsage ?? (() => process.cpuUsage())), ['user', 'system']),
    threadCpu: pick(safe(options.threadCpuUsage ?? (() => process.threadCpuUsage?.())), ['user', 'system']),
    io: pick(safe(options.resourceUsage ?? (() => process.resourceUsage())), [
      'fsRead',
      'fsWrite',
      'voluntaryContextSwitches',
      'involuntaryContextSwitches',
    ]),
  });
  const identity = safe(() =>
    database.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get(),
  );
  const sqlite = {
    version: /^\d+\.\d+\.\d+$/.test(identity?.version) ? identity.version : null,
    noopSupported: identity?.version === '3.51.3' && identity?.sourceId === sqliteSource,
    sourceId: identity?.sourceId === sqliteSource ? sqliteSource : null,
    pragmas: Object.fromEntries(
      ['synchronous', 'wal_autocheckpoint', 'busy_timeout', 'page_size'].map((key) => [
        key,
        numeric(safe(() => database.pragma(key, { simple: true }))),
      ]),
    ),
  };
  // Same verified 3.51.3 parser as the owned NOOP capability fixture. Unknown
  // mode strings can fall back to PASSIVE: never probe an unverified version.
  // NOOP copies no frames but briefly takes a checkpoint lock; samples are sparse.
  let walSamples = 0;
  const readWal = (phase) => {
    if (!sqlite.noopSupported) return null;
    walSamples++;
    const state = safe(() => database.pragma('main.wal_checkpoint(NOOP)')[0]);
    return state ? { phase, sampledAt: now(), ...pick(state, ['busy', 'log', 'checkpointed']) } : null;
  };
  let phase = 'before-rebuild';
  let baseline = readWal(phase);
  let passageBaselineTaken = false;
  let current;
  let sampleCount = 0;
  let slowWriteCount = 0;
  let worstWrite = null;
  const slowWrites = [];
  const gcEntries = [];
  let gcCount = 0;
  let gcMaxMs = 0;
  const overlap = (sample, entry) =>
    Math.max(
      0,
      Math.min(sample.startedAt + sample.elapsedMs, entry.startTime + entry.durationMs) -
        Math.max(sample.startedAt, entry.startTime),
    );
  const gcObserver = safe(() =>
    (options.observeGc ?? observeGc)((entry) => {
      if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) return;
      const record = { startTime: entry.startTime, durationMs: entry.duration };
      gcCount++;
      gcMaxMs = Math.max(gcMaxMs, record.durationMs);
      gcEntries.push(record);
      if (gcEntries.length > 256) gcEntries.shift();
      for (const sample of new Set([worstWrite, ...slowWrites])) {
        if (sample) sample.gcOverlapMs += overlap(sample, record);
      }
    }),
  );
  const timed = (name, operation) => {
    const began = now();
    try {
      return operation();
    } finally {
      if (current) current.stages[name] += now() - began;
    }
  };
  const ledgerDatabase = new Proxy(database, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = timed('prepareMs', () => target.prepare(sql));
        return new Proxy(statement, {
          get(stmt, method) {
            if (method === 'run') return (...args) => timed('runMs', () => stmt.run(...args));
            const value = Reflect.get(stmt, method, stmt);
            return typeof value === 'function' ? value.bind(stmt) : value;
          },
        });
      };
    },
  });
  return {
    database: ledgerDatabase,
    beforeWrite(passageCount) {
      current = {
        phase,
        passageCount,
        beforeTransaction: Boolean(database.inTransaction),
        stages: { prepareMs: 0, runMs: 0 },
        beforeResources: resources(),
        walBefore: baseline,
      };
    },
    afterWrite({ startedAt, elapsedMs }) {
      const after = resources();
      const sample = {
        phase: current.phase,
        passageCount: current.passageCount,
        startedAt,
        elapsedMs,
        stages: current.stages,
        beforeTransaction: current.beforeTransaction,
        afterTransaction: Boolean(database.inTransaction),
        walBefore: current.walBefore,
        walAfter: null,
        resources: {
          processCpuUs: difference(current.beforeResources.cpu, after.cpu),
          threadCpuUs: difference(current.beforeResources.threadCpu, after.threadCpu),
          io: difference(current.beforeResources.io, after.io),
        },
        gcOverlapMs: 0,
      };
      current = undefined;
      sampleCount++;
      sample.gcOverlapMs = gcEntries.reduce((total, entry) => total + overlap(sample, entry), 0);
      if (elapsedMs >= 100) {
        slowWriteCount++;
        // Outside the original stopwatch, only on the failure path, bounded.
        if (slowWrites.length < 4) {
          sample.walAfter = readWal(phase);
          slowWrites.push(sample);
        }
      }
      if (!worstWrite || elapsedMs > worstWrite.elapsedMs) worstWrite = sample;
    },
    phase(next) {
      if (/^[a-z-]{1,40}$/.test(next)) phase = next;
      if (phase === 'thread-passages' && !passageBaselineTaken) {
        passageBaselineTaken = true;
        baseline = readWal(phase);
      }
    },
    summary() {
      safe(() => gcObserver?.drain());
      return {
        schemaVersion: 1,
        platform: options.platform ?? process.platform,
        sqlite,
        sampleCount,
        slowWriteCount,
        worstWrite,
        slowWrites,
        gc: { count: gcCount, maxMs: gcMaxMs, retained: gcEntries.length },
        walSamples,
        observerErrors,
        boundary:
          'WAL before is a sparse phase baseline, not an immediate pre-write snapshot. NOOP briefly locks; CPU/I/O counters are process-wide and platform-dependent.',
      };
    },
    close() {
      safe(() => gcObserver?.close());
    },
  };
}
