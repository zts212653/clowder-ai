import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginsContent, resolvePluginManagerDesignGate } from '../PluginsContent';

const mockApiFetch = vi.mocked(apiFetch);
const digest = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function managerPlugin({
  installed = false,
  revision = 7,
  pluginId = 'dev.clowder.video-analysis',
  displayName = 'Video Analysis',
} = {}) {
  return {
    pluginId,
    pluginInstanceId: installed ? 'pi_video' : null,
    displayName,
    description: {
      default: 'Analyze remote videos.',
      translations: { 'zh-CN': '分析远程视频。' },
    },
    icon: { type: 'svg', src: '/api/plugin-manager/assets/video/icon.svg' },
    publisher: 'Clowder AI',
    source: {
      kind: 'catalog',
      catalogId: 'dev.clowder.video-analysis',
      packageName: '@clowder-ai/video-analysis',
      trust: 'official',
    },
    availableVersion: '0.1.0-alpha.0',
    installedVersion: installed ? '0.1.0-alpha.0' : null,
    packageDigest: digest,
    artifact: installed ? 'installed' : 'absent',
    config: installed ? 'ready' : 'incomplete',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    lifecycleRevision: installed ? revision : null,
    capabilitySummary: [{ id: 'video-analysis-toolset', kind: 'mcp', name: 'Video analysis', active: false }],
    actions: {
      install: !installed,
      setEnabled: installed,
      uninstall: installed,
      blockingReasons: [],
    },
  } as const;
}

