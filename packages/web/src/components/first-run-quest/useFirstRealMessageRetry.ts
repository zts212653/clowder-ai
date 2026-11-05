import { useEffect } from 'react';

interface FirstRealMessageRetryOptions {
  enabled: boolean;
  retryKey: number;
  onRetry: () => void;
  delayMs?: number;
}

/** Retry the durable first-message reconciliation without requiring another user message. */
export function useFirstRealMessageRetry({
  enabled,
  retryKey,
  onRetry,
  delayMs = 2000,
}: FirstRealMessageRetryOptions): void {
  useEffect(() => {
    if (!enabled) return;
    void retryKey;
    const timer = setTimeout(onRetry, delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, enabled, onRetry, retryKey]);
}
