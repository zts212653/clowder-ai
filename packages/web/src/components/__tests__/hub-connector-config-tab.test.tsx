import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../FeishuQrPanel', () => ({
  FeishuQrPanel: ({ onConfirmed }: { onConfirmed?: () => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'feishu-qr-panel-mock',
        onClick: () => onConfirmed?.(),
      },
      'Feishu QR Mock',
    ),
}));

import { apiFetch } from '@/utils/api-client';

const mockApiFetch = vi.mocked(apiFetch);
const { HubConnectorConfigTab } = await import('../HubConnectorConfigTab');

const CONNECT_WECHAT_FLOW = {
  id: 'connect-wechat',
  name: '对接微信',
  steps: [{ id: 'expand-wechat', target: 'connector.weixin', tips: '展开微信渠道配置', advance: 'click' as const }],
};

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

describe('F134 follow-up — HubConnectorConfigTab', () => {
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
    act(() => {
      useGuideStore.getState().exitGuide();
    });
    vi.clearAllMocks();
  });

  it('renders FeishuQrPanel inside expanded Feishu card and refreshes status after confirm', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: false,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [
                { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: null },
                { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true, currentValue: null },
                { envName: 'FEISHU_CONNECTION_MODE', label: '连接模式', sensitive: false, currentValue: 'webhook' },
                {
                  envName: 'FEISHU_VERIFICATION_TOKEN',
                  label: 'Verification Token',
                  sensitive: true,
                  currentValue: null,
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: true,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [],
            },
          ],
        }),
      );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('飞书'));
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const qr = container.querySelector('[data-testid="feishu-qr-panel-mock"]');
    expect(qr).toBeTruthy();

    await act(async () => {
      (qr as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not collapse an expanded weixin card when the current guide step targets connector.weixin', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        platforms: [
          {
            id: 'weixin',
            name: '微信',
            nameEn: 'Weixin',
            configured: false,
            docsUrl: 'https://open.weixin.qq.com',
            steps: [{ text: '生成二维码' }, { text: '完成接入' }],
            fields: [],
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const card = container.querySelector('[data-guide-id="connector.weixin"]');
    const expand = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('微信'),
    );
    expect(card).toBeTruthy();
    expect(expand).toBeTruthy();

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-guide-id="connector.weixin.qr-panel"]')).toBeTruthy();

    await act(async () => {
      useGuideStore.getState().startGuide(CONNECT_WECHAT_FLOW);
      useGuideStore.getState().setPhase('active');
    });

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-guide-id="connector.weixin.qr-panel"]')).toBeTruthy();
  });
});
