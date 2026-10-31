import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { ThreadNativeStatusSettingsContent } from '../ThreadNativeStatusSettings';

describe('ThreadNativeStatusSettingsContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows authoritative source, freshness, exact values, and independent unavailable groups', async () => {
    apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statuses: [
            {
              catId: 'codex',
              runtimeSessionId: 'native-1',
              observation: 'available',
              source: 'codex_app_server',
              observedAt: Date.now(),
              thread: { availability: 'available', status: 'idle', canAcceptDirectInput: true },
              capabilities: {
                availability: 'available',
                imageGeneration: true,
                namespaceTools: false,
                webSearch: true,
              },
              permissionProfiles: {
                availability: 'available',
                activeId: ':danger-full-access',
                profiles: [{ id: ':danger-full-access', allowed: true }],
              },
              account: { availability: 'available', authenticated: true, kind: 'chatgpt', plan: 'pro' },
              rateLimits: { availability: 'unavailable', reason: 'provider_request_failed' },
              nativeThreadList: { availability: 'available', count: 12, boundThreadPresent: true, hasMore: false },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await act(async () => root.render(<ThreadNativeStatusSettingsContent threadId="thread-1" />));
    expect(container.textContent).toContain('Codex app-server 实时读取');
    expect(container.textContent).toContain('刚刚');
    expect(container.textContent).toContain(':danger-full-access');
    expect(container.textContent).toContain('web search · image generation');
    expect(container.textContent).toContain('额度：当前不可用');
    expect(container.textContent).toContain('原生 thread 诊断：12');
    expect(container.textContent).not.toContain('provider-only-history');
  });

  it('does not infer a runtime status when there is no active binding', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ statuses: [] }), { status: 200 }));
    await act(async () => root.render(<ThreadNativeStatusSettingsContent threadId="thread-1" />));
    expect(container.textContent).toContain('没有可读取的 Codex 原生会话绑定');
  });

  it('labels a failed read as unavailable without claiming provider provenance or freshness', async () => {
    apiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statuses: [
            {
              catId: 'codex',
              runtimeSessionId: 'native-1',
              observation: 'unavailable',
              reason: 'provider_request_failed',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await act(async () => root.render(<ThreadNativeStatusSettingsContent threadId="thread-1" />));
    expect(container.textContent).toContain('本次未取得 Codex app-server 状态');
    expect(container.textContent).not.toContain('来源：Codex app-server 实时读取');
    expect(container.textContent).not.toContain('刚刚');
  });
});
