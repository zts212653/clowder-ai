import type { InvocationOwnerReaper } from './InvocationOwnerReaper.js';

export function startSerializedInvocationOwnerReaperInterval(options: {
  reaper: Pick<InvocationOwnerReaper, 'runOnce'>;
  intervalMs: number;
  onError?: (err: unknown) => void;
  setIntervalFn?: typeof setInterval;
}): ReturnType<typeof setInterval> {
  let inFlight = false;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  return setIntervalFn(() => {
    if (inFlight) return;
    inFlight = true;
    void options.reaper
      .runOnce()
      .catch((err) => options.onError?.(err))
      .finally(() => {
        inFlight = false;
      });
  }, options.intervalMs);
}
