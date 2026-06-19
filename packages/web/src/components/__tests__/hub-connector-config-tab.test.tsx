import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideStore } from '@/stores/guideStore';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../HubPermissionsTab', () => ({
  default: () => React.createElement('div', { 'data-testid': 'permissions-mock' }, 'Permissions Mock'),
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

async function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    nativeInputValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function feishuStatus(
  fields?: Array<{ envName: string; label: string; sensitive: boolean; currentValue: string | null }>,
) {
  return {
    platforms: [
      {
        id: 'feishu',
        name: '飞书',
        nameEn: 'Feishu / Lark',
        configured: true,
        docsUrl: 'https://open.feishu.cn',
        steps: [{ text: 'step-1' }, { text: 'step-2' }],
        fields: fields ?? [
          { envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: 'cli_existing' },
          { envName: 'FEISHU_APP_SECRET', label: 'App Secret', sensitive: true, currentValue: '••••••••' },
        ],
      },
    ],
  };
}

function platformToggle(container: HTMLElement, platformId: string): HTMLElement | null {
  return container.querySelector(`[data-guide-id="connector.${platformId}"] [role="button"]`);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
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

  it('renders manifest action UI inside expanded Feishu card and refreshes status after action transition', async () => {
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
              operations: [
                {
                  name: 'connect',
                  label: 'Connect',
                  currentAction: 'start',
                  actions: [
                    { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
                    { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
                  ],
                },
              ],
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
      .mockResolvedValueOnce(jsonResponse({ ok: true, render: 'status', label: 'Connected' }))
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
              operations: [
                {
                  name: 'connect',
                  label: 'Connect',
                  currentAction: 'disconnect',
                  actions: [
                    { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
                    { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
                  ],
                },
              ],
              fields: [],
            },
          ],
        }),
      );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const action = container.querySelector('[data-testid="feishu-action-start"]');
    expect(action).toBeTruthy();

    await act(async () => {
      (action as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(3);
    expect(mockApiFetch.mock.calls[1][0]).toBe('/api/connectors/feishu/actions/connect/start');
  });

  it('shows connected operation UI for configured connectors without persisted operation state', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        platforms: [
          {
            id: 'feishu',
            name: '飞书',
            nameEn: 'Feishu / Lark',
            configured: true,
            docsUrl: 'https://open.feishu.cn',
            steps: [{ text: 'step-1' }, { text: 'step-2' }],
            operations: [
              {
                name: 'connect',
                label: 'Connect',
                actions: [
                  { id: 'start', label: 'Connect Feishu', render: 'button', next: 'disconnect' },
                  { id: 'disconnect', label: 'Disconnect', render: 'button', next: 'start' },
                ],
              },
            ],
            fields: [{ envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: 'cli_existing' }],
          },
        ],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="feishu-connected"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="feishu-action-start"]')).toBeNull();
  });

  it('passes pending config values from the expanded card into manifest actions', async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          platforms: [
            {
              id: 'wecom-bot',
              name: '企微机器人',
              nameEn: 'WeCom Bot',
              configured: false,
              docsUrl: 'https://developer.work.weixin.qq.com',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              operations: [
                {
                  name: 'connect',
                  label: 'Connect',
                  currentAction: 'validate',
                  actions: [{ id: 'validate', label: '测试并连接', render: 'button' }],
                },
              ],
              fields: [
                { envName: 'WECOM_BOT_ID', label: 'Bot ID', sensitive: false, currentValue: null },
                { envName: 'WECOM_BOT_SECRET', label: 'Bot Secret', sensitive: true, currentValue: null },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true, render: 'status', label: 'Connected' }));

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'wecom-bot');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await setInputValue(container.querySelector('[data-testid="field-WECOM_BOT_ID"]') as HTMLInputElement, 'bot-id');
    await setInputValue(
      container.querySelector('[data-testid="field-WECOM_BOT_SECRET"]') as HTMLInputElement,
      'bot-secret',
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="wecom-bot-action-validate"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/wecom-bot/actions/connect/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          WECOM_BOT_ID: 'bot-id',
          WECOM_BOT_SECRET: 'bot-secret',
        },
      }),
    });
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
    const expand = platformToggle(container, 'weixin');
    expect(card).toBeTruthy();
    expect(expand).toBeTruthy();

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(card?.getAttribute('data-active')).toBe('true');

    await act(async () => {
      useGuideStore.getState().startGuide(CONNECT_WECHAT_FLOW);
      useGuideStore.getState().setPhase('active');
    });

    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(card?.getAttribute('data-active')).toBe('true');
  });

  it('saves only touched fields and does not submit masked secret placeholders', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(feishuStatus())).mockResolvedValueOnce(jsonResponse({ ok: true }));

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const appId = container.querySelector('[data-testid="field-FEISHU_APP_ID"]') as HTMLInputElement;
    await setInputValue(appId, 'cli_new');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(3);
    const saveCall = mockApiFetch.mock.calls[1];
    expect(saveCall[0]).toBe('/api/connectors/feishu/config');
    expect(JSON.parse((saveCall[1] as RequestInit).body as string)).toEqual({
      fields: [{ name: 'FEISHU_APP_ID', value: 'cli_new' }],
    });
  });

  it('blocks user-entered redacted placeholders before calling the secrets API', async () => {
    mockApiFetch.mockResolvedValueOnce(jsonResponse(feishuStatus()));

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const secret = container.querySelector('[data-testid="field-FEISHU_APP_SECRET"]') as HTMLInputElement;
    await setInputValue(secret, '••••••');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="save-result"]')?.textContent).toContain('脱敏占位符');
  });

  it('renders connector write auth errors from the secrets API', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse(feishuStatus()))
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Connector credential writes can only be modified by the configured owner' }, 403),
      );

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    const expand = platformToggle(container, 'feishu');
    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const appId = container.querySelector('[data-testid="field-FEISHU_APP_ID"]') as HTMLInputElement;
    await setInputValue(appId, 'cli_new');

    const save = container.querySelector('[data-testid="save-feishu"]') as HTMLButtonElement;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="save-result"]')?.textContent).toContain('configured owner');
  });

  it('renders manifest operations even when a connector has only one setup step', async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        platforms: [
          {
            id: 'single-step-plugin',
            name: 'Single Step Plugin',
            nameEn: 'Single Step Plugin',
            source: 'external',
            configured: false,
            docsUrl: '',
            steps: [{ text: 'Install plugin' }],
            fields: [],
            themeColor: '#00AAFF',
            operations: [
              {
                name: 'connect',
                label: 'Connect',
                currentAction: 'connect',
                actions: [{ id: 'connect', label: 'Connect plugin', render: 'button' }],
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

    const card = container.querySelector('[data-guide-id="connector.single-step-plugin"]');
    const expand = card?.querySelector('[role="button"]');
    expect(expand).toBeTruthy();

    await act(async () => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.querySelector('[data-testid="single-step-plugin-action-connect"]')).toBeTruthy();
  });

  it('keeps pending save state scoped to the connector being saved', async () => {
    let resolveSave: (response: Response) => void = () => {};
    const savePromise = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/connector/status') {
        return jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: false,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [{ envName: 'FEISHU_APP_ID', label: 'App ID', sensitive: false, currentValue: null }],
            },
            {
              id: 'dingtalk',
              name: '钉钉',
              nameEn: 'DingTalk',
              configured: false,
              docsUrl: 'https://open.dingtalk.com',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [{ envName: 'DINGTALK_APP_KEY', label: 'App Key', sensitive: false, currentValue: null }],
            },
          ],
        });
      }
      if (url === '/api/connectors/feishu/config' && init?.method === 'PUT') return savePromise;
      return jsonResponse({ ok: true });
    });

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    await act(async () => {
      platformToggle(container, 'feishu')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await setInputValue(container.querySelector('[data-testid="field-FEISHU_APP_ID"]') as HTMLInputElement, 'cli_new');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="save-feishu"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="save-feishu"]')?.textContent).toContain('保存中');

    await act(async () => {
      platformToggle(container, 'dingtalk')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const dingtalkSave = container.querySelector('[data-testid="save-dingtalk"]') as HTMLButtonElement;
    expect(dingtalkSave.disabled).toBe(false);
    expect(dingtalkSave.textContent).toContain('保存配置');

    await act(async () => {
      resolveSave(jsonResponse({ ok: true }));
      await Promise.resolve();
    });
    await flushEffects();
  });

  it('keeps pending test state scoped to the connector being tested', async () => {
    let resolveTest: (response: Response) => void = () => {};
    const testPromise = new Promise<Response>((resolve) => {
      resolveTest = resolve;
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/connector/status') {
        return jsonResponse({
          platforms: [
            {
              id: 'feishu',
              name: '飞书',
              nameEn: 'Feishu / Lark',
              configured: true,
              testable: true,
              docsUrl: 'https://open.feishu.cn',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [],
            },
            {
              id: 'dingtalk',
              name: '钉钉',
              nameEn: 'DingTalk',
              configured: true,
              testable: true,
              docsUrl: 'https://open.dingtalk.com',
              steps: [{ text: 'step-1' }, { text: 'step-2' }],
              fields: [],
            },
          ],
        });
      }
      if (url === '/api/connector/feishu/test' && init?.method === 'POST') return testPromise;
      return jsonResponse({ valid: true });
    });

    await act(async () => {
      root.render(React.createElement(HubConnectorConfigTab));
    });
    await flushEffects();

    await act(async () => {
      platformToggle(container, 'feishu')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    await act(async () => {
      buttonByText(container, '测试连接')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(buttonByText(container, '测试中')?.disabled).toBe(true);

    await act(async () => {
      platformToggle(container, 'dingtalk')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const dingtalkTest = buttonByText(container, '测试连接');
    expect(dingtalkTest?.disabled).toBe(false);

    await act(async () => {
      resolveTest(jsonResponse({ valid: true }));
      await Promise.resolve();
    });
    await flushEffects();
  });

  it('requires confirmation before uninstalling an external connector plugin', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({
        platforms: [
          {
            id: 'external-chat',
            name: 'External Chat',
            nameEn: 'External Chat',
            source: 'external',
            configured: false,
            docsUrl: '',
            steps: [{ text: 'Install plugin' }],
            fields: [],
          },
        ],
      }),
    );

    try {
      await act(async () => {
        root.render(React.createElement(HubConnectorConfigTab));
      });
      await flushEffects();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[title="卸载插件"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flushEffects();

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mockApiFetch).toHaveBeenCalledTimes(1);
      expect(mockApiFetch.mock.calls[0][0]).toBe('/api/connector/status');
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
