'use client';

import type { DeploymentWaitListResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeploymentWaitHydration } from '@/components/workspace/WorkspaceDeploymentWaits';
import { apiFetch } from '@/utils/api-client';

const REFRESH_MS = 4_000;

export interface DeploymentWaitProjectionView {
  readonly projection: DeploymentWaitListResponse | null;
  readonly hydration: DeploymentWaitHydration;
  readonly error: string | null;
  readonly retry: () => Promise<void>;
}

interface ProjectionState {
  readonly projectPath: string | null;
  readonly projection: DeploymentWaitListResponse | null;
  readonly hydration: DeploymentWaitHydration;
  readonly error: string | null;
}

const INITIAL_STATE: ProjectionState = {
  projectPath: null,
  projection: null,
  hydration: 'idle',
  error: null,
};

function resource(projectPath: string): string {
  return `/api/runtime-deployment/waits?projectPath=${encodeURIComponent(projectPath)}`;
}

export function useDeploymentWaitProjection(projectPath: string | null): DeploymentWaitProjectionView {
  const [state, setState] = useState<ProjectionState>(INITIAL_STATE);
  const requestVersion = useRef(0);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!projectPath) return;
      const version = ++requestVersion.current;
      setState((current) => ({
        projectPath,
        projection: current.projectPath === projectPath ? current.projection : null,
        hydration: 'loading',
        error: null,
      }));
      try {
        const response = await apiFetch(resource(projectPath), { signal });
        if (!response.ok) throw new Error(`Deployment wait hydration failed (${response.status})`);
        const projection = (await response.json()) as DeploymentWaitListResponse;
        if (projection.projectPath !== projectPath) throw new Error('Deployment wait project identity mismatch');
        if (requestVersion.current !== version) return;
        setState({ projectPath, projection, hydration: 'ready', error: null });
      } catch (error) {
        if (signal?.aborted || requestVersion.current !== version) return;
        setState((current) => ({
          projectPath,
          projection: current.projectPath === projectPath ? current.projection : null,
          hydration: 'error',
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [projectPath],
  );

  useEffect(() => {
    if (!projectPath) {
      requestVersion.current += 1;
      setState(INITIAL_STATE);
      return;
    }
    const controller = new AbortController();
    const update = () => void refresh(controller.signal);
    update();
    const interval = window.setInterval(update, REFRESH_MS);
    const updateWhenVisible = () => {
      if (document.visibilityState === 'visible') update();
    };
    window.addEventListener('online', update);
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', update);
      document.removeEventListener('visibilitychange', updateWhenVisible);
    };
  }, [projectPath, refresh]);

  return {
    projection: state.projectPath === projectPath ? state.projection : null,
    hydration: projectPath ? state.hydration : 'idle',
    error: state.error,
    retry: () => refresh(),
  };
}
