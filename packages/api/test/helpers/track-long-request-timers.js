import assert from 'node:assert/strict';

/** Count SDK-sized request timers without waiting for their 60-second expiry. */
export function trackLongRequestTimers(t) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(
      (...callbackArgs) => {
        active.delete(timer);
        callback(...callbackArgs);
      },
      delay,
      ...args,
    );
    if (delay >= 50_000) active.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    active.delete(timer);
    return originalClearTimeout(timer);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });
  return () => assert.equal(active.size, 0, 'SDK request timers must be retired');
}
