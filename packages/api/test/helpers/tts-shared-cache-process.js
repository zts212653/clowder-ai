import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

/** Warm IPC actors before any timed health response is held at the fake server. */
export async function startSharedCacheProcess({ worker, setup, cacheDir, baseUrl }) {
  const child = fork(worker, [cacheDir, baseUrl], {
    execArgv: ['--import', setup],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, TTS_MODEL: '', TTS_URL: '', CAT_CAFE_SERVICES_CONFIG: join(cacheDir, 'no-services.json') },
  });
  let pending;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.on('message', (message) => {
    if (message.ready) readyResolve();
    else if (pending) {
      clearTimeout(pending.timer);
      const current = pending;
      pending = undefined;
      if (message.error) current.reject(new Error(message.error));
      else
        current.resolve({
          ...message.result,
          healthSuccesses: message.healthSuccesses,
          healthFailures: message.healthFailures,
        });
    }
  });
  child.on('error', (error) => {
    readyReject(error);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  });
  child.on('exit', (code) => {
    const error = new Error(`Shared cache worker exited (${code}): ${stderr}`);
    readyReject(error);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = undefined;
    }
  });
  const startup = setTimeout(() => {
    child.kill();
    readyReject(new Error('Shared cache worker startup timed out'));
  }, 20000);
  try {
    await ready;
  } finally {
    clearTimeout(startup);
  }
  return {
    request(id, model) {
      if (pending) return Promise.reject(new Error('Test actor already has an in-flight request'));
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('Shared cache worker request timed out'));
        }, 15000);
        pending = { resolve, reject, timer };
        child.send({ id, model });
      });
      void result.catch(() => {});
      return result;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit');
      const forceStop = setTimeout(() => child.kill(), 2000);
      child.send({ close: true });
      try {
        await stopped;
      } finally {
        clearTimeout(forceStop);
      }
    },
  };
}
