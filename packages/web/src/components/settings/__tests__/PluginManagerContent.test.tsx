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

  it('renders installed plugins before remote catalog discovery settles, then hydrates available plugins once', async () => {
    const installed = {
      ...managerPlugin({ installed: true, pluginId: 'local.github', displayName: 'Installed GitHub' }),
      live: 'running' as const,
    };
    let resolveRemote: ((value: Response) => void) | undefined;
    const remote = new Promise<Response>((resolve) => {
      resolveRemote = resolve;
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({
          plugins: [installed],
          catalog: { status: 'loading', refreshedAt: null, message: '正在加载可安装插件。' },
        });
      }
      if (url === '/api/plugin-manager/plugins') return remote;
      if (url === '/api/plugin-manager/plugins/_local/local.github') {
        const localDetail = detail(installed);
        return json({
          ...localDetail,
          plugin: {
            ...localDetail.plugin,
            contributions: [
              {
                id: 'github-tools',
                kind: 'mcp',
                name: 'github-tools',
                description: 'GitHub tools.',
              },
            ],
          },
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins/local.github/documentation') {
        return json({ readmeMarkdown: '# Installed README\n\nLocal package documentation.' });
      }
      if (url === '/api/plugin-manager/plugins/local.github/contributions/tools') {
        return json({
          pluginId: installed.pluginId,
          tools: [
            {
              contributionId: 'github-tools',
              name: 'installed_tool',
              description: 'Tool projected by the active local runtime.',
              inputSchema: { type: 'object' },
            },
          ],
        });
      }
      if (url === '/api/plugin-manager/plugins/local.github') return json(detail(installed));
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('Installed GitHub');
    expect(container.textContent).not.toContain('Video Analysis');
    expect(container.textContent).not.toContain('正在加载可安装插件。');
    expect(container.textContent).not.toContain('目录暂时不可用');
    expect(container.textContent).toContain('Local package documentation.');
    expect(container.textContent).toContain('installed_tool');

    await act(async () => {
      resolveRemote?.(
        json({
          plugins: [installed, managerPlugin()],
          catalog: { status: 'fresh', refreshedAt: 1_000 },
        }),
      );
      await Promise.resolve();
    });
    await flushEffects();

    expect(container.textContent).toContain('Installed GitHub');
    expect(container.textContent).toContain('Video Analysis');
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length).toBe(1);
    expect(
      mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins/_local/local.github').length,
    ).toBeGreaterThan(0);
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins/local.github').length).toBe(
      0,
    );
  });

  it('keeps installed plugins usable when the incremental remote catalog read fails', async () => {
    const installed = managerPlugin({ installed: true, pluginId: 'local.github', displayName: 'Installed GitHub' });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({ plugins: [installed], catalog: { status: 'loading', refreshedAt: null } });
      }
      if (url === '/api/plugin-manager/plugins') throw new TypeError('network unavailable');
      if (url === '/api/plugin-manager/plugins/_local/local.github') {
        return json({ ...detail(installed), catalog: { status: 'loading', refreshedAt: null } });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('Installed GitHub');
    expect(container.textContent).toContain('目录暂时不可用；已安装插件仍可管理');
    expect(container.querySelector('button[aria-label="启用Installed GitHub"]')).not.toBeNull();
  });

  it('reaches archive confirmation from the live Manager toolbar and refreshes after installation', async () => {
    let installed = false;
    const confirmation = {
      pluginId: 'dev.clowder.video-analysis',
      pluginInstanceId: 'pi_video',
      currentPackageDigest: digest,
      candidatePackageDigest: digest,
      expectedLifecycleRevision: 7,
    };
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(managerPlugin({ installed })));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis')
        return json(detail(managerPlugin({ installed })));
      if (url === '/api/plugin-manager/plugins/install/upload') {
        const body = init?.body as FormData;
        if (!body.has('replacement'))
          return json(
            {
              code: 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED',
              replacement: {
                confirmation,
                displayName: 'Video Analysis',
                currentVersion: '0.1.0',
                candidateVersion: '0.2.0',
              },
            },
            409,
          );
        expect(JSON.parse(body.get('replacement') as string)).toEqual(confirmation);
        installed = true;
        return json({ pluginId: confirmation.pluginId, pluginInstanceId: confirmation.pluginInstanceId }, 201);
      }
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const input = container.querySelector<HTMLInputElement>('[data-plugin-manager-toolbar] input[type="file"]');
    expect(input, 'archive must be reachable from the real live Manager toolbar').not.toBeNull();
    if (!input) return;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'plugin.tgz')] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('0.1.0 替换为 0.2.0');
    expect(installed).toBe(false);
    const confirm = [...container.querySelectorAll('button')].find((button) => button.textContent === '确认替换');
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    await flushEffects();
    expect(installed).toBe(true);
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/plugins').length).toBeGreaterThan(1);
    expect(container.textContent).toContain('安装成功: dev.clowder.video-analysis');
  });

  it('keeps a historical installed plugin visible with the existing unknown-origin label in list and detail', async () => {
    const legacy = {
      ...managerPlugin({ installed: true, pluginId: 'dev.clowder.genoffice-docx', displayName: 'Installed GenOffice' }),
      source: { kind: 'unknown', packageName: null, trust: 'unknown' },
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(legacy));
      if (url === `/api/plugin-manager/plugins/${legacy.pluginId}`)
        return json({
          plugin: { ...legacy, capabilities: legacy.capabilitySummary, configFields: [] },
          catalog: { status: 'fresh', refreshedAt: 1000 },
        });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const row = container.querySelector(`[data-plugin-id="${legacy.pluginId}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector('[data-plugin-source-trust="unknown"]')?.textContent).toContain('缺少安装来源记录');
    expect(container.querySelector('[data-testid="plugin-manager-detail"]')?.textContent).toContain(
      'Installed GenOffice',
    );
    expect(mockApiFetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('preserves manifest colors in repository compatibility rows and their detail cards', async () => {
    window.history.replaceState({}, '', '/settings?s=plugins');
    const repository = {
      id: 'weixin-mp',
      name: '微信公众号',
      version: '1.0.0',
      status: 'enabled',
      description: 'Manifest description',
      icon: 'megaphone',
      iconBg: '#07c160',
      configured: true,
      config: [],
      resources: [],
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins') return json({ plugins: [repository] });
      if (url === '/api/plugins/official') return json({ plugins: [] });
      if (url === '/api/plugin-manager/plugins')
        return json(
          response({
            ...managerPlugin({ installed: true, pluginId: repository.id, displayName: repository.name }),
            icon: repository.icon,
            iconBg: repository.iconBg,
          }),
        );
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const row = container.querySelector('[data-plugin-id="weixin-mp"]');
    const listIcon = row?.querySelector('[data-plugin-icon="megaphone"]') as HTMLElement | null;
    expect(listIcon?.style.backgroundColor).toBe('rgb(7, 193, 96)');
    expect(listIcon?.style.color).toBe('var(--cafe-image-foreground)');
    await act(async () => row?.querySelector('button')?.click());
    await flushEffects();
    const detailIcon = container.querySelector(
      '[data-mobile-panel="detail"] .settings-resource-avatar',
    ) as HTMLElement | null;
    expect(detailIcon?.style.backgroundColor).toBe(listIcon?.style.backgroundColor);
    expect(detailIcon?.style.color).toBe(listIcon?.style.color);
    expect(row?.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed')).toBe('false');
    expect(mockApiFetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('uses Host manifest presentation for official compatibility list and detail without a frontend palette', async () => {
    window.history.replaceState({}, '', '/settings?s=plugins');
    const official = {
      catalogId: 'new-supplier',
      pluginId: 'vendor.new-supplier',
      packageName: '@vendor/new-supplier',
      version: '1.0.0',
      availableVersion: '1.0.0',
      packageDigest: digest,
      ownerAuthAvailable: false,
      updateAvailable: false,
      instance: null,
    };
    const icon = { type: 'svg', src: '/api/plugin-manager/plugins/vendor.new-supplier/icon' } as const;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins') return json({ plugins: [] });
      if (url === '/api/plugins/official') return json({ plugins: [official] });
      if (url === '/api/plugin-manager/plugins')
        return json(
          response({
            ...managerPlugin({ pluginId: official.pluginId, displayName: 'Supplier manifest name' }),
            icon,
            iconBg: '#123abc',
          }),
        );
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const listIcon = container.querySelector(
      '[data-plugin-id="vendor.new-supplier"] [data-plugin-icon]',
    ) as HTMLElement | null;
    expect(listIcon?.querySelector('img')?.getAttribute('src')).toBe(icon.src);
    expect(listIcon?.style.backgroundColor).toBe('rgb(18, 58, 188)');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-plugin-id="vendor.new-supplier"] button')?.click(),
    );
    await flushEffects();
    const detailIcon = container.querySelector('[data-mobile-panel="detail"] [data-plugin-icon]') as HTMLElement | null;
    expect(detailIcon?.querySelector('img')?.getAttribute('src')).toBe(icon.src);
    expect(detailIcon?.style.backgroundColor).toBe(listIcon?.style.backgroundColor);
    expect(mockApiFetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('shows when an owner-provided dependency closure was shipped with the package', async () => {
    const localPlugin = {
      ...managerPlugin({ installed: true }),
      source: {
        kind: 'local-archive',
        fileName: 'video-analysis.tgz',
        packageName: '@clowder-ai/video-analysis',
        trust: 'unverified',
        dependencyClosure: 'shipped',
      },
    } as const;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(localPlugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        return json({
          plugin: {
            ...localPlugin,
            capabilities: localPlugin.capabilitySummary,
            configFields: [],
          },
          catalog: { status: 'fresh', refreshedAt: 1_000 },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/documentation') return json({});
      return json({}, 404);
    });

    await act(async () => root.render(<PluginsContent />));
    await flushEffects();

    expect(container.textContent).toContain('本机自带依赖 · 仅限本机开发');
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

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, expectedRevision: 7 }),
      },
      { mutationTimeoutMs: 5 * 60_000 },
    );
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
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/install',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: { kind: 'catalog', catalogId: 'dev.clowder.video-analysis' },
          expectedVersion: '0.1.0-alpha.0',
          expectedDigest: digest,
        }),
      },
      { mutationTimeoutMs: 600_000 },
    );
  });

  it('updates an installed plugin by version without sending old provenance or digest', async () => {
    const plugin = {
      ...managerPlugin({ installed: true }),
      availableVersion: '0.1.0-alpha.1',
      source: { kind: 'local-archive', packageName: '@clowder-ai/video-analysis', trust: 'unverified' },
      actions: { install: true, setEnabled: false, uninstall: true, blockingReasons: ['package-incompatible'] },
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis')
        return json({ ...detail(), plugin: { ...detail().plugin, ...plugin } });
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis/update')
        return json({ pluginId: plugin.pluginId, pluginInstanceId: 'pi_video' });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.textContent).toContain('有更新');
    const update = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '更新');
    expect(update).toBeDefined();
    await act(async () => update?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/update',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: '0.1.0-alpha.1', expectedRevision: 7 }),
      }),
      expect.anything(),
    );
    expect(container.querySelector('select[aria-label="安装来源"]')).toBeNull();
  });

  it('shows one catalog sync warning and keeps individual errors inside repository settings', async () => {
    const warning = '1 个插件仓库没有同步成功，已保留上次可用的目录。';
    const sourceError = '插件仓同步失败，保留上次可用目录。';
    mockApiFetch.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/plugin-manager/marketplaces'))
        return json({
          sources: [
            {
              id: 'repo',
              url: 'https://example.test/plugins.git',
              origin: 'user',
              status: 'error',
              error: sourceError,
              pluginCount: 1,
            },
          ],
        });
      if (url === '/api/plugin-manager/plugins')
        return json({ ...response(), catalog: { status: 'degraded', message: warning } });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.textContent?.split(warning)).toHaveLength(2);
    expect(container.textContent).not.toContain('1 个插件仓库未同步');
    await act(async () => (container.querySelector('[aria-label="管理插件仓库"]') as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(sourceError);
  });

  it('adds a repository, then installs its plugin through the ordinary Manager button', async () => {
    const gitUrl = 'ssh://git@git.example.test/team/plugins.git';
    const marketplace = {
      sourceId: 'a'.repeat(24),
      commit: 'b'.repeat(40),
      path: 'packages/demo',
      pluginId: 'dev.clowder.video-analysis',
      version: '0.1.0-alpha.0',
    };
    let added = false;
    const source = { kind: 'git', url: gitUrl, trust: 'unverified', marketplace };
    const sources = () => ({
      sources: added
        ? [{ id: marketplace.sourceId, url: gitUrl, origin: 'user', status: 'ready', pluginCount: 1 }]
        : [],
    });
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/marketplaces') {
        if (init?.method === 'POST') added = true;
        return json(sources());
      }
      if (url === '/api/plugin-manager/marketplaces/refresh') return json(sources());
      if (url === '/api/plugin-manager/plugins')
        return json(response(added ? { ...managerPlugin(), source } : managerPlugin()));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      if (url === '/api/plugin-manager/plugins/install')
        return json({ pluginId: marketplace.pluginId, pluginInstanceId: 'pi_example' }, 201);
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.textContent).not.toContain('从 Git 安装');
    expect(container.textContent).not.toContain('离线安装');
    await act(async () => (container.querySelector('[aria-label="管理插件仓库"]') as HTMLButtonElement).click());
    const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    const branchInput = document.querySelector('[aria-label="分支名"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, gitUrl);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(branchInput, 'feature/plugins');
      branchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/marketplaces',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: gitUrl, branch: 'feature/plugins' }) }),
    );
    await act(async () =>
      Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent === '完成')
        ?.click(),
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent === '安装')
        ?.click(),
    );
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/install',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: { kind: 'git', url: gitUrl, marketplace } }),
      }),
      { mutationTimeoutMs: 600_000 },
    );
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/marketplaces/refresh')).toHaveLength(
      1,
    );
  });

  it('preserves the repository input when checking its address fails', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/marketplaces' && init?.method === 'POST')
        return json({ error: '无法访问这个仓库。' }, 422);
      if (String(url).startsWith('/api/plugin-manager/marketplaces')) return json({ sources: [] });
      if (url === '/api/plugin-manager/plugins') return json(response());
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') return json(detail());
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    await act(async () => (container.querySelector('[aria-label="管理插件仓库"]') as HTMLButtonElement).click());
    const input = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'https://git.example.test/missing.git',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await flushEffects();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('无法访问这个仓库。');
    expect(input.value).toBe('https://git.example.test/missing.git');
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

  it('renders an installed plugin configuration through the shared manager boundary', async () => {
    const plugin = connectorPlugin();
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') return json(response(plugin));
      if (url === '/api/plugin-manager/plugins/telegram') return json(connectorDetail());
      if (url === '/api/plugin-manager/plugins/telegram/contributions/configuration' && init?.method === 'POST')
        return json({ ok: true });
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

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/telegram/contributions/configuration',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: plugin.lifecycleRevision,
          updates: [{ key: 'TELEGRAM_BOT_TOKEN', value: '123456:secret' }],
        }),
      },
      { mutationTimeoutMs: 5 * 60_000 },
    );
  });

  it('refreshes saved configuration and revision when reconnect fails, without toggling intent', async () => {
    const plugin = { ...connectorPlugin(), lifecycleRevision: 7, intent: 'enabled' as const, live: 'running' as const };
    let committed = false;
    mockApiFetch.mockImplementation(async (url, init) => {
      const current = committed
        ? { ...plugin, live: 'stopped', lifecycleRevision: plugin.lifecycleRevision + 2 }
        : plugin;
      if (url === '/api/plugin-manager/plugins') return json(response(current));
      if (url === '/api/plugin-manager/plugins/telegram')
        return json({
          ...connectorDetail(),
          plugin: {
            ...connectorDetail().plugin,
            ...current,
            configFields: connectorDetail().plugin.configFields,
          },
        });
      if (url === '/api/plugin-manager/plugins/telegram/contributions/configuration' && init?.method === 'POST') {
        committed = true;
        return json(
          { code: 'RUNTIME_START_FAILED', error: 'Configuration saved, but the plugin could not restart' },
          503,
        );
      }
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    const input = container.querySelector('[data-testid="field-TELEGRAM_BOT_TOKEN"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'changed-token');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = () => {
      const button = Array.from(container.querySelectorAll('button')).find((item) =>
        item.textContent?.includes('保存配置'),
      );
      if (!button) throw new Error('Missing save control');
      return button;
    };
    await act(async () => save().click());
    await flushEffects();
    expect(container.textContent).toContain('Configuration saved, but the plugin could not restart');
    await act(async () => save().click());
    const writes = mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[1][1]?.body)).expectedRevision).toBe(plugin.lifecycleRevision + 2);
    expect(writes.every(([url]) => String(url).endsWith('/configuration'))).toBe(true);
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
      { mutationTimeoutMs: 5 * 60_000 },
    );
    expect(container.textContent).toContain('配置已保存');

    const toggle = container.querySelector('button[aria-label="启用Video Analysis"]') as HTMLButtonElement | null;
    await act(async () => toggle?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/set-enabled',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, expectedRevision: 8 }),
      },
      { mutationTimeoutMs: 5 * 60_000 },
    );
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
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.video-analysis/uninstall',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 7 }),
      },
      { mutationTimeoutMs: 5 * 60_000 },
    );
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
              name: 'video_analysis_execute',
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
    expect(container.textContent).toContain('video_analysis_execute');
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

  it('loads on page open without polling the plugin list in the background', async () => {
    vi.useFakeTimers();
    let listReads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/plugin-manager/marketplaces')) return json({ sources: [] });
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
    expect(listReads).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listReads).toBe(2);
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugin-manager/marketplaces/refresh')).toHaveLength(
      1,
    );
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-plugin-id="dev.clowder.video-analysis"]')).toHaveLength(1);
  });

  it('keeps an unavailable detail state stable without background retries', async () => {
    vi.useFakeTimers();
    let detailReads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json(response(managerPlugin({ installed: true })));
      if (url === '/api/plugin-manager/plugins/dev.clowder.video-analysis') {
        detailReads += 1;
        return json({}, 503);
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

    expect(detailReads).toBe(1);
    expect(container.textContent).toContain('README 暂不可用。');
    expect(container.textContent).not.toContain('README 加载中…');
  });
  it('shows all installed plugins, five available initially, and finds later plugins by scrolling or search', async () => {
    const installed = Array.from({ length: 7 }, (_, i) =>
      managerPlugin({ installed: true, pluginId: `installed.${i}`, displayName: `Installed ${i}` }),
    );
    const available = Array.from({ length: 12 }, (_, i) =>
      managerPlugin({ pluginId: `available.${i}`, displayName: `Available ${i}` }),
    );
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins') return json({ ...response(), plugins: [...installed, ...available] });
      if (String(url).startsWith('/api/plugin-manager/marketplaces')) return json({ sources: [] });
      if (String(url).startsWith('/api/plugin-manager/plugins/')) return json(detail(installed[0]));
      return json({}, 404);
    });
    await act(async () => root.render(<PluginsContent />));
    await flushEffects();
    expect(container.querySelectorAll('[data-plugin-list-row]')).toHaveLength(12);
    expect(container.querySelector('[data-plugin-id="installed.6"]')).not.toBeNull();
    const list = container.querySelector('[data-plugin-scroll-region="list"]') as HTMLDivElement;
    await act(async () => list.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(container.querySelectorAll('[data-plugin-list-row]')).toHaveLength(17);
    const search = container.querySelector('[aria-label="搜索插件"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'Available 11');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-plugin-id="available.11"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-plugin-list-row]')).toHaveLength(1);
    expect(container.querySelector('a[href="/docs/plugin-development.md"]')).not.toBeNull();
  });
});
