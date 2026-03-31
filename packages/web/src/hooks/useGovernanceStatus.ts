/**
 * F113 Phase E: Hook to fetch governance status for a project path.
 * Used by ChatContainer to decide whether to show ProjectSetupCard.
 *
 * Uses a ref for projectPath so `refetch` always reads the latest value,
 * solving the first-create timing issue where storeThreads → projectPath
 * hasn't propagated yet when ChatContainer first mounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api-client';

export interface GovernanceStatus {
  ready: boolean;
  needsBootstrap: boolean;
  needsConfirmation: boolean;
  isEmptyDir: boolean;
  isGitRepo: boolean;
  gitAvailable: boolean;
}

interface UseGovernanceStatusResult {
  status: GovernanceStatus | null;
  loading: boolean;
  refetch: () => void;
}

export function useGovernanceStatus(projectPath: string | undefined): UseGovernanceStatusResult {
  const [status, setStatus] = useState<GovernanceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;
  // Abort stale requests when projectPath changes or component unmounts
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    // Cancel any in-flight request before starting a new one
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const pp = projectPathRef.current;
    if (!pp || pp === 'default' || pp === 'lobby') {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/governance/status?projectPath=${encodeURIComponent(pp)}`, { signal: ac.signal });
      if (ac.signal.aborted) return; // guard: response arrived after abort
      if (res.ok) {
        setStatus(await res.json());
      } else {
        setStatus(null);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setStatus(null);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []); // stable — reads projectPath from ref

  // Auto-fetch when projectPath changes; cleanup aborts stale request.
  // projectPath is intentional: ref assignment (line above) runs during render,
  // so refetch() always reads the latest value — but we need the dep to re-trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectPath triggers refetch
  useEffect(() => {
    refetch();
    return () => abortRef.current?.abort();
  }, [projectPath, refetch]);

  return { status, loading, refetch };
}
