'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface AgentClientLibrary {
  pluginId: string;
  configurationKey: string | null;
  clients: { id: string; name: string; ref: string; available: boolean }[];
  error?: string;
  presets?: { id: string; name: string; command: string; startupArgs: string[] }[];
}
export function useAgentClientLibraries(revision?: string, enabled = true) {
  const [libraries, setLibraries] = useState<AgentClientLibrary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setLoading(true);
    Promise.resolve()
      .then(() => apiFetch('/api/agent-providers', revision ? { cache: 'no-store' } : undefined))
      .then(async (response) => {
        if (!response.ok) throw new Error('ACP 客户端目录暂不可用，请重试或检查插件状态。');
        const body = (await response.json()) as { libraries: AgentClientLibrary[] };
        if (!Array.isArray(body.libraries)) throw new Error('ACP 客户端目录响应无效，请重试。');
        if (current) {
          setLibraries(body.libraries);
          setError('');
        }
      })
      .catch((error: unknown) => {
        if (current) setError(error instanceof Error ? error.message : 'ACP 客户端目录读取失败');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [revision, enabled]);
  return { libraries: enabled ? libraries : [], loading: enabled && loading, error: enabled ? error : '' };
}