function response(plugin: unknown = managerPlugin()) {
  return {
    plugins: [plugin],
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

type ManagerPluginFixture = ReturnType<typeof managerPlugin>;
type ManagerPluginDetailFixture = Omit<ManagerPluginFixture, 'live'> & { readonly live: 'stopped' | 'running' };
type ManagerPluginConfigurationFixture = Omit<ManagerPluginFixture, 'config' | 'lifecycleRevision' | 'actions'> & {
  readonly config: 'ready' | 'incomplete';
  readonly lifecycleRevision: number | null;
  readonly actions: {
    readonly install: boolean;
    readonly setEnabled: boolean;
    readonly uninstall: boolean;
    readonly blockingReasons: readonly string[];
  };
};

function detail(plugin: ManagerPluginDetailFixture = managerPlugin()) {
  return {
    plugin: {
      ...plugin,
      capabilities: plugin.capabilitySummary.map((capability) => ({
        ...capability,
        description: 'Analyze a selected video.',
      })),
      configFields: [],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function configuredDetail(
  plugin: ManagerPluginConfigurationFixture = managerPlugin({ installed: true }),
  saved = false,
) {
  return {
    plugin: {
      ...plugin,
      capabilities: plugin.capabilitySummary,
      configFields: [
        {
          key: 'provider',
          label: 'Video provider',
          kind: 'select',
          required: true,
          sensitive: false,
          currentValue: saved ? 'gemini' : null,
          options: [
            { value: 'gemini', label: 'Gemini' },
            { value: 'zhipu', label: 'Zhipu' },
          ],
        },
        {
          key: 'apiKey',
          label: 'API key',
          kind: 'secret',
          required: true,
          sensitive: true,
          currentValue: saved ? '••••••' : null,
        },
      ],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function connectorPlugin() {
  return {
    ...managerPlugin({ installed: true }),
    pluginId: 'telegram',
    displayName: 'Telegram',
    source: {
      kind: 'compatibility',
      adapter: 'connector',
      packageName: 'connector:telegram',
      trust: 'first-party',
    },
    packageDigest: null,
    pluginInstanceId: null,
    lifecycleRevision: null,
    actions: {
      install: false,
      setEnabled: false,
      uninstall: false,
      blockingReasons: ['compatibility-read-only'],
    },
  } as const;
}

function connectorDetail() {
  const plugin = connectorPlugin();
  return {
    plugin: {
      ...plugin,
      capabilities: [],
      configFields: [
        {
          kind: 'secret',
          key: 'TELEGRAM_BOT_TOKEN',
          label: 'Bot token',
          required: true,
          sensitive: true,
          currentValue: null,
        },
      ],
    },
    catalog: { status: 'fresh', refreshedAt: 1_000 },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('F202 Plugin Manager surface selection', () => {
  it('keeps the live Manager reachable from the production start:direct build', () => {
    expect(resolvePluginManagerDesignGate('?pluginManagerLive=1', 'production')).toEqual({
      resolved: true,
      enabled: false,
      live: true,
      degradedCatalog: false,
    });
  });

  it('keeps the fixture-only design surface development-only', () => {
    expect(resolvePluginManagerDesignGate('?pluginManagerDemo=1', 'production')).toEqual({
      resolved: true,
      enabled: false,
      live: false,
      degradedCatalog: false,
    });
  });
});

describe('F202 live Plugin Manager Console wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/settings?pluginManagerLive=1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/settings');
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('loads list and detail only from the canonical Manager surface', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') {
        return json({ readmeMarkdown: '# Video Analysis\n\nHuman-facing details.' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('Video Analysis');
    expect(container.textContent).toContain('分析远程视频。');
    expect(container.textContent).toContain('Human-facing details.');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins');
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/official')).toBe(false);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/personal-chrome')).toBe(false);
  });

  it('loads detail for the installed plugin selected by visible section ordering', async () => {
    const audio = managerPlugin({
      pluginId: 'dev.clowder.audio-notes',
      displayName: 'Audio Notes',
    });
    const video = managerPlugin({ installed: true });
    const detailReads: string[] = [];
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') {
        return json({ plugins: [audio, video], catalog: { status: 'fresh', refreshedAt: 1_000 } });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.audio-notes') {
        detailReads.push(audio.pluginId);
        return json(detail(audio));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        detailReads.push(video.pluginId);
        return json(detail(video));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.audio-notes/documentation') {
        return json({ readmeMarkdown: '# Audio Notes' });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') {
        return json({ readmeMarkdown: '# Video Analysis README' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.querySelector('[data-plugin-id="dev.clowder.video-analysis"]')?.getAttribute('aria-current')).toBe(
      'true',
    );
    expect(container.textContent).toContain('Video Analysis README');
    expect(container.textContent).not.toContain('README 加载中…');
    expect(detailReads).toEqual([video.pluginId]);
  });

  it('shows an honest loading surface before the first Manager snapshot arrives', async () => {
    mockApiFetch.mockReturnValue(new Promise<Response>(() => {}));

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.querySelector('[data-testid="plugin-manager-loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain('没有符合条件的插件');
  });

  it('sends the exact lifecycle revision and refreshes after a stale conflict', async () => {
    const installed = managerPlugin({ installed: true });
    let listReads = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') {
        listReads += 1;
        return json(response(installed));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail(installed));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled' && init?.method === 'POST') {
        return json({ error: 'state changed', code: 'STALE_REVISION' }, 409);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="启用Video Analysis"]');
    await act(async () => (toggle as HTMLButtonElement | null)?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedRevision: 7 }),
    });
    expect(listReads).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('插件状态已变化，已刷新最新状态');
  });

  it('installs the exact catalog release and searches through the canonical endpoint', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/search?q=video') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/install' && init?.method === 'POST') {
        return json({ pluginId: 'dev.clowder.video-analysis', pluginInstanceId: 'pi_video' }, 201);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'video');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/search?q=video');

    const install = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '安装');
    await act(async () => install?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { kind: 'catalog', catalogId: 'dev.clowder.video-analysis' },
        expectedVersion: '0.1.0-alpha.0',
        expectedDigest: digest,
      }),
    });
  });

  it('preserves server matches whose query is visible only in plugin identity or publisher metadata', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/search?q=Clowder%20AI') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'Clowder AI');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/search?q=Clowder%20AI');
    expect(container.textContent).toContain('Video Analysis');
    expect(container.textContent).not.toContain('没有符合条件的插件');
  });

  it('loads detail for the visible fallback when search removes the prior selection', async () => {
    const video = managerPlugin({ installed: true });
    const audio = managerPlugin({
      pluginId: 'dev.clowder.audio-notes',
      displayName: 'Audio Notes',
    });
    const calendar = managerPlugin({
      installed: true,
      pluginId: 'dev.clowder.calendar-assistant',
      displayName: 'Calendar Assistant',
    });
    const detailReads: string[] = [];
    const detailsByUrl = new Map<string, ManagerPluginFixture>(
      [video, audio, calendar].map((plugin) => [`/api/plugin-manager/plugins/${plugin.pluginId}`, plugin] as const),
    );
    const documentationByUrl = new Map<string, string>(
      [video, audio, calendar].map((plugin) => [
        `/api/plugin-manager/plugins/${plugin.pluginId}/documentation`,
        plugin.displayName,
      ]),
    );
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(video));
      if (url === '/api/plugin-manager/plugins/search?q=Clowder%20AI') {
        return json({ plugins: [audio, calendar], catalog: { status: 'fresh', refreshedAt: 1_000 } });
      }
      const detailPlugin = detailsByUrl.get(String(url));
      if (detailPlugin) {
        detailReads.push(detailPlugin.pluginId);
        return json(detail(detailPlugin));
      }
      const documentationName = documentationByUrl.get(String(url));
      if (documentationName) return json({ readmeMarkdown: `# ${documentationName} README` });
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'Clowder AI');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();

    expect(
      container.querySelector('[data-plugin-id="dev.clowder.calendar-assistant"]')?.getAttribute('aria-current'),
    ).toBe('true');
    expect(container.textContent).toContain('Calendar Assistant README');
    expect(container.textContent).not.toContain('README 加载中…');
    expect(detailReads.at(-1)).toBe(calendar.pluginId);
  });

  it('renders a compatibility configuration contribution and saves through its typed boundary', async () => {
    const plugin = connectorPlugin();
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/telegram') return json(connectorDetail());
      if (url === '/api/connectors/telegram/config' && init?.method === 'PUT') return json({ ok: true });
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    const input = container.querySelector('[data-testid="field-TELEGRAM_BOT_TOKEN"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, '123456:secret');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('保存配置'),
    ) as HTMLButtonElement | undefined;
    expect(input?.value).toBe('123456:secret');
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/connectors/telegram/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: [{ name: 'TELEGRAM_BOT_TOKEN', value: '123456:secret' }] }),
    });
  });

  it('saves the visible select value, confirms success, and enables with the refreshed revision', async () => {
    const installed = managerPlugin({ installed: true });
    const blocked = {
      ...installed,
      config: 'incomplete' as const,
      actions: { ...installed.actions, setEnabled: false, blockingReasons: ['config-incomplete'] },
    };
    const ready = {
      ...installed,
      config: 'ready' as const,
      lifecycleRevision: 8,
      actions: { ...installed.actions, setEnabled: true, blockingReasons: [] },
    };
    let saved = false;
    mockApiFetch.mockImplementation(async (url, init) => {
      switch (`${init?.method ?? 'GET'} ${url}`) {
        case 'GET /api/plugin-manager/plugins':
          return json(response(saved ? ready : blocked));
        case 'GET /api/plugin-manager/plugins/dev.clowder.video-analysis':
          return json(configuredDetail(saved ? ready : blocked, saved));
        case 'POST /api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/configuration':
          saved = true;
          return json({ pluginId: installed.pluginId, pluginInstanceId: 'pi_video' });
        case 'POST /api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled':
          return json({ pluginId: installed.pluginId, pluginInstanceId: 'pi_video' });
        default:
          return json({}, 404);
      }
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const input = container.querySelector('[data-testid="field-apiKey"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, 'private-key');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('保存配置'),
    );
    await act(async () => save?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/configuration',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 7,
          updates: [
            { key: 'provider', value: 'gemini' },
            { key: 'apiKey', value: 'private-key' },
          ],
        }),
      },
    );
    expect(container.textContent).toContain('配置已保存');

    const toggle = container.querySelector('button[aria-label="启用Video Analysis"]') as HTMLButtonElement | null;
    await act(async () => toggle?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedRevision: 8 }),
    });
  });

  it('uses the shared Console confirmation flow before uninstalling', async () => {
    const plugin = managerPlugin({ installed: true });
    const nativeConfirm = vi.spyOn(window, 'confirm');
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/uninstall' && init?.method === 'POST') {
        return json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const uninstall = container.querySelector('button[aria-label="卸载Video Analysis"]') as HTMLButtonElement | null;
    await act(async () => uninstall?.click());
    await flushEffects();

    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/dev.clowder.video-analysis/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    nativeConfirm.mockRestore();
  });

  it('loads active contribution tools for capability documentation', async () => {
    const plugin = { ...managerPlugin({ installed: true }), live: 'running' as const };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        return json({
          ...detail(plugin),
          plugin: {
            ...detail(plugin).plugin,
            contributions: [
              {
                id: 'video-analysis-toolset',
                kind: 'mcp',
                name: 'video-analysis-toolset',
                description: 'Analyze videos.',
              },
            ],
          },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/tools') {
        return json({
          pluginId: plugin.pluginId,
          tools: [
            {
              contributionId: 'video-analysis-toolset',
              name: 'video_analysis',
              description: 'Analyze an explicitly selected video.',
              inputSchema: { type: 'object' },
            },
          ],
        });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/tools',
    );
    expect(container.textContent).toContain('video_analysis');
    expect(container.textContent).toContain('Analyze an explicitly selected video.');
  });

  it('reports active contribution tools as unavailable when their detail request fails', async () => {
    const plugin = { ...managerPlugin({ installed: true }), live: 'running' as const };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        return json({
          ...detail(plugin),
          plugin: {
            ...detail(plugin).plugin,
            contributions: [
              {
                id: 'video-analysis-toolset',
                kind: 'mcp',
                name: 'video-analysis-toolset',
                description: 'Analyze videos.',
              },
              {
                id: 'undocumented-toolset',
                kind: 'mcp',
                name: 'undocumented-toolset',
              },
            ],
          },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/contributions/tools') {
        return json({}, 503);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('Analyze videos.');
    expect(container.textContent).toContain('undocumented-toolset');
    expect(container.textContent).toContain('工具信息暂不可用。');
    expect(container.textContent).not.toContain('插件未提供用途说明。');
  });

  it('reports package documentation as unavailable when its Host request fails', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') {
        return json({ error: 'archive fetch failed', code: 'INVALID_ASSET' }, 503);
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('README 暂不可用。');
    expect(container.textContent).not.toContain('此版本未随插件包提供 README。');
  });

  it('keeps package documentation in a loading state until detail projection completes', async () => {
    let resolveDocumentation: ((response: Response) => void) | undefined;
    const documentation = new Promise<Response>((resolve) => {
      resolveDocumentation = resolve;
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') return documentation;
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('README 加载中…');
    expect(container.textContent).not.toContain('此版本未随插件包提供 README。');

    resolveDocumentation?.(json({}));
    await flushEffects();
    expect(container.textContent).not.toContain('此版本未随插件包提供 README。');
  });

  it('reports package documentation as unavailable when plugin detail loading fails', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json({}, 503);
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') return json({});
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('README 暂不可用。');
    expect(container.textContent).not.toContain('此版本未随插件包提供 README。');
  });

  it.each([
    { label: 'an explicit empty response', status: 200 },
    { label: 'a compatibility-layer miss', status: 404 },
  ])('keeps README absent for $label', async ({ status }) => {
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') return json({}, status);
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).not.toContain('此版本未随插件包提供 README。');
    expect(container.textContent).not.toContain('README 暂不可用。');
  });

  it('polls by replacing the same projection without emitting duplicate UI errors', async () => {
    vi.useFakeTimers();
    let listReads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') {
        listReads += 1;
        return json(response(managerPlugin({ installed: true })));
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        return json(detail(managerPlugin({ installed: true })));
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(listReads).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listReads).toBe(2);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-plugin-id="dev.clowder.video-analysis"]')).toHaveLength(1);
  });

  it('keeps an unavailable detail state stable while polling retries it', async () => {
    vi.useFakeTimers();
    let detailReads = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    const retry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(managerPlugin({ installed: true })));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        detailReads += 1;
        return detailReads === 1 ? json({}, 503) : retry;
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') return json({});
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.textContent).toContain('README 暂不可用。');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(detailReads).toBe(2);
    expect(container.textContent).toContain('README 暂不可用。');
    expect(container.textContent).not.toContain('README 加载中…');

    resolveRetry?.(json({}, 503));
    await flushEffects();
  });
});
