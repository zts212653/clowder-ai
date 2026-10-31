import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent } from '../PluginsContent';
import { DotConnectionDetail } from '../plugin-manager/DotConnectionDetail';

const mockApiFetch = vi.mocked(apiFetch);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function managerPlugin() {
  return {
    pluginId: 'official.chatgpt-dot',
    pluginInstanceId: 'pi_dot',
    displayName: 'ChatGPT 云端',
    description: 'Dot connection',
    source: { kind: 'catalog', catalogId: 'chatgpt-dot', packageName: '@cat-cafe/chatgpt-dot', trust: 'official' },
    artifact: 'installed',
    config: 'incomplete',
    auth: 'disconnected',
    intent: 'disabled',
    live: 'stopped',
    installedVersion: '0.1.0',
    availableVersion: '0.1.0',
    packageDigest: 'sha512-test',
    lifecycleRevision: 1,
    capabilitySummary: [],
    actions: { install: false, setEnabled: false, uninstall: true, blockingReasons: ['auth-disconnected'] },
  };
}
function response(dot = managerPlugin()) {
  return { plugins: [dot], catalog: { status: 'fresh', refreshedAt: 1 } };
}
function detail(dot = managerPlugin()) {
  return { plugin: { ...dot, configFields: [], contributions: [], capabilities: [] }, catalog: { status: 'fresh' } };
}
async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('F247 default plugin owner and recovery entry', () => {
  let container: HTMLDivElement, root: Root;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    window.history.replaceState({}, '', '/settings?s=plugins');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/settings');
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('opens the current cloud entry for an existing old-name installation without reinstalling', async () => {
    window.history.replaceState({}, '', '/settings?s=plugins');
    const dot = { ...managerPlugin(), displayName: 'ChatGPT dot' };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(dot));
      if (url === '/api/plugin-manager/plugins/official.chatgpt-dot') return json(detail(dot));
      if (url === '/api/plugin-manager/plugins/official.chatgpt-dot/documentation') return json({});
      if (url === '/api/plugins/chatgpt-dot/connection')
        return json({
          installed: true,
          endpointUrl: null,
          paired: false,
          subscription: 'absent',
          replyAt: null,
          imageAt: null,
          revoked: false,
        });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.querySelectorAll('[data-plugin-id="official.chatgpt-dot"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="启用dot协作"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="卸载dot协作"]')).not.toBeNull();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins');
    const dotRow = container.querySelector('[data-plugin-id="official.chatgpt-dot"]');
    const dotButton = Array.from(dotRow?.querySelectorAll('button') ?? []).find((candidate) =>
      candidate.textContent?.includes('ChatGPT 云端'),
    );
    expect(dotButton, 'stored package name must not replace the current shared-connection entry').toBeDefined();
    await act(async () => dotButton?.click());
    await flushEffects();
    expect(container.textContent).toContain('等待目标 dot 订阅');
    const proSetup = container.querySelector<HTMLAnchorElement>('a[href*="plugin=official.companion.personal-chrome"]');
    expect(proSetup?.textContent).toContain('Personal Chrome');
    expect(container.textContent).toContain('ChatGPT Pro');
    expect(container.textContent).toContain('尚未验证');
    expect(container.textContent).not.toContain('收到过原图');
    expect(dot.displayName).toBe('ChatGPT dot');
    expect(mockApiFetch.mock.calls.some(([url]) => String(url).endsWith('/install'))).toBe(false);
    const retiredHostReads = ['/api/plugins', '/api/plugins/official', '/api/plugins/personal-chrome'];
    expect(mockApiFetch.mock.calls.some(([url]) => retiredHostReads.includes(String(url)))).toBe(false);
  });

  it('explains a blocked dot enable and opens the existing ChatGPT plugin page without changing settings', async () => {
    const bodies: Record<string, unknown> = {
      '/api/plugin-manager/plugins': response(),
      '/api/plugin-manager/plugins/official.chatgpt-dot': detail(),
      '/api/plugins': { plugins: [] },
      '/api/plugins/official': { plugins: [] },
      '/api/cats': { cats: [] },
      '/api/plugins/chatgpt-dot/connection': {
        installed: true,
        paired: false,
        subscription: 'absent',
        endpointUrl: 'https://mcp.example/mcp',
        replyAt: null,
        imageAt: null,
        revoked: false,
      },
    };
    mockApiFetch.mockImplementation(async (url) => json(bodies[url] ?? {}, url in bodies ? 200 : 404));
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="启用dot协作"]');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    await flushEffects();
    const row = toggle?.closest('[data-plugin-list-row]');
    expect(row?.querySelector('output')?.textContent ?? '').toContain('订阅');
    expect(row?.querySelector('output')?.textContent ?? '').toContain('往返');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('验证通过后才能启用 dot 协作');
    expect(document.activeElement).toBe(container.querySelector('[role="alert"]'));
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://chatgpt.com/plugins"]');
    expect(link?.textContent).toContain('打开 ChatGPT 插件页面');
    expect(link?.target).toBe('_blank');
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('rechecks a blocked enable click and uses the latest Host revision once round trips are ready', async () => {
    let ready = false;
    let enabled = false;
    const current = () => ({
      ...managerPlugin(),
      auth: 'connected',
      config: ready ? 'ready' : 'incomplete',
      intent: enabled ? 'enabled' : 'disabled',
      live: enabled ? 'running' : 'stopped',
      lifecycleRevision: ready ? 9 : 1,
      actions: {
        install: false,
        setEnabled: ready,
        uninstall: true,
        blockingReasons: ready ? [] : ['config-incomplete'],
      },
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/official.chatgpt-dot/set-enabled' && init?.method === 'POST') {
        enabled = true;
        return json({ pluginId: 'official.chatgpt-dot', pluginInstanceId: 'pi_dot' });
      }
      const bodies: Record<string, unknown> = {
        '/api/plugin-manager/plugins': response(current()),
        '/api/plugin-manager/plugins/official.chatgpt-dot': detail(current()),
        '/api/plugins': { plugins: [] },
        '/api/plugins/official': { plugins: [] },
        '/api/cats': { cats: [] },
        '/api/plugins/chatgpt-dot/connection': {
          installed: true,
          paired: true,
          subscription: 'active',
          endpointUrl: 'https://mcp.example/mcp',
          replyAt: ready ? 100 : null,
          imageAt: null,
          revoked: false,
        },
        '/api/plugins/chatgpt-dot/test': {
          tests: [
            { eventId: 'test-a', receivedAt: 1, readAt: 1, replyMessageId: 'reply-a' },
            { eventId: 'test-b', receivedAt: 1, readAt: ready ? 1 : null, replyMessageId: ready ? 'reply-b' : null },
          ],
        },
      };
      return json(bodies[url] ?? {}, url in bodies ? 200 : 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const readsBefore = mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length;
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="启用dot协作"]');
    await act(async () => toggle?.click());
    await flushEffects();
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length).toBeGreaterThan(
      readsBefore,
    );
    expect(mockApiFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(toggle?.closest('[data-plugin-list-row]')?.querySelector('output')?.textContent).toContain('回帖');
    expect(container.querySelector('[aria-label="dot 连接"] [role="alert"]')?.textContent).toContain('测试 B');

    ready = true;
    await act(async () => toggle?.click());
    await flushEffects();
    const mutations = mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual([
      '/api/plugin-manager/plugins/official.chatgpt-dot/set-enabled',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, expectedRevision: 9 }),
      },
      { mutationTimeoutMs: 5 * 60_000 },
    ]);
    expect(container.querySelector('[aria-label="禁用dot协作"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-plugin-list-row] output')).toBeNull();
    expect(container.textContent).not.toContain('验证通过后才能启用 dot 协作');
  });

  it('honors the explicit enable read without relying on an idle poll', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      let enabled = false;
      let listReads = 0;
      let releaseClickRead!: (response: Response) => void;
      const clickRead = new Promise<Response>((resolve) => {
        releaseClickRead = resolve;
      });
      const current = () => ({
        ...managerPlugin(),
        config: ready ? 'ready' : 'incomplete',
        auth: 'connected',
        intent: enabled ? 'enabled' : 'disabled',
        live: enabled ? 'running' : 'stopped',
        lifecycleRevision: ready ? 9 : 1,
        actions: { install: false, setEnabled: ready, uninstall: true, blockingReasons: [] },
      });
      mockApiFetch.mockImplementation(async (url, init) => {
        if (url === '/api/plugin-manager/plugins') {
          listReads += 1;
          return listReads === 2 ? clickRead : json(response(current()));
        }
        if (url === '/api/plugin-manager/plugins/official.chatgpt-dot') return json(detail(current()));
        if (url === '/api/plugin-manager/plugins/official.chatgpt-dot/set-enabled' && init?.method === 'POST') {
          enabled = true;
          return json({ pluginId: 'official.chatgpt-dot', pluginInstanceId: 'pi_dot' });
        }
        if (url === '/api/plugins' || url === '/api/plugins/official') return json({ plugins: [] });
        return json({}, 404);
      });
      await act(async () => root.render(<PluginsContent />));
      await flushEffects();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="启用dot协作"]')?.click());
      expect(listReads).toBe(2);
      await act(async () => vi.advanceTimersByTime(5000));
      await flushEffects();
      expect(listReads).toBe(2);
      expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
      ready = true;
      await act(async () => releaseClickRead(json(response(current()))));
      await flushEffects();
      const posts = mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ enabled: true, expectedRevision: 9 });
      expect(container.querySelector('[aria-label="禁用dot协作"]')?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the installed ChatGPT connection and only asks the target dot to subscribe', async () => {
    const state = {
      installed: true,
      paired: false,
      subscription: 'absent',
      endpointUrl: 'https://mcp.example/mcp',
      replyAt: null,
      imageAt: null,
      revoked: false,
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/chatgpt-dot/connection') return json(state);
      if (url === '/api/plugins/chatgpt-dot/prepare')
        return json({ ...state, instructions: '订阅原连接的 dot.summoned' });
      if (url === '/api/cats') return json({ cats: [] });
      return json({}, 404);
    });
    await act(async () => root.render(<DotConnectionDetail installed />));
    await flushEffects();
    const prepare = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('准备'),
    );
    await act(async () => prepare?.click());
    await flushEffects();
    expect(container.textContent).toContain('Pro 会话与 dot 会话共用一个连接');
    expect(container.textContent).toContain('只为目标 dot 准备订阅');
    expect(container.textContent).toContain('订阅原连接的 dot.summoned');
    expect(container.textContent).not.toContain('复制插件地址');
    expect(container.textContent).not.toContain('在 ChatGPT 添加猫咖插件');
  });

  it('opens the exact dot recovery detail after delayed catalog discovery', async () => {
    window.history.replaceState({}, '', '/settings?s=plugins#chatgpt-dot');
    let publish: (value: Response) => void = () => {};
    const catalog = new Promise<Response>((resolve) => {
      publish = resolve;
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return catalog;
      if (url === '/api/plugin-manager/plugins/official.chatgpt-dot') return json(detail());
      if (url === '/api/plugins' || url === '/api/plugins/official') return json({ plugins: [] });
      if (url === '/api/plugins/chatgpt-dot/connection')
        return json({
          installed: true,
          paired: false,
          subscription: 'absent',
          endpointUrl: null,
          replyAt: null,
          imageAt: null,
          revoked: false,
        });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    await act(async () => {
      publish(json(response()));
      await catalog;
    });
    await flushEffects();
    expect(container.textContent).toContain('ChatGPT 云端 · dot 会话');
    expect(container.querySelector('[data-mobile-panel="detail"]')?.className).not.toContain('hidden');
    const back = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('返回插件列表'),
    );
    await act(async () => back?.click());
    await flushEffects();
    expect(container.querySelector('[data-mobile-panel="list"]')?.className).not.toContain('hidden');
  });
});
