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
}

interface UseAgentHookHealthOptions {
  enabled?: boolean;
}

interface UseAgentHookHealthResult {
  health: AgentHookStatusResponse | null;
  loading: boolean;
  syncing: boolean;
  synced: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  sync: () => Promise<void>;
}

let cachedHealth: AgentHookStatusResponse | null = null;
let hasCachedHealth = false;
let inFlightStatus: Promise<AgentHookStatusResponse> | null = null;

function isAgentHookStatusResponse(value: unknown): value is AgentHookStatusResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'string' &&
    Array.isArray((value as { targets?: unknown }).targets)
  );
}

async function readAgentHookStatus(): Promise<AgentHookStatusResponse> {
  if (hasCachedHealth && cachedHealth) return cachedHealth;
  if (inFlightStatus) return inFlightStatus;

  inFlightStatus = apiFetch('/api/agent-hooks/status')
    .then(async (res) => {
      if (!res.ok) throw new Error(`agent hook status failed (${res.status})`);
      const status = await res.json();
      if (!isAgentHookStatusResponse(status)) throw new Error('agent hook status response is invalid');
      return status;
    })
    .then((status) => {
      cachedHealth = status;
      hasCachedHealth = true;
      return status;
    })
    .finally(() => {
      inFlightStatus = null;
    });

  return inFlightStatus;
}

async function postAgentHookSync(): Promise<AgentHookStatusResponse> {
  const res = await apiFetch('/api/agent-hooks/sync', { method: 'POST' });
  if (!res.ok) throw new Error(`agent hook sync failed (${res.status})`);
  const status = await res.json();
  if (!isAgentHookStatusResponse(status)) throw new Error('agent hook sync response is invalid');
  cachedHealth = status;
  hasCachedHealth = true;
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Agent Hook 检测失败';
}

export function resetAgentHookHealthCacheForTests() {
  cachedHealth = null;
  hasCachedHealth = false;
  inFlightStatus = null;
}

export function useAgentHookHealth({ enabled = true }: UseAgentHookHealthOptions = {}): UseAgentHookHealthResult {
  const [health, setHealth] = useState<AgentHookStatusResponse | null>(() => (hasCachedHealth ? cachedHealth : null));
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
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
    cachedHealth = null;
    hasCachedHealth = false;
    await applyStatus(readAgentHookStatus);
    setLoading(false);
  }, [applyStatus]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSynced(false);
    setError(null);
    const status = await applyStatus(postAgentHookSync);
    setSynced(status?.status === 'configured');
    setSyncing(false);
  }, [applyStatus]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    if (hasCachedHealth) {
      setHealth(cachedHealth);
      return;
    }

    setLoading(true);
    setError(null);
    readAgentHookStatus()
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
  }, [enabled]);

  return { health, loading, syncing, synced, error, refresh, sync };
}
