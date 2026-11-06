import type { PluginManagerConfigField } from '@cat-cafe/shared';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerConfigurationSection } from '../PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager-fixtures';

vi.mock('@/hooks/useAgentClientLibraries', () => ({
  useAgentClientLibraries: () => ({ libraries: [], loading: false, error: '' }),
}));

it('labels independent operations and refreshes status after a sibling succeeds, even after polling expires', async () => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  const root = createRoot(host);
  let generated = false;
  const fields: PluginManagerConfigField[] = [
    {
      key: 'message',
      label: '订阅消息',
      description: '发送到目标 Work 对话',
      kind: 'operation',
      required: false,
      currentValue: null,
      sensitive: false,
      configured: false,
      actions: [
        {
          id: 'generate',
          label: '生成订阅消息',
          render: 'button',
          resultRender: 'text',
        },
      ],
    },
    {
      key: 'connection',
      label: '连接状态',
      description: '检查真实连接',
      kind: 'operation',
      required: false,
      currentValue: null,
      sensitive: false,
      configured: false,
      actions: [
        {
          id: 'status',
          label: '刷新状态',
          render: 'status',
          resultRender: 'rows',
        },
      ],
    },
  ];
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/generate')) {
      generated = true;
      return new Response(JSON.stringify({ ok: true, render: 'text', data: '完整订阅消息' }));
    }
    return new Response(
      JSON.stringify({
        ok: true,
        render: 'rows',
        data: { rows: [{ key: 'connection', label: generated ? '等待订阅' : '未连接' }], pollUntil: Date.now() + 1000 },
      }),
    );
  });
  function Harness() {
    const [snapshot, updateSnapshot] = useState(0);
    const refreshed = snapshot
      ? fields.map((field) => ({
          ...field,
          operationState: { currentAction: field.key === 'message' ? 'generate' : 'status', updatedAt: snapshot },
        }))
      : fields;
    return (
      <PluginManagerConfigurationSection
        plugin={{ ...PLUGIN_MANAGER_DESIGN_FIXTURES[0], id: 'example.generic', configFields: refreshed }}
        busy={false}
        validationRequest={0}
        saved={false}
        onOperationChange={() => updateSnapshot((n) => n + 1)}
      />
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toContain('订阅消息');
    expect(host.textContent).toContain('发送到目标 Work 对话');
    expect(host.textContent).toContain('未连接');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === '生成订阅消息')!.click();
    });
    expect(host.textContent).toContain('完整订阅消息');
    expect(host.textContent).toContain('等待订阅');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '复制')).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
