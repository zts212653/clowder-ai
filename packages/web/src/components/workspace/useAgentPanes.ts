'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';

export interface AgentPane {
  invocationId: string;
  paneId: string;
  status: 'running' | 'done' | 'crashed';
  startedAt: number;
  /** Owning cat recorded server-side at spawn; null for panes registered before the field existed. */
  catId?: string | null;
}

/**
 * Poll the agent-pane registry while the surface is visible. Responses that
 * settle after a hide or a worktree switch are discarded (epoch-gated), so the
 * list never shows another worktree's panes.
 */
export function useAgentPanes(worktreeId: string): AgentPane[] {
  const [snapshot, setSnapshot] = useState<{ worktreeId: string; panes: AgentPane[] }>({ worktreeId, panes: [] });
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const requestEpoch = useRef(0);
  const currentVisibility = useRef(surfaceVisible);
  const currentWorktreeId = useRef(worktreeId);

  useLayoutEffect(() => {
    if (currentVisibility.current === surfaceVisible) return;
    currentVisibility.current = surfaceVisible;
    ++requestEpoch.current;
  }, [surfaceVisible]);

  useLayoutEffect(() => {
    if (currentWorktreeId.current === worktreeId) return;
    currentWorktreeId.current = worktreeId;
    ++requestEpoch.current;
  }, [worktreeId]);

  const refresh = useCallback(async () => {
    const request = ++requestEpoch.current;
    try {
      const res = await apiFetch(`/api/terminal/agent-panes?worktreeId=${encodeURIComponent(worktreeId)}`);
      if (!res.ok) return;
      const nextPanes = (await res.json()) as AgentPane[];
      const ownsCurrentRead =
        request === requestEpoch.current && currentVisibility.current && currentWorktreeId.current === worktreeId;
      if (ownsCurrentRead) setSnapshot({ worktreeId, panes: nextPanes });
    } catch {
      /* ignore fetch errors */
    }
  }, [worktreeId]);

  useEffect(() => {
    if (!surfaceVisible) return;
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      clearInterval(interval);
      ++requestEpoch.current;
    };
  }, [refresh, surfaceVisible]);

  return snapshot.worktreeId === worktreeId ? snapshot.panes : [];
}
