import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/FeishuQrPanel', () => ({
  FeishuQrPanel: () => React.createElement('div', { 'data-testid': 'feishu-qr-panel-mock' }, 'Feishu QR Mock'),
}));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);

const { HubConnectorConfigTab } = await import('../HubConnectorConfigTab');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('HubConnectorConfigTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows success hint instead of error when configured connector has no editable changes', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        platforms: [
          {
            id: 'feishu',
            name: '飞书',
            nameEn: 'Feishu',
            configured: true,
            docsUrl: 'https://open.feishu.cn',
            steps: [{ text: '配置文档' }, { text: '完成验证' }],
            fields: [
              { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: true, currentValue: 'cli_xxx' },
              { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true, currentValue: 'sec_xxx' },
              {
                envName: 'FEISHU_CONNECTION_MODE',
                label: '连接模式',
                sensitive: false,
                currentValue: 'websocket',
              },
            ],
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const card = container.querySelector('[data-testid="platform-card-feishu"]');
    expect(card).toBeTruthy();

    const expandBtn = card?.querySelector('button');
    await act(async () => {
      expandBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const saveBtn = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement | null;
    expect(saveBtn).toBeTruthy();

    await act(async () => {
      saveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const result = container.querySelector('[data-testid="save-result"]');
    expect(result?.textContent).toContain('当前无可保存的非敏感变更');
    expect(result?.textContent).toContain('无需再次保存');
    expect(result?.className).toContain('bg-green-50');

    const patchCalls = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/env' && init?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(0);
  });
});
