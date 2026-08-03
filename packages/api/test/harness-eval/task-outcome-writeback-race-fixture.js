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
  stallSecondBeforeStore = false,
  timeoutMs = 5_000,
}) {
  const sync = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const workers = [];
  const run = async () => {
    const first = runConcurrentVerdictWorker({ role: 'first', taskOutcomeDbPath, episodeId, sync });
    workers.push(first);
    const firstStoreReady = await waitForAtomicValue(sync, 2, 1, Math.min(timeoutMs, 1_000));
    if (!firstStoreReady) throw new Error('first verdict worker did not open its episode store');

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
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

function waitForAtomicValue(buffer, index, expected, timeoutMs = 1_000) {
  const sync = new Int32Array(buffer);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (Atomics.load(sync, index) === expected) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 1);
    };
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
