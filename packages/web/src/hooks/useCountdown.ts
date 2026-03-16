import { useEffect, useState } from 'react';

/**
 * Returns remaining time in ms, counting down from phaseStartedAt + timeoutMs.
 * Ticks every second. Returns timeoutMs if phaseStartedAt is not provided.
 */
export function useCountdown(timeoutMs: number, phaseStartedAt?: number): number {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reset "now" when phase changes so countdown restarts immediately
  useEffect(() => {
    setNow(Date.now());
  }, [phaseStartedAt]);

  if (!phaseStartedAt) return timeoutMs;

  const elapsed = now - phaseStartedAt;
  return Math.max(0, timeoutMs - elapsed);
}
