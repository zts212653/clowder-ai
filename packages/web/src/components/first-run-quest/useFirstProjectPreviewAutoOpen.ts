import { useEffect, useRef } from 'react';

interface UseFirstProjectPreviewAutoOpenOptions {
  phase?: string;
  messageCount: number;
  hasActiveInvocation: boolean;
  worktreeId: string | null;
  threadId: string;
}

interface DiscoveredPreviewPort {
  port: number;
  worktreeId: string;
  reachable: boolean;
  discoveredAt: number;
}

function isDiscoveredPreviewPort(value: unknown): value is DiscoveredPreviewPort {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DiscoveredPreviewPort>;
  return (
    typeof candidate.port === 'number' &&
    typeof candidate.worktreeId === 'string' &&
    typeof candidate.reachable === 'boolean' &&
    typeof candidate.discoveredAt === 'number'
  );
}

export function selectFirstProjectPreviewPort(ports: unknown, worktreeId: string | null): number | null {
  const normalized = Array.isArray(ports) ? ports.filter(isDiscoveredPreviewPort) : [];
  const reachable = normalized.filter((port) => port.reachable);
  if (worktreeId) {
    return (
      [...reachable].filter((port) => port.worktreeId === worktreeId).sort((a, b) => b.discoveredAt - a.discoveredAt)[0]
        ?.port ?? null
    );
  }

  return reachable.length === 1 ? (reachable[0]?.port ?? null) : null;
}

export function useFirstProjectPreviewAutoOpen({
  phase,
  messageCount,
  hasActiveInvocation,
  worktreeId,
  threadId,
}: UseFirstProjectPreviewAutoOpenOptions) {
  const baselineCountRef = useRef<number | null>(null);
  const sawNewPhaseOutputRef = useRef(false);
  const autoOpenedKeyRef = useRef<string | null>(null);
  const prevActiveRef = useRef(false);
  const prevPhaseRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'phase-7-dev') {
      baselineCountRef.current = null;
      sawNewPhaseOutputRef.current = false;
      autoOpenedKeyRef.current = null;
      prevActiveRef.current = false;
      prevPhaseRef.current = phase;
      return;
    }

    const enteredPhase4 = prevPhaseRef.current !== 'phase-7-dev';
    if (enteredPhase4 || baselineCountRef.current === null) {
      baselineCountRef.current = messageCount;
      sawNewPhaseOutputRef.current = false;
    }

    if (hasActiveInvocation && !prevActiveRef.current) {
      baselineCountRef.current = messageCount;
      sawNewPhaseOutputRef.current = false;
    }

    if (messageCount > (baselineCountRef.current ?? 0)) {
      sawNewPhaseOutputRef.current = true;
    }
    prevActiveRef.current = hasActiveInvocation;
    prevPhaseRef.current = phase;
  }, [phase, messageCount, hasActiveInvocation]);

  useEffect(() => {
    if (phase !== 'phase-7-dev' || hasActiveInvocation || !sawNewPhaseOutputRef.current) {
      return;
    }

    const key = `${threadId}:${messageCount}:${worktreeId ?? 'global'}`;
    if (autoOpenedKeyRef.current === key) return;
    autoOpenedKeyRef.current = key;
    sawNewPhaseOutputRef.current = false;
    baselineCountRef.current = messageCount;

    let cancelled = false;

    void (async () => {
      const query = worktreeId ? `?worktreeId=${encodeURIComponent(worktreeId)}` : '';
      const discoveredRes = await fetch(`/api/preview/discovered${query}`, {
        credentials: 'include',
      });
      if (!discoveredRes.ok || cancelled) return;

      const discovered = await discoveredRes.json();
      const port = selectFirstProjectPreviewPort(discovered, worktreeId);
      if (port == null || cancelled) return;

      await fetch('/api/preview/auto-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          port,
          path: '/',
          threadId,
          ...(worktreeId ? { worktreeId } : {}),
        }),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, messageCount, hasActiveInvocation, threadId, worktreeId]);
}
