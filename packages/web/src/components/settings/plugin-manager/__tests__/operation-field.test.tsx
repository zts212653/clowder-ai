import type { PluginManagerConfigField } from '@cat-cafe/shared';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/useConfirm', async (original) => original());

import { apiFetch } from '@/utils/api-client';
import { ConfirmProvider } from '../../../useConfirm';
import { PluginManagerConfigurationSection } from '../PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager-fixtures';

vi.mock('@/hooks/useAgentClientLibraries', () => ({
  useAgentClientLibraries: () => ({ libraries: [], loading: false, error: '' }),
}));

it.each([
  false,
  true,
])('sibling success refreshes status without borrowing confirmation (confirm=%s)', async (requiresConfirmation) => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.appendChild(host);
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
          ...(requiresConfirmation ? { confirm: '此状态操作需要确认' } : {}),
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
    await act(async () =>
      root.render(
        <ConfirmProvider>
          <Harness />
        </ConfirmProvider>,
      ),
    );
    expect(host.textContent).toContain('订阅消息');
    expect(host.textContent).toContain('发送到目标 Work 对话');
    const statusCalls = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).endsWith('/status'));
    if (requiresConfirmation) expect(statusCalls()).toHaveLength(0);
    else expect(host.textContent).toContain('未连接');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent === '生成订阅消息')!.click();
    });
    expect(host.textContent).toContain('完整订阅消息');
    if (requiresConfirmation) {
      expect(statusCalls()).toHaveLength(0);
      const refresh = () => [...host.querySelectorAll('button')].find((b) => b.textContent === '刷新状态')!;
      const dialogButton = (label: string) =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
          (b) => b.textContent === label,
        )!;
      await act(async () => {
        refresh().click();
      });
      expect(statusCalls()).toHaveLength(0);
      await act(async () => {
        dialogButton('取消').click();
      });
      expect(statusCalls()).toHaveLength(0);
      await act(async () => {
        refresh().click();
      });
      await act(async () => {
        dialogButton('确认').click();
      });
      expect(statusCalls()).toHaveLength(1);
      expect(new Headers(statusCalls()[0][1]?.headers).get('x-cat-cafe-owner-confirmed')).toBe('true');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(statusCalls()).toHaveLength(1);
    } else {
      expect(statusCalls().length).toBeGreaterThan(1);
      for (const [, init] of statusCalls())
        expect(new Headers(init?.headers).has('x-cat-cafe-owner-confirmed')).toBe(false);
    }
    expect(host.textContent).toContain('等待订阅');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '复制')).toBe(true);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});
