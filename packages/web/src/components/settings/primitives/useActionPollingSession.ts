import { useCallback, useRef } from 'react';

interface PollingSession {
  actionId: string;
  inputKey: string;
  origin?: { actionId: string; updatedAt?: number };
  acknowledged: boolean;
  updatedAt?: number;
}

/** Own the local request and polling result until the server replaces that session. */
export function useActionPollingSession() {
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expireRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef<PollingSession | null>(null);
  const stopTimers = useCallback(() => {
    session.current = null;
    if (pollRef.current) clearTimeout(pollRef.current);
    if (expireRef.current) clearTimeout(expireRef.current);
    pollRef.current = null;
    expireRef.current = null;
  }, []);
  const beginRequest = useCallback(
    (actionId: string, nextId: string, inputKey: string, updatedAt?: number) => {
      stopTimers();
      session.current = { actionId: nextId, inputKey, origin: { actionId, updatedAt }, acknowledged: false };
    },
    [stopTimers],
  );
  const beginPolling = useCallback(
    (actionId: string, inputKey: string, updatedAt?: number) => {
      const pending = session.current;
      stopTimers();
      session.current =
        pending?.actionId === actionId && pending.inputKey === inputKey
          ? pending
          : { actionId, inputKey, acknowledged: true, updatedAt };
    },
    [stopTimers],
  );
  const retainsSnapshot = useCallback((actionId: string | undefined, inputKey: string, updatedAt?: number) => {
    const active = session.current;
    if (!active || active.inputKey !== inputKey) return false;
    if (actionId !== active.actionId) {
      // A read begun before the generation committed can still show its original step.
      return !active.acknowledged && actionId === active.origin?.actionId && updatedAt === active.origin?.updatedAt;
    }
    if (active.acknowledged) return active.updatedAt === updatedAt;
    active.acknowledged = true;
    active.updatedAt = updatedAt;
    return true;
  }, []);
  return { pollRef, expireRef, stopTimers, beginRequest, beginPolling, retainsSnapshot };
}
