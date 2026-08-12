'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { EnvVar } from './EnvSubComponents';
import { SettingsStatusStrip } from './primitives';
import { SystemSettingsView } from './SystemSettingsView';

interface SystemSummaryResponse {
  groups: Record<string, { label: string; description?: string }>;
  variables: EnvVar[];
}

export function HubSystemSettingsTab() {
  const [data, setData] = useState<SystemSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/config/env-summary?surface=system')
      .then(async (res) => {
        if (res.ok) {
          setData((await res.json()) as SystemSummaryResponse);
        } else {
          setError(`加载失败 (${res.status})`);
        }
      })
      .catch(() => setError('无法连接服务'));
  }, []);

  if (error) {
    return <SettingsStatusStrip tone="error">{error}</SettingsStatusStrip>;
  }
  if (!data) {
    return <SettingsStatusStrip tone="info">加载系统设置…</SettingsStatusStrip>;
  }

  return <SystemSettingsView variables={data.variables} />;
}
