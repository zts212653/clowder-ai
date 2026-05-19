import type { FastifyReply } from 'fastify';

const LOCK_HOLD_UNTIL = Symbol('serviceLifecycleLockHoldUntil');
const START_LOCK_HOLD_UNTIL = Symbol('serviceLifecycleStartLockHoldUntil');
const DEFAULT_STARTUP_LOCK_GRACE_MS = 120_000;

export function holdLifecycleLockUntil<T extends object>(value: T, waitFor?: Promise<unknown>): T {
  if (!waitFor) return value;
  Object.defineProperty(value, LOCK_HOLD_UNTIL, {
    value: waitFor,
    enumerable: false,
  });
  return value;
}

export function holdStartupGrace<T extends object>(value: T, startupGraceMs?: number): T {
  const holdMs = Math.max(0, startupGraceMs ?? DEFAULT_STARTUP_LOCK_GRACE_MS);
  if (holdMs === 0) return value;
  const waitFor = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, holdMs);
    timer.unref?.();
  });
  Object.defineProperty(value, START_LOCK_HOLD_UNTIL, {
    value: waitFor,
    enumerable: false,
  });
  return value;
}

function getLockHold(value: unknown): Promise<unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { [LOCK_HOLD_UNTIL]?: Promise<unknown> })[LOCK_HOLD_UNTIL];
}

function getStartLockHold(value: unknown): Promise<unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { [START_LOCK_HOLD_UNTIL]?: Promise<unknown> })[START_LOCK_HOLD_UNTIL];
}

export function createServiceLifecycleLock() {
  const activeServices = new Set<string>();
  const startingServices = new Set<string>();

  return {
    async withLock<T>(
      serviceId: string,
      reply: FastifyReply,
      task: () => Promise<T>,
      options: { action?: 'start' } = {},
    ): Promise<T | { error: string }> {
      if (activeServices.has(serviceId) || (options.action === 'start' && startingServices.has(serviceId))) {
        reply.status(409);
        return { error: `Service lifecycle operation already in progress for ${serviceId}` };
      }
      activeServices.add(serviceId);
      let releaseAfter: Promise<unknown> | undefined;
      let startReleaseAfter: Promise<unknown> | undefined;
      try {
        const result = await task();
        releaseAfter = getLockHold(result);
        startReleaseAfter = getStartLockHold(result);
        return result;
      } finally {
        if (startReleaseAfter) {
          startingServices.add(serviceId);
          void startReleaseAfter.finally(() => {
            startingServices.delete(serviceId);
          });
        }
        if (releaseAfter) {
          void releaseAfter.finally(() => {
            activeServices.delete(serviceId);
          });
        } else {
          activeServices.delete(serviceId);
        }
      }
    },
  };
}
