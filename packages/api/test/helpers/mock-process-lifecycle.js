/** Wait for the actual CLI lifecycle consumer, including asynchronous launch preparation. */
export function waitForMockProcessReady(proc, { timeoutMs = 5_000, events = ['exit', 'close', 'error'] } = {}) {
  const emitter = proc._emitter;
  const required = events;
  const missing = () => required.filter((event) => emitter.listenerCount(event) === 0);
  if (missing().length === 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(deadline);
      emitter.removeListener('newListener', onNewListener);
    };
    const check = () => {
      if (missing().length > 0) return;
      cleanup();
      resolve();
    };
    const onNewListener = (event) => {
      // EventEmitter fires newListener before installing the listener.
      if (required.includes(event)) queueMicrotask(check);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Mock process consumer not ready after ${timeoutMs}ms: missing ${missing().join(', ')}`));
    }, timeoutMs);
    emitter.on('newListener', onNewListener);
    check();
  });
}

/** Emit only after the consumer is attached, and settle only after stdio close. */
export async function emitProcessExit(proc, code, signal = null, { timeoutMs = 5_000 } = {}) {
  // A spawn error may already have consumed the one-shot error listener.
  await waitForMockProcessReady(proc, { timeoutMs, events: ['exit', 'close'] });
  await new Promise((resolve, reject) => {
    const emitter = proc._emitter;
    const cleanup = () => {
      clearTimeout(deadline);
      emitter.removeListener('close', onClose);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Mock process did not close within ${timeoutMs}ms after exit`));
    }, timeoutMs);
    emitter.once('close', onClose);
    emitter.emit('exit', code, signal);
  });
}
