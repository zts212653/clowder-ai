import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';
import { PushSettingsPanel } from '../PushSettingsPanel';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/hooks/usePushNotify', () => ({
  usePushNotify: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

const mockUsePushNotify = vi.mocked(usePushNotify);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseHookReturn(overrides: Partial<ReturnType<typeof usePushNotify>> = {}): ReturnType<typeof usePushNotify> {
  return {
    isSupported: true,
    isSubscribed: true,
    isLoading: false,
    permission: 'granted',
    environmentHint: null,
    lastError: null,
    status: null,
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    sendTest: vi.fn(async () => ({ ok: true, message: '测试推送已发送' })),
    ...overrides,
  };
}

describe('PushSettingsPanel', () => {
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
    useToastStore.setState({ toasts: [] });
    mocks.apiFetch.mockResolvedValue(
      jsonResponse({
        capability: {
          enabled: false,
          vapidPublicKeyConfigured: false,
          pushServiceConfigured: false,
        },
        subscription: { count: 0, targets: [] },
        delivery: {
          lastAttemptAt: null,
          lastHttpStatus: null,
          lastResult: 'not_attempted',
          lastError: null,
        },
        errorHints: ['push_vapid_key_missing', 'push_not_configured'],
      }),
    );
    mockUsePushNotify.mockReturnValue(baseHookReturn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders two channel cards: browser push and in-app notification', async () => {
    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('浏览器推送');
    expect(container.textContent).toContain('应用内通知');
    expect(container.textContent).toContain('已开启');
  });

  it('renders five notification preference checkboxes that write localStorage', async () => {
    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('猫猫消息');
    expect(container.textContent).toContain('权限请求');
    expect(container.textContent).toContain('@提及');
    expect(container.textContent).toContain('定时任务');
    expect(container.textContent).toContain('信号更新');

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(5);

    await act(async () => {
      checkboxes[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const stored = JSON.parse(localStorage.getItem('cat-cafe-notify-prefs') ?? '{}');
    expect(stored.signal).toBe(true);
  });

  it('diagnostics collapsed by default, expanded shows device/delivery/VAPID info', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        status: {
          capability: { enabled: true, vapidPublicKeyConfigured: true, pushServiceConfigured: true },
          subscription: {
            count: 1,
            targets: [{ endpoint: 'push.example.com/sub/1', createdAt: Date.now(), uaFamily: 'chrome' }],
          },
          delivery: { lastAttemptAt: Date.now(), lastHttpStatus: 200, lastResult: 'ok', lastError: null },
          errorHints: [],
        },
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).not.toContain('推送服务');
    expect(container.textContent).not.toContain('已绑定设备');

    const diagToggle = Array.from(container.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('诊断信息'),
    );
    expect(diagToggle).toBeTruthy();

    await act(async () => {
      diagToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('推送服务');
    expect(container.textContent).toContain('已启用');
    expect(container.textContent).toContain('1 台');
    expect(container.textContent).toContain('已绑定设备');
    expect(container.textContent).toContain('CHROME');
    expect(container.textContent).toContain('最近投递：正常');
    expect(container.textContent).toContain('iPhone/iPad');
  });

  it('shows PushServiceConfig on first screen when VAPID not configured', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        isSubscribed: false,
        status: {
          capability: { enabled: false, vapidPublicKeyConfigured: false, pushServiceConfigured: false },
          subscription: { count: 0, targets: [] },
          delivery: { lastAttemptAt: null, lastHttpStatus: null, lastResult: 'not_attempted', lastError: null },
          errorHints: ['push_vapid_key_missing'],
        },
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('npx web-push generate-vapid-keys');
    expect(container.textContent).toContain('推送服务未配置');
  });

  it('uses SettingsResourceToggleSwitch when push is configured', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        status: {
          capability: { enabled: true, vapidPublicKeyConfigured: true, pushServiceConfigured: true },
          subscription: { count: 1, targets: [] },
          delivery: { lastAttemptAt: null, lastHttpStatus: null, lastResult: 'not_attempted', lastError: null },
          errorHints: [],
        },
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const toggleBtn = container.querySelector('.settings-resource-toggle');
    expect(toggleBtn).toBeTruthy();
  });

  it('shows toggle for unsubscribe even when status is null (subscribed user regression)', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        isSubscribed: true,
        status: null,
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const toggleBtn = container.querySelector('.settings-resource-toggle');
    expect(toggleBtn).toBeTruthy();
  });

  it('shows success toast after clicking send test notification', async () => {
    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('发送测试通知'),
    );
    expect(testBtn).toBeTruthy();

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'success' && t.title === '系统通知已请求发送')).toBe(true);
  });

  it('shows error toast when test push fails', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        sendTest: vi.fn(async () => ({ ok: false, message: 'Push not configured' })),
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('发送测试通知'),
    );

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '系统通知发送失败')).toBe(true);
  });

  it('shows environment hint card when push environment is degraded', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        isSubscribed: false,
        permission: 'default',
        environmentHint: '开发模式下若无法订阅系统通知，请用 ENABLE_PWA_IN_DEV=1 启动。',
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('开发模式下若无法订阅系统通知');
  });

  it('renders mapped repair actions from errorHints', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        isSubscribed: false,
        permission: 'denied',
        status: {
          capability: { enabled: false, vapidPublicKeyConfigured: false, pushServiceConfigured: false },
          subscription: { count: 0, targets: [] },
          delivery: {
            lastAttemptAt: Date.now(),
            lastHttpStatus: 503,
            lastResult: 'error',
            lastError: 'push_not_configured',
          },
          errorHints: ['push_vapid_key_missing', 'push_not_configured', 'push_subscription_missing'],
        },
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('修复建议');
    expect(container.textContent).toContain('服务端未配置 VAPID 公钥');
    expect(container.textContent).toContain('Push 服务未启用');
    expect(container.textContent).toContain('当前设备未订阅');
  });

  it('renders delivery summary card after test push returns summary', async () => {
    mockUsePushNotify.mockReturnValue(
      baseHookReturn({
        sendTest: vi.fn(async () => ({
          ok: true,
          message: '测试推送已发送',
          deliverySummary: { attempted: 3, delivered: 1, failed: 1, removed: 1 },
        })),
      }),
    );

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('发送测试通知'),
    );

    await act(async () => {
      testBtn?.click();
    });

    expect(container.textContent).toContain('最近测试');
    expect(container.textContent).toContain('尝试 3');
    expect(container.textContent).toContain('成功 1');
    expect(container.textContent).toContain('失败 1');
    expect(container.textContent).toContain('清理 1');
  });
});
