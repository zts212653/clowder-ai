import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushServiceConfig } from '../PushServiceConfig';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe('PushServiceConfig', () => {
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
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/push/status') {
        return Promise.resolve(
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
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('generates VAPID keys and fills the save form', async () => {
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/push/generate-vapid') {
        return Promise.resolve(jsonResponse({ publicKey: 'public-from-server', privateKey: 'private-from-server' }));
      }
      if (path === '/api/push/status') {
        return Promise.resolve(jsonResponse({ capability: {}, subscription: {}, delivery: {}, errorHints: [] }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    await act(async () => {
      root.render(React.createElement(PushServiceConfig));
    });

    await act(async () => {
      findButton(container, '生成 VAPID 密钥').click();
    });

    const publicInput = container.querySelector('input[name="VAPID_PUBLIC_KEY"]') as HTMLInputElement | null;
    const privateInput = container.querySelector('input[name="VAPID_PRIVATE_KEY"]') as HTMLInputElement | null;
    expect(publicInput?.value).toBe('public-from-server');
    expect(privateInput?.value).toBe('private-from-server');
    expect(container.textContent).toContain('已生成一组新密钥');
  });

  it('saves contact-only edits without sending omitted VAPID secrets', async () => {
    await act(async () => {
      root.render(React.createElement(PushServiceConfig));
    });

    const subjectInput = container.querySelector('input[name="VAPID_SUBJECT"]') as HTMLInputElement | null;
    expect(subjectInput).not.toBeNull();

    await act(async () => {
      setInputValue(subjectInput as HTMLInputElement, 'mailto:owner@example.com');
    });

    await act(async () => {
      findButton(container, '保存推送配置').click();
    });

    const saveCall = mocks.apiFetch.mock.calls.find(([path]) => path === '/api/config/secrets');
    expect(saveCall).toBeDefined();
    const body = JSON.parse(String((saveCall?.[1] as RequestInit).body));
    expect(body.updates).toEqual([{ name: 'VAPID_SUBJECT', value: 'mailto:owner@example.com' }]);
  });

  it('shows owner fail-closed errors from the save endpoint', async () => {
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/secrets') {
        return Promise.resolve(
          jsonResponse({ error: 'Connector credential writes require DEFAULT_OWNER_USER_ID to be configured' }, 403),
        );
      }
      if (path === '/api/push/status') {
        return Promise.resolve(jsonResponse({ capability: {}, subscription: {}, delivery: {}, errorHints: [] }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    await act(async () => {
      root.render(React.createElement(PushServiceConfig));
    });

    const subjectInput = container.querySelector('input[name="VAPID_SUBJECT"]') as HTMLInputElement | null;
    await act(async () => {
      setInputValue(subjectInput as HTMLInputElement, 'mailto:owner@example.com');
    });
    await act(async () => {
      findButton(container, '保存推送配置').click();
    });

    expect(container.textContent).toContain('DEFAULT_OWNER_USER_ID 未配置');
  });
});
