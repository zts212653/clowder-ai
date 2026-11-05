import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { usePluginConfigurationSave } from '../usePluginConfigurationSave';

const snapshot: PluginManagerListResponse = {
  plugins: [
    {
      pluginId: 'official.acp-clients',
      pluginInstanceId: 'instance',
      packageDigest: null,
      lifecycleRevision: 4,
      displayName: 'ACP',
      source: { kind: 'unknown', packageName: null, trust: 'unknown' },
      availableVersion: '1',
      installedVersion: '1',
      artifact: 'installed',
      config: 'ready',
      auth: 'not-required',
      intent: 'enabled',
      live: 'running',
      capabilitySummary: [],
      actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
    },
  ],
  catalog: { status: 'fresh', refreshedAt: 1 },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});

it('preserves saved status, shows the audit warning after refresh, and clears it on recovery', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const events: string[] = [];
  let save: ReturnType<typeof usePluginConfigurationSave> | undefined;
  const refresh = async () => {
    events.push('refresh');
  };
  function Harness() {
    save = usePluginConfigurationSave({
      snapshot,
      refresh,
      onBusy: (id) => events.push(`busy:${id}`),
      onSaved: (id) => events.push(`saved:${id}`),
      onError: (message) => events.push(`notice:${message}`),
      onWarning: (message) => events.push(`warning:${message}`),
    });
    return null;
  }
  const updates = [{ key: 'clients', value: '[]' }];
  try {
    act(() => root.render(<Harness />));
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ warning: '配置已保存，但插件审计写入失败' })),
    );
    await act(async () => {
      await save?.('official.acp-clients', updates);
    });
    expect(events).toEqual([
      'busy:official.acp-clients',
      'notice:null',
      'saved:null',
      'saved:official.acp-clients',
      'refresh',
      'warning:配置已保存，但插件审计写入失败',
      'busy:null',
    ]);
    events.length = 0;
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}'));
    await act(async () => {
      await save?.('official.acp-clients', updates);
    });
    expect(events).toContain('saved:official.acp-clients');
    expect(events).not.toContain('notice:配置已保存，但插件审计写入失败');
    expect(events).toContain('notice:null');
    expect(events).toContain('warning:null');
  } finally {
    act(() => root.unmount());
  }
});
