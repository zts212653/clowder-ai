export interface RuntimeHeartbeatPolicy {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export interface RuntimeHeartbeatController {
  start(): void;
  stop(): void;
}

export function resolveRuntimeHeartbeatPolicy(
  leaseTtlMs: number,
  intervalMs = Math.max(1, Math.floor(leaseTtlMs / 3)),
  timeoutMs = Math.max(1, Math.floor(leaseTtlMs / 6)),
): RuntimeHeartbeatPolicy {
  if (
    !Number.isSafeInteger(intervalMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    intervalMs < 1 ||
    timeoutMs < 1 ||
    intervalMs + timeoutMs >= leaseTtlMs
  ) {
    throw new TypeError('heartbeat interval and timeout must fit inside the active runtime lease');
  }
  return { intervalMs, timeoutMs };
}

export function createRuntimeHeartbeatController(options: {
  readonly intervalMs: number;
  readonly ping: () => Promise<void>;
  readonly renewLease: () => Promise<unknown>;
  readonly onFailure: (error: unknown) => Promise<unknown>;
}): RuntimeHeartbeatController {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, options.intervalMs);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    try {
      await options.ping();
      if (stopped) return;
      await options.renewLease();
      schedule();
    } catch (error) {
      await options.onFailure(error);
    }
  };

  return {
    start: schedule,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
