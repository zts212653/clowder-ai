import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PersonalChromePluginPanel } from '../PersonalChromePluginPanel';

const mockApiFetch = vi.mocked(apiFetch);
const extensionId = 'a'.repeat(32);
const listingUrl = `https://chromewebstore.google.com/detail/personal-chatgpt-pro/${extensionId}`;

function state(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: 'personal-chrome-host',
    channel: 'developer_preview',
    platform: 'darwin',
    platformSupport: 'supported',
    artifact: { helper: 'ready', extension: 'chrome_web_store' },
    distribution: {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'unavailable',
      blockerCode: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
    },
    config: { status: 'ready' },
    authorization: { status: 'empty', count: 0, limit: 32, conversations: [] },
    intent: { status: 'developer_preview' },
    live: { status: 'dormant' },
    ...overrides,
  };
}

function publishedState(overrides: Record<string, unknown> = {}) {
  return state({
    distribution: {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'published',
      listingUrl,
    },
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.includes(label) || button.getAttribute('aria-label') === label,
  );
}

describe('PersonalChromePluginPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('uses the formal gpt-pro logo and reports publication truth without an unpacked path', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse(state()));

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();

    const logo = container.querySelector<HTMLImageElement>('img[alt="Personal ChatGPT Pro logo"]');
    expect(logo?.getAttribute('src')).toBe('/avatars/gpt-pro.png');
    expect(container.textContent).toContain('待发布');
    expect(findButton(container, '安装')).toBeUndefined();

    await act(async () => findButton(container, '查看 Personal ChatGPT Pro 详情')?.click());
    expect(container.textContent).toContain('发布集成已就绪，但扩展尚未公开发布');
    expect(container.textContent).toContain('缺少已发布的 Chrome Web Store listing URL 或发布权限');
    expect(container.textContent).toContain('在目标 ChatGPT 会话点击“授权此会话”');
    expect(container.textContent).not.toContain('chrome://extensions');
    expect(container.textContent).not.toContain('/repo/');
  });

  it('shows Windows as unsupported and offers no install mutation', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        state({
          platform: 'win32',
          platformSupport: 'unsupported',
          artifact: { helper: 'unsupported', extension: 'chrome_web_store' },
          config: { status: 'unsupported' },
          authorization: { status: 'unsupported', count: 0, limit: 32, conversations: [] },
          live: { status: 'unsupported' },
        }),
      ),
    );

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();

    expect(container.textContent).toContain('当前系统暂不支持');
    expect(findButton(container, '安装')).toBeUndefined();
    expect(findButton(container, '修复')).toBeUndefined();
  });

  it('fails closed for a damaged authorization collection instead of offering an overwrite', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        publishedState({
          authorization: { status: 'invalid', count: 0, limit: 32, conversations: [] },
        }),
      ),
    );

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();
    await act(async () => findButton(container, '查看 Personal ChatGPT Pro 详情')?.click());

    expect(container.textContent).toContain('授权记录损坏');
    expect(container.textContent).toContain('为避免误投，损坏记录不会发送也不会被新授权覆盖');
    expect(findButton(container, '修复')).toBeUndefined();
  });

  it('reports live degradation as a connection problem without offering host repair', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        publishedState({
          authorization: {
            status: 'authorized',
            count: 1,
            limit: 32,
            conversations: [
              {
                conversationId: 'conversation-17',
                authorizedAt: '2026-08-21T07:00:00.000Z',
                updatedAt: '2026-08-21T07:00:00.000Z',
              },
            ],
          },
          live: { status: 'degraded' },
        }),
      ),
    );

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();

    expect(container.textContent).toContain('连接异常');
    expect(findButton(container, '修复')).toBeUndefined();
  });

  it('turns a stale loaded adapter into one extension-reload action without another repair loop', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse(
        publishedState({
          authorization: {
            status: 'authorized',
            count: 1,
            limit: 32,
            conversations: [
              {
                conversationId: 'conversation-17',
                authorizedAt: '2026-08-21T07:00:00.000Z',
                updatedAt: '2026-08-21T07:00:00.000Z',
              },
            ],
          },
          live: { status: 'stale_adapter', errorCode: 'STALE_HELPER_PROTOCOL' },
        }),
      ),
    );

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();
    await act(async () => findButton(container, '查看 Personal ChatGPT Pro 详情')?.click());

    expect(container.textContent).toContain('扩展待重载');
    expect(container.textContent).toContain('在 Chrome 扩展页重载一次即可');
    expect(container.textContent).toContain('无需再刷新会话页');
    expect(findButton(container, '修复')).toBeUndefined();
  });

  it('offers Developer Preview repair for a stale installed artifact even before Web Store publication', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/personal-chrome' && !init) {
        return jsonResponse(
          state({
            artifact: { helper: 'stale', extension: 'chrome_web_store' },
            config: { status: 'ready' },
            live: { status: 'restart_required' },
          }),
        );
      }
      if (url === '/api/plugins/personal-chrome/repair') return jsonResponse(state());
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();

    expect(container.textContent).toContain('需升级');
    expect(findButton(container, '安装')).toBeUndefined();
    await act(async () => findButton(container, '修复')?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/personal-chrome/repair', { method: 'POST' });
  });

  it('uses one Settings action to prepare the Host and open the published Web Store journey', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/personal-chrome' && !init) {
        return jsonResponse(
          publishedState({
            artifact: { helper: 'absent', extension: 'chrome_web_store' },
            config: { status: 'absent' },
          }),
        );
      }
      if (url === '/api/plugins/personal-chrome/install') return jsonResponse(publishedState());
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();
    await act(async () => findButton(container, '安装')?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/personal-chrome/install', { method: 'POST' });
    expect(open).toHaveBeenCalledWith(listingUrl, '_blank', 'noopener,noreferrer');
    expect(container.textContent).toContain('待授权');
  });

  it('refreshes Host authorization in place so the current-thread route step appears', async () => {
    let inspectCount = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/personal-chrome' && !init) {
        inspectCount += 1;
        if (inspectCount === 1) return jsonResponse(publishedState());
        return jsonResponse(
          publishedState({
            authorization: {
              status: 'authorized',
              count: 1,
              limit: 32,
              conversations: [
                {
                  conversationId: 'conversation-after-refresh',
                  authorizedAt: '2026-08-23T07:00:00.000Z',
                  updatedAt: '2026-08-23T07:00:00.000Z',
                },
              ],
            },
          }),
        );
      }
      if (url.endsWith('/cloud-bindings')) return jsonResponse({ bindings: {} }, 403);
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();
    await act(async () => findButton(container, '查看 Personal ChatGPT Pro 详情')?.click());
    expect(container.textContent).not.toContain('当前 thread 路由');

    await act(async () => findButton(container, '刷新状态')?.click());
    await flushEffects();

    expect(inspectCount).toBe(2);
    expect(container.textContent).toContain('Host 会话授权');
    expect(container.textContent).toContain('conversation-after-refresh');
    expect(container.textContent).toContain('当前 thread 路由');
  });

  it('shows a bounded authorization list and revokes one exact conversation', async () => {
    const initial = publishedState({
      authorization: {
        status: 'authorized',
        count: 2,
        limit: 32,
        conversations: [
          {
            conversationId: 'conversation-17',
            authorizedAt: '2026-08-21T07:00:00.000Z',
            updatedAt: '2026-08-21T07:00:00.000Z',
          },
          {
            conversationId: 'conversation-18',
            authorizedAt: '2026-08-21T07:01:00.000Z',
            updatedAt: '2026-08-21T07:01:00.000Z',
          },
        ],
      },
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/personal-chrome' && !init) return jsonResponse(initial);
      if (url === '/api/plugins/personal-chrome/authorizations/conversation-17' && init?.method === 'DELETE') {
        return jsonResponse(
          publishedState({
            authorization: {
              status: 'authorized',
              count: 1,
              limit: 32,
              conversations: [initial.authorization.conversations[1]],
            },
          }),
        );
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<PersonalChromePluginPanel />));
    await flushEffects();
    await act(async () => findButton(container, '查看 Personal ChatGPT Pro 详情')?.click());

    expect(container.textContent).toContain('已授权会话（2/32）');
    expect(container.textContent).toContain('当前 thread 路由');
    expect(container.textContent).toContain('conversation-17');
    expect(container.textContent).toContain('conversation-18');
    await act(async () => findButton(container, '撤销会话 conversation-17')?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/personal-chrome/authorizations/conversation-17', {
      method: 'DELETE',
    });
    expect(container.textContent).not.toContain('conversation-17');
    expect(container.textContent).toContain('conversation-18');
  });
});
