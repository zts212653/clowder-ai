import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushNotify } from '@/hooks/usePushNotify';
import { useToastStore } from '@/stores/toastStore';
import { PushSettingsPanel } from '../PushSettingsPanel';

vi.mock('@/hooks/usePushNotify', () => ({
  usePushNotify: vi.fn(),
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

  it('shows success toast after clicking 发送测试通知', async () => {
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

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('发送测试通知'),
    ) as HTMLButtonElement | undefined;
    expect(testBtn).toBeDefined();

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'success' && t.title === '系统通知已请求发送')).toBe(true);
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
      node.textContent?.includes('发送测试通知'),
    ) as HTMLButtonElement | undefined;
    expect(testBtn).toBeDefined();

    await act(async () => {
      testBtn?.click();
    });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.type === 'error' && t.title === '系统通知发送失败')).toBe(true);
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

  it('renders server status matrix when status payload exists', async () => {
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
        errorHints: ['push_subscription_missing'],
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

    await act(async () => { diagBtn?.click(); });

    expect(container.textContent).toContain('VAPID：已配置');
    expect(container.textContent).toContain('1 台');
    expect(container.textContent).toContain('正常');
  });

  it('renders mapped repair actions from errorHints', async () => {
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
        errorHints: ['push_vapid_key_missing', 'push_not_configured', 'push_subscription_missing'],
      },
      subscribe: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      sendTest: vi.fn(async () => ({ ok: false, message: 'Push not configured' })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    expect(container.textContent).toContain('修复建议');
    expect(container.textContent).toContain('服务端未配置 VAPID 公钥');
    expect(container.textContent).toContain('Push 服务未启用');
    expect(container.textContent).toContain('当前设备未订阅');
  });

  it('renders delivery summary card after test push returns summary', async () => {
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
      sendTest: vi.fn(async () => ({
        ok: true,
        message: '测试推送已发送',
        deliverySummary: { attempted: 3, delivered: 1, failed: 1, removed: 1 },
      })),
    });

    await act(async () => {
      root.render(React.createElement(PushSettingsPanel));
    });

    const testBtn = Array.from(container.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('发送测试通知'),
    ) as HTMLButtonElement | undefined;
    expect(testBtn).toBeDefined();

    await act(async () => {
      testBtn?.click();
    });

    expect(container.textContent).toContain('成功 1');
    expect(container.textContent).toContain('失败 1');
  });
});
