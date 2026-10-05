import { Worker } from 'node:worker_threads';

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');

  const sync = new Int32Array(workerData.sync);

  async function main() {
    const { TaskOutcomeEpisodeStore } = await import(workerData.storeModuleUrl);
    if (workerData.stallBeforeStore) {
      const stall = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.wait(stall, 0, 0);
    }
    const store = new TaskOutcomeEpisodeStore(workerData.taskOutcomeDbPath);

    Atomics.add(sync, 2, 1);
    Atomics.notify(sync, 2);
    while (Atomics.load(sync, 2) < 2) {
      const observed = Atomics.load(sync, 2);
      Atomics.wait(sync, 2, observed);
    }

    if (workerData.role === 'first') {
      const originalGetEpisode = store.getEpisode.bind(store);
      let pausedAfterFirstRead = false;
      store.getEpisode = (episodeId) => {
        const episode = originalGetEpisode(episodeId);
        if (!pausedAfterFirstRead) {
          pausedAfterFirstRead = true;
          Atomics.store(sync, 0, 1);
          Atomics.notify(sync, 0);
          while (Atomics.load(sync, 1) === 0) Atomics.wait(sync, 1, 0);
          Atomics.wait(sync, 1, 1, 250);
        }
        return episode;
      };
    } else {
      while (Atomics.load(sync, 0) === 0) Atomics.wait(sync, 0, 0);
      Atomics.store(sync, 1, 1);
      Atomics.notify(sync, 1);
    }

    try {
      const result = store.updateVerdictsIdempotently([
        { episodeId: workerData.episodeId, verdict: 'success' },
      ]);
      parentPort.postMessage({ role: workerData.role, result });
    } catch (error) {
      parentPort.postMessage({
        role: workerData.role,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
        },
      });
    } finally {
      if (workerData.role === 'second') {
        Atomics.store(sync, 1, 2);
        Atomics.notify(sync, 1);
      }
    }
  }

  main().catch((error) => parentPort.postMessage({
    role: workerData.role,
    error: { message: error instanceof Error ? error.message : String(error) },
  }));
`;

function runConcurrentVerdictWorker({ role, taskOutcomeDbPath, episodeId, sync, stallBeforeStore = false }) {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      role,
      taskOutcomeDbPath,
      episodeId,
      sync,
      stallBeforeStore,
      storeModuleUrl: new URL(
        '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js',
        import.meta.url,
      ).href,
    },
  });
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onMessage = (message) => settle(() => resolve(message));
    const onError = (error) => settle(() => reject(error));
    const onExit = (code) =>
      settle(() => reject(new Error(`verdict worker exited with code ${code} before reporting an outcome`)));

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
  void result.catch(() => undefined);
  return {
    result,
    async terminate() {
      if (worker.threadId !== -1) await worker.terminate();
    },
  };
}

export async function runTwoConnectionSameValueRace({
  taskOutcomeDbPath,
  episodeId,
  stallFirstBeforeStore = false,
  stallSecondBeforeStore = false,
  timeoutMs = 5_000,
}) {
  const sync = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const workers = [];
  const readiness = new AbortController();
  const run = async () => {
    const first = runConcurrentVerdictWorker({
      role: 'first',
      taskOutcomeDbPath,
      episodeId,
      sync,
      stallBeforeStore: stallFirstBeforeStore,
    });
    workers.push(first);
    await waitForAtomicValue(sync, 2, 1, readiness.signal);
    readiness.signal.throwIfAborted();

    const second = runConcurrentVerdictWorker({
      role: 'second',
      taskOutcomeDbPath,
      episodeId,
      sync,
      stallBeforeStore: stallSecondBeforeStore,
    });
    workers.push(second);
    return Promise.all([first.result, second.result]);
  };

  try {
    return await withTimeout(run(), timeoutMs);
  } finally {
    readiness.abort(new Error('verdict race finished'));
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

function waitForAtomicValue(buffer, index, expected, signal) {
  const sync = new Int32Array(buffer);
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const poll = () => {
      if (signal.aborted) return abort();
      if (Atomics.load(sync, index) === expected) {
        cleanup();
        resolve();
        return;
      }
      timer = setTimeout(poll, 1);
    };
    signal.addEventListener('abort', abort, { once: true });
    poll();
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`verdict race timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
