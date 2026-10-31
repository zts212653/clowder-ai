import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export type IndexStatus = 'missing' | 'stale' | 'building' | 'ready' | 'failed';

export interface IndexState {
  status: IndexStatus;
  fingerprint: string;
  docs_indexed: number;
  docs_total: number;
  error_message: string | null;
  summary_json: string | null;
  snoozed_until: string | null;
  last_scan_at: string | null;
}

export interface BootstrapProgress {
  phase: 'scanning' | 'extracting' | 'indexing' | 'summarizing';
  phaseIndex: number;
  totalPhases: number;
  docsProcessed: number;
  docsTotal: number;
  elapsedMs: number;
}

export interface ProjectSummary {
  projectName: string;
  techStack: string[];
  dirStructure: string[];
  coreModules: string[];
  docsList: Array<{ path: string; tier: string }>;
  tierCoverage: Record<string, number>;
  kindCoverage: Record<string, number>;
}

const MISSING_STATE: IndexState = {
  status: 'missing',
  fingerprint: '',
  docs_indexed: 0,
  docs_total: 0,
  error_message: null,
  summary_json: null,
  snoozed_until: null,
  last_scan_at: null,
};

export function useIndexState(projectPath: string | null) {
  const [state, setState] = useState<IndexState>(MISSING_STATE);
  const [progress, setProgress] = useState<BootstrapProgress | null>(null);
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset transient state when project changes (P2-3: prevent cross-project durationMs leak)
  const prevProjectRef = useRef(projectPath);
  useEffect(() => {
    if (projectPath !== prevProjectRef.current) {
      prevProjectRef.current = projectPath;
      setDurationMs(null);
      setProgress(null);
      setSummary(null);
    }
  }, [projectPath]);

  const fetchState = useCallback(async () => {
    if (!projectPath || projectPath === 'default' || projectPath === 'lobby') return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/projects/index-state?projectPath=${encodeURIComponent(projectPath)}`);
      if (res.ok && mountedRef.current) {
        const data = await res.json();
        setState(data);
        if (data.summary_json) {
          try {
            setSummary(JSON.parse(data.summary_json));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* network error — stay in current state */
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const startBootstrap = useCallback(async () => {
    if (!projectPath || projectPath === 'default' || projectPath === 'lobby') return;
    try {
      const res = await apiFetch('/api/projects/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      if (res.ok) {
        setState((s) => ({ ...s, status: 'building' }));
      }
    } catch {
      /* ignore */
    }
  }, [projectPath]);

  const snooze = useCallback(async () => {
    if (!projectPath) return;
    try {
      const res = await apiFetch('/api/projects/bootstrap/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      });
      if (res.ok && mountedRef.current) {
        const data = await res.json();
        setState((s) => ({ ...s, snoozed_until: data.snoozedUntil }));
      }
    } catch {
      /* ignore */
    }
  }, [projectPath]);

  const handleSocketEvent = useCallback(
    (event: string, data: Record<string, unknown>) => {
      if (!mountedRef.current) return;
      if (data.projectPath !== projectPath) return;

      if (event === 'index:progress') {
        setProgress(data as unknown as BootstrapProgress);
      } else if (event === 'index:complete') {
        setState((s) => ({ ...s, status: 'ready' }));
        setProgress(null);
        if (data.summary) setSummary(data.summary as ProjectSummary);
        if (typeof data.durationMs === 'number') setDurationMs(data.durationMs);
        fetchState();
      } else if (event === 'index:failed') {
        setState((s) => ({ ...s, status: 'failed', error_message: (data.error as string) ?? 'Unknown error' }));
        setProgress(null);
      }
    },
    [projectPath, fetchState],
  );

  const isSnoozed = state.snoozed_until ? new Date(state.snoozed_until) > new Date() : false;

  return {
    state,
    progress,
    summary,
    durationMs,
    loading,
    isSnoozed,
    startBootstrap,
    snooze,
    handleSocketEvent,
    refetch: fetchState,
  };
}
