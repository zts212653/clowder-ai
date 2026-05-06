import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';
import { PushSettingsPanel } from '../PushSettingsPanel';

vi.mock('@/hooks/usePushNotify', () => ({
  usePushNotify: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const mockUsePushNotify = vi.mocked(usePushNotify);

describe('PushSettingsPanel test push feedback', () => {
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

    mockUsePushNotify.mockReturnValue({
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
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('shows success toast after clicking test button', async () => {
    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('测试'),
    ) as HTMLButtonElement | undefined;
    expect(testBtn).toBeDefined();

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'success' && t.title === '测试通知已发送')).toBe(true);
  });

  it('shows error toast when test push fails', async () => {
    mockUsePushNotify.mockReturnValue({
      isSupported: true,
      isSubscribed: true,
      isLoading: false,
      permission: 'granted',
      environmentHint: null,
      lastError: null,
      status: null,
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      sendTest: vi.fn(async () => ({ ok: false, message: 'Push not configured' })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('测试'),
    ) as HTMLButtonElement | undefined;
    expect(testBtn).toBeDefined();

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '测试通知失败')).toBe(true);
  });

  it('shows environment hint card when push environment is degraded', async () => {
    mockUsePushNotify.mockReturnValue({
      isSupported: true,
      isSubscribed: false,
      isLoading: false,
      permission: 'default',
      environmentHint: '开发模式下若无法订阅系统通知，请用 ENABLE_PWA_IN_DEV=1 启动，或改用 build+start 进行推送验证。',
      lastError: null,
      status: null,
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      sendTest: vi.fn(async () => ({ ok: true, message: '测试推送已发送' })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('开发模式下若无法订阅系统通知');
  });

  it('renders server status diagnostics when status payload exists', async () => {
    mockUsePushNotify.mockReturnValue({
      isSupported: true,
      isSubscribed: true,
      isLoading: false,
      permission: 'granted',
      environmentHint: null,
      lastError: null,
      status: {
        capability: {
          enabled: true,
          vapidPublicKeyConfigured: true,
          pushServiceConfigured: true,
        },
        subscription: {
          count: 1,
          targets: [
            {
              endpoint: 'push.example.com...sub/1',
              createdAt: Date.now(),
              uaFamily: 'chrome',
            },
          ],
        },
        delivery: {
          lastAttemptAt: Date.now(),
          lastHttpStatus: 200,
          lastResult: 'ok',
          lastError: null,
        },
        errorHints: [],
      },
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      sendTest: vi.fn(async () => ({ ok: true, message: '测试推送已发送' })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const diagBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('诊断信息'),
    ) as HTMLButtonElement | undefined;
    expect(diagBtn).toBeDefined();

    await act(async () => {
      diagBtn?.click();
    });

    expect(container.textContent).toContain('已配置');
    expect(container.textContent).toContain('1 台');
    expect(container.textContent).toContain('正常');
  });

  it('shows inline config toggle when push not configured', async () => {
    mockUsePushNotify.mockReturnValue({
      isSupported: true,
      isSubscribed: false,
      isLoading: false,
      permission: 'denied',
      environmentHint: null,
      lastError: null,
      status: {
        capability: {
          enabled: false,
          vapidPublicKeyConfigured: false,
          pushServiceConfigured: false,
        },
        subscription: {
          count: 0,
          targets: [],
        },
        delivery: {
          lastAttemptAt: Date.now(),
          lastHttpStatus: 503,
          lastResult: 'error',
          lastError: 'push_not_configured',
        },
        errorHints: ['push_vapid_key_missing', 'push_not_configured'],
      },
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      sendTest: vi.fn(async () => ({ ok: false, message: 'Push not configured' })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('推送服务未配置');
    expect(container.textContent).toContain('配置服务端密钥对');
  });

  it('renders notification channels and preference checkboxes', async () => {
    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('通知渠道');
    expect(container.textContent).toContain('浏览器推送');
    expect(container.textContent).toContain('应用内通知');
    expect(container.textContent).toContain('通知偏好');
    expect(container.textContent).toContain('猫猫消息');
    expect(container.textContent).toContain('权限请求');
    expect(container.textContent).toContain('@提及');
    expect(container.textContent).toContain('定时任务');
    expect(container.textContent).toContain('信号更新');
  });
});
