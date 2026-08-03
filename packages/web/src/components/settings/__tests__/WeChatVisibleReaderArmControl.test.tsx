import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { WeChatVisibleReaderArmControl } from '../WeChatVisibleReaderArmControl';

const mockApiFetch = vi.mocked(apiFetch);

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

describe('WeChatVisibleReaderArmControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
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

  it('shows the privacy disclosure and arms for ten minutes from a disarmed state', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/wechat-visible-reader/arm' && !init?.method) {
        return jsonResponse({ enabled: true, armed: false, remainingMs: 0 });
      }
      if (url === '/api/plugins/wechat-visible-reader/arm' && init?.method === 'POST') {
        return jsonResponse({
          enabled: true,
          armed: true,
          armedBy: 'owner-user',
          armedAt: '2026-07-17T04:00:00.000Z',
          expiresAt: '2026-07-17T04:10:00.000Z',
          remainingMs: 600_000,
        });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => {
      root.render(<WeChatVisibleReaderArmControl pluginEnabled />);
    });
    await flushEffects();

    expect(container.textContent).toContain('不会保存截图');
    expect(container.textContent).toContain('模型上下文');
    expect(container.textContent).toContain('Clowder AI invocation trace');
    expect(container.textContent).toContain('短暂切到微信');
    expect(container.textContent).toContain('可能清除目标会话未读');
    expect(container.textContent).toContain('尽力恢复');
    expect(container.textContent).toContain('当前未授权');

    const armButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('授权读取 10 分钟'),
    );
    expect(armButton).toBeTruthy();

    await act(async () => {
      armButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const armCall = mockApiFetch.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(armCall?.[0]).toBe('/api/plugins/wechat-visible-reader/arm');
    expect(JSON.parse(armCall?.[1]?.body as string)).toEqual({ minutes: 10 });
    expect(container.textContent).toContain('已授权');
    expect(container.textContent).toContain('剩余 10:00');
  });

  it('revokes an active authorization immediately', async () => {
    mockApiFetch.mockImplementation(async (_url, init) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ enabled: true, armed: false, remainingMs: 0 });
      }
      return jsonResponse({
        enabled: true,
        armed: true,
        expiresAt: '2026-07-17T04:10:00.000Z',
        remainingMs: 120_000,
      });
    });

    await act(async () => {
      root.render(<WeChatVisibleReaderArmControl pluginEnabled />);
    });
    await flushEffects();

    const revokeButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('立即撤销'),
    );
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(true);
    expect(container.textContent).toContain('当前未授权');
  });

  it('fails closed while the plugin is disabled', async () => {
    await act(async () => {
      root.render(<WeChatVisibleReaderArmControl pluginEnabled={false} />);
    });
    await flushEffects();

    expect(container.textContent).toContain('请先启用插件');
    expect(container.textContent).toContain('不会保存截图');
    expect(container.textContent).not.toContain('授权读取 10 分钟');
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('renders a recoverable error when status loading is rejected', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));

    await act(async () => {
      root.render(<WeChatVisibleReaderArmControl pluginEnabled />);
    });
    await flushEffects();

    expect(container.textContent).toContain('无法读取授权状态');
    expect(container.textContent).toContain('重试');
  });
});
