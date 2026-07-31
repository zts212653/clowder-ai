import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../utils/api-client';

export type AgentHookHealthStatus = 'configured' | 'missing' | 'stale' | 'unsupported' | 'error';

export interface AgentHookDiffSummary {
  kind: 'text' | 'json';
  message: string;
  line?: number;
  fields?: string[];
}

export interface AgentHookTargetHealth {
  name: string;
  drifted: boolean;
  status: AgentHookHealthStatus;
  targetPath: string;
  reason: string;
  diff?: AgentHookDiffSummary;
}

export interface AgentHookStatusResponse {
  status: AgentHookHealthStatus;
  targets: AgentHookTargetHealth[];
  /**
   * Set when the API answered with its PROJECT_NOT_INITIALIZED fail-loud guard
   * (#1049): the project was never probed (missing .cat-cafe/), as opposed to
   * probed-and-found-missing. Syncing cannot fix this from the UI.
   */
  uninitialised?: true;
}

interface UseAgentHookHealthOptions {
  enabled?: boolean;
  /** When set, skill/MCP health targets the given project instead of the API server's cwd. */
  projectPath?: string;
}

interface UseAgentHookHealthResult {
  health: AgentHookStatusResponse | null;
  loading: boolean;
  syncing: boolean;
  synced: boolean;
  syncAttempted: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
}

let cachedHealth: AgentHookStatusResponse | null = null;
let cachedProjectPath: string | undefined;
let hasCachedHealth = false;
let inFlightProjectPath: string | undefined;
let inFlightStatus: Promise<AgentHookStatusResponse> | null = null;

function cacheStatus(status: AgentHookStatusResponse, projectPath?: string): AgentHookStatusResponse {
  cachedHealth = status;
  cachedProjectPath = projectPath;
  hasCachedHealth = true;
  return status;
}

function isAgentHookStatusResponse(value: unknown): value is AgentHookStatusResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'string' &&
    Array.isArray((value as { targets?: unknown }).targets)
  );
}

/**
 * A 400 carrying code PROJECT_NOT_INITIALIZED is the API's deliberate
 * fail-loud guard (#1049): an uninitialised project must never fall back to
 * syncing the host's capabilities. That is expected state, not a failure, so
 * surface it as a neutral `unsupported` card instead of collapsing it into a
 * red `error` one. Other non-OK responses still throw.
 */
async function readUninitialisedProject(res: Response): Promise<AgentHookStatusResponse | null> {
  if (res.status !== 400) return null;
  const { code } = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (code !== 'PROJECT_NOT_INITIALIZED') return null;
  return { status: 'unsupported', targets: [], uninitialised: true };
}

async function readAgentHookStatus(projectPath?: string): Promise<AgentHookStatusResponse> {
  if (hasCachedHealth && cachedHealth && cachedProjectPath === projectPath) return cachedHealth;
  if (inFlightStatus && inFlightProjectPath === projectPath) return inFlightStatus;

  const url = projectPath
    ? `/api/agent-hooks/status?projectPath=${encodeURIComponent(projectPath)}`
    : '/api/agent-hooks/status';

  inFlightProjectPath = projectPath;
  inFlightStatus = apiFetch(url)
    .then(async (res) => {
      if (!res.ok) {
        const uninitialised = await readUninitialisedProject(res);
        if (uninitialised) return uninitialised;
        throw new Error(`agent hook status failed (${res.status})`);
      }
      const status = await res.json();
      if (!isAgentHookStatusResponse(status)) throw new Error('agent hook status response is invalid');
      return status;
    })
    .then((status) => cacheStatus(status, projectPath))
    .finally(() => {
      inFlightStatus = null;
    });

  return inFlightStatus;
}

async function postAgentHookSync(projectPath?: string): Promise<AgentHookStatusResponse> {
  const res = await apiFetch('/api/agent-hooks/sync', {
    method: 'POST',
    headers: projectPath ? { 'Content-Type': 'application/json' } : undefined,
    body: projectPath ? JSON.stringify({ projectPath }) : undefined,
  });
  if (!res.ok) {
    const uninitialised = await readUninitialisedProject(res);
    if (uninitialised) return cacheStatus(uninitialised, projectPath);
    throw new Error(`agent hook sync failed (${res.status})`);
  }
  const status = await res.json();
  if (!isAgentHookStatusResponse(status)) throw new Error('agent hook sync response is invalid');
  return cacheStatus(status, projectPath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Agent Hook 检测失败';
}

export function resetAgentHookHealthCacheForTests() {
  cachedHealth = null;
  hasCachedHealth = false;
  inFlightStatus = null;
}

export function useAgentHookHealth({
  enabled = true,
  projectPath,
}: UseAgentHookHealthOptions = {}): UseAgentHookHealthResult {
  const [health, setHealth] = useState<AgentHookStatusResponse | null>(() =>
    hasCachedHealth && cachedProjectPath === projectPath ? cachedHealth : null,
  );
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [syncAttempted, setSyncAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback(async (readStatus: () => Promise<AgentHookStatusResponse>) => {
    try {
      const status = await readStatus();
      setHealth(status);
      return status;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSyncAttempted(false);
    cachedHealth = null;
    hasCachedHealth = false;
    await applyStatus(() => readAgentHookStatus(projectPath));
    setLoading(false);
  }, [applyStatus, projectPath]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSynced(false);
    setSyncAttempted(false);
    setError(null);
    const status = await applyStatus(() => postAgentHookSync(projectPath));
    setSyncAttempted(status !== null);
    setSynced(status?.status === 'configured');
    setSyncing(false);
  }, [applyStatus, projectPath]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    if (hasCachedHealth && cachedProjectPath === projectPath) {
      setHealth(cachedHealth);
      return;
    }

    setLoading(true);
    setError(null);
    setHealth(null);
    setSyncAttempted(false);
    readAgentHookStatus(projectPath)
      .then(
        (status) => {
          if (!cancelled) setHealth(status);
        },
        (err) => {
          if (!cancelled) setError(errorMessage(err));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, projectPath]);

  return { health, loading, syncing, synced, syncAttempted, error, refresh, sync };
}
