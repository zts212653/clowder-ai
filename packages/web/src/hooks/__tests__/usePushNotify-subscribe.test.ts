// @vitest-environment jsdom
import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { type UsePushNotifyReturn, usePushNotify } from '../usePushNotify';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

function HookHarness({ onUpdate }: { onUpdate: (value: UsePushNotifyReturn) => void }) {
  const value = usePushNotify();
  useEffect(() => {
    onUpdate(value);
  }, [value, onUpdate]);
  return null;
}

describe('usePushNotify subscribe robustness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let hookValue: UsePushNotifyReturn | null = null;

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
    hookValue = null;

    const mockSubscription = {
      endpoint: 'https://push.example.com/sub/1',
      toJSON: () => ({
        endpoint: 'https://push.example.com/sub/1',
        keys: { p256dh: 'k1', auth: 'a1' },
      }),
      unsubscribe: vi.fn(async () => true),
    };

    const mockPushManager = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => mockSubscription),
    };

    const mockRegistration = {
      pushManager: mockPushManager,
    };

    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: {
        requestPermission: vi.fn(async () => 'granted'),
      },
    });

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          ready: Promise.resolve(mockRegistration),
          getRegistration: vi.fn(async () => mockRegistration),
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('does not mark subscribed when /api/push/subscribe fails', async () => {
    mockApiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enabled: true, key: 'AQAB' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Identity required' }),
      } as Response);

    await act(async () => {
      root.render(
        React.createElement(HookHarness, {
          onUpdate: (v) => {
            hookValue = v;
          },
        }),
      );
    });

    await act(async () => {
      await hookValue?.subscribe();
    });

    expect(hookValue?.isSubscribed).toBe(false);
  });

  it('exposes actionable error when service worker is not registered', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          ready: Promise.resolve(undefined),
          getRegistration: vi.fn(async () => null),
        },
      },
    });

    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ enabled: true, key: 'AQAB' }),
    } as Response);

    await act(async () => {
      root.render(
        React.createElement(HookHarness, {
          onUpdate: (v) => {
            hookValue = v;
          },
        }),
      );
    });

    await act(async () => {
      await hookValue?.subscribe();
    });

    expect(hookValue?.isSubscribed).toBe(false);
    expect(hookValue?.lastError).toContain('Service Worker 未注册');
  });
});
