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
  /** When set, skill/MCP health targets the given project instead of the API server's cwd. */
  projectPath?: string;
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
let cachedProjectPath: string | undefined;
let hasCachedHealth = false;
let inFlightProjectPath: string | undefined;
let inFlightStatus: Promise<AgentHookStatusResponse> | null = null;

type AgentHookRequestKind = 'status' | 'sync';

function isAgentHookStatusResponse(value: unknown): value is AgentHookStatusResponse {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { status?: unknown }).status === 'string' &&
    Array.isArray((value as { targets?: unknown }).targets)
  );
}

async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const payload = await res.json();
    const message = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : null;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}

function formatAgentHookError(kind: AgentHookRequestKind, status: number, detail: string | null): string {
  const normalized = detail?.toLowerCase() ?? '';

  if (status === 403 && normalized.includes('local api host')) {
    return kind === 'status'
      ? 'Agent Hook 只支持从本机 localhost 直接访问的 Hub 检测。请改用 http://localhost:3003 打开后重试。'
      : 'Agent Hook 同步只支持从本机 localhost 直接访问的 Hub 发起。请改用 http://localhost:3003 打开后重试。';
  }

  if (status === 401) {
    return 'Agent Hook 请求需要有效会话。请刷新页面后重试。';
  }

  if (detail) return detail;
  return `agent hook ${kind} failed (${status})`;
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
        const detail = await readErrorDetail(res);
        throw new Error(formatAgentHookError('status', res.status, detail));
      }
      const status = await res.json();
      if (!isAgentHookStatusResponse(status)) throw new Error('agent hook status response is invalid');
      return status;
    })
    .then((status) => {
      cachedHealth = status;
      cachedProjectPath = projectPath;
      hasCachedHealth = true;
      return status;
    })
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
    const detail = await readErrorDetail(res);
    throw new Error(formatAgentHookError('sync', res.status, detail));
  }
  const status = await res.json();
  if (!isAgentHookStatusResponse(status)) throw new Error('agent hook sync response is invalid');
  cachedHealth = status;
  cachedProjectPath = projectPath;
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
    await applyStatus(() => readAgentHookStatus(projectPath));
    setLoading(false);
  }, [applyStatus, projectPath]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSynced(false);
    setError(null);
    const status = await applyStatus(() => postAgentHookSync(projectPath));
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

  return { health, loading, syncing, synced, error, refresh, sync };
}
