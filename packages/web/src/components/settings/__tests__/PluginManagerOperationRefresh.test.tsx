import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => async () => true,
  useOptionalConfirm: () => async () => true,
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerLiveContent } from '../plugin-manager/PluginManagerLiveContent';

const mockApiFetch = vi.mocked(apiFetch);
const plugin = {
  pluginId: 'dev.clowder.fixture',
  pluginInstanceId: 'pi_fixture',
  displayName: 'Fixture',
  source: { kind: 'catalog' as const, catalogId: 'fixture', trust: 'official' as const },
  availableVersion: '1.0.0',
  installedVersion: '1.0.0',
  packageDigest: 'sha512-fixture',
  artifact: 'installed' as const,
  config: 'ready' as const,
  auth: 'not-required' as const,
  intent: 'enabled' as const,
  live: 'stopped' as const,
  lifecycleRevision: 1,
  capabilitySummary: [],
  actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('Plugin Manager operation refresh', () => {
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
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('keeps Repair on the failed row, Update in its detail, and refreshes after repair', async () => {
    let repaired = false;
    mockApiFetch.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/repair')) {
        expect(JSON.parse(String(options?.body))).toEqual({ expectedRevision: 1 });
        repaired = true;
        return json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId });
      }
      if (String(path).includes('marketplaces')) return json({ sources: [] });
      const current = {
        ...plugin,
        availableVersion: '1.1.0',
        live: repaired ? 'running' : 'crashed',
        actions: { ...plugin.actions, install: true, repair: !repaired },
      };
      return String(path).includes(plugin.pluginId)
        ? json({ plugin: { ...current, capabilities: [], configFields: [] }, catalog: { status: 'fresh' } })
        : json({ plugins: [current], catalog: { status: 'fresh' } });
    });
    await act(async () => root.render(<PluginManagerLiveContent presentation="v2" />));
    await flushEffects();
    const row = container.querySelector(`[data-plugin-id="${plugin.pluginId}"]`);
    const buttons = () => [...(row?.querySelectorAll('button') ?? [])];
    expect(buttons().some((button) => button.textContent === '更新')).toBe(false);
    expect(container.querySelector('[data-plugin-detail-action="update"]')?.textContent).toBe('更新到 1.1.0');
    const repair = buttons().find((button) => button.textContent === '修复');
    expect(repair).toBeDefined();
    await act(async () => repair?.click());
    await flushEffects();
    expect(repaired).toBe(true);
    expect(container.textContent).not.toContain('修复');
    expect(mockApiFetch.mock.calls.some(([path]) => String(path).endsWith('/repair'))).toBe(true);
  });

  it('opens the requested package from a recovery settings link instead of selecting the first item', async () => {
    window.history.replaceState(null, '', '/settings?s=plugins&plugin=official.companion.personal-chrome');
    const companion = { ...plugin, pluginId: 'official.companion.personal-chrome', displayName: 'Companion' };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins')
        return json({ plugins: [plugin, companion], catalog: { status: 'fresh', refreshedAt: 1 } });
      if (url.endsWith('/documentation')) return json({});
      if (url === '/api/plugin-manager/plugins/official.companion.personal-chrome')
        return json({
          plugin: { ...companion, configFields: [], capabilities: [], steps: ['Companion setup'], testable: false },
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      return json({}, 404);
    });
    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    expect(container.textContent).toContain('Companion setup');
    const detailPanel = container.querySelector('[data-mobile-panel="detail"]');
    expect(detailPanel?.classList.contains('hidden')).toBe(false);
    const back = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('返回插件列表'),
    );
    await act(async () => back?.click());
    await flushEffects();
    expect(detailPanel?.classList.contains('hidden')).toBe(true);
  });

  it('reloads detail after an operation advances using GET invalidation ordering', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins') {
        return json({ plugins: [plugin], catalog: { status: 'fresh', refreshedAt: 1 } });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/documentation') return json({});
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture') {
        return json({
          plugin: {
            ...plugin,
            capabilities: [],
            steps: ['Package step'],
            testable: true,
            configFields: [
              {
                kind: 'operation',
                key: 'connect',
                label: 'Connect',
                required: false,
                currentValue: null,
                sensitive: false,
                actions: [
                  { id: 'start', label: 'Start', render: 'button', next: 'connected' },
                  { id: 'connected', label: 'Connected', render: 'status' },
                ],
              },
            ],
          },
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      }
      if (url === '/api/plugins/dev.clowder.fixture/actions/connect/start' && init?.method === 'POST') {
        return json({ ok: true, render: 'status', data: {}, label: 'Started' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    expect(container.textContent).toContain('Package step');
    expect(container.textContent).toContain('测试连接');
    const action = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Start');
    expect(action).toBeDefined();
    await act(async () => action?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/dev.clowder.fixture', undefined, {
      afterCurrentGet: true,
    });
  });

  it('reloads local operation detail without waiting for remote hydration', async () => {
    const remote = deferred<Response>();
    let localDetails = 0;
    let canonicalDetails = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({ plugins: [plugin], catalog: { status: 'loading', refreshedAt: null } });
      }
      if (url === '/api/plugin-manager/plugins') return remote.promise;
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/documentation') return json({});
      if (url === '/api/plugin-manager/plugins/_local/dev.clowder.fixture') {
        localDetails += 1;
        return json({
          plugin: {
            ...plugin,
            capabilities: [],
            steps: ['Local package step'],
            testable: true,
            configFields: [
              {
                kind: 'operation',
                key: 'connect',
                label: 'Connect',
                required: false,
                currentValue: null,
                sensitive: false,
                actions: [
                  { id: 'start', label: 'Start', render: 'button', next: 'connected' },
                  { id: 'connected', label: 'Connected', render: 'status' },
                ],
              },
            ],
          },
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture') {
        canonicalDetails += 1;
        return new Promise<Response>(() => {});
      }
      if (url === '/api/plugins/dev.clowder.fixture/actions/connect/start' && init?.method === 'POST') {
        return json({ ok: true, render: 'status', data: {}, label: 'Started' });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    const action = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Start');
    expect(action).toBeDefined();
    await act(async () => action?.click());
    await flushEffects();

    expect(localDetails).toBeGreaterThanOrEqual(2);
    expect(canonicalDetails).toBe(0);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugin-manager/plugins/_local/dev.clowder.fixture', undefined, {
      afterCurrentGet: true,
    });
  });

  it('keeps a slow enable operation attached until success and renders its terminal state', async () => {
    const lifecycle = deferred<Response>();
    let terminal = false;
    mockApiFetch.mockImplementation(async (url, init, options) => {
      if (url === '/api/plugin-manager/plugins') {
        return json({
          plugins: [terminal ? { ...plugin, intent: 'disabled', live: 'stopped', lifecycleRevision: 2 } : plugin],
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled' && init?.method === 'POST') {
        if (options?.mutationTimeoutMs !== 5 * 60_000) throw new Error('client deadline elapsed');
        return lifecycle.promise;
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="禁用Fixture"]') as HTMLButtonElement | null;
    await act(async () => toggle?.click());
    await flushEffects();

    terminal = true;
    lifecycle.resolve(json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId }));
    await flushEffects();

    expect(container.querySelector('button[aria-label="启用Fixture"]')).not.toBeNull();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled',
      expect.objectContaining({ method: 'POST' }),
      { mutationTimeoutMs: 5 * 60_000 },
    );
  });

  it('keeps a slow enable operation attached until failure and renders its terminal state', async () => {
    const lifecycle = deferred<Response>();
    let terminal = false;
    mockApiFetch.mockImplementation(async (url, init, options) => {
      if (url === '/api/plugin-manager/plugins') {
        return json({
          plugins: [terminal ? { ...plugin, intent: 'disabled', live: 'crashed', lifecycleRevision: 2 } : plugin],
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled' && init?.method === 'POST') {
        if (options?.mutationTimeoutMs !== 5 * 60_000) throw new Error('client deadline elapsed');
        return lifecycle.promise;
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="禁用Fixture"]') as HTMLButtonElement | null;
    await act(async () => toggle?.click());
    await flushEffects();

    terminal = true;
    lifecycle.resolve(json({ error: 'Plugin activation failed.' }, 500));
    await flushEffects();

    expect(container.querySelector('button[aria-label="启用Fixture"]')).not.toBeNull();
    expect(container.textContent).toContain('Plugin activation failed.');
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled',
      expect.objectContaining({ method: 'POST' }),
      { mutationTimeoutMs: 5 * 60_000 },
    );
  });

  it.each(['pending', 'rejected'])('finishes local disable while remote hydration is %s', async (remoteState) => {
    const remote = deferred<Response>();
    let disabled = false;
    let writes = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({
          plugins: [disabled ? { ...plugin, intent: 'disabled', lifecycleRevision: 2 } : plugin],
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins') return remote.promise;
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled' && init?.method === 'POST') {
        writes += 1;
        disabled = true;
        return json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="禁用Fixture"]') as HTMLButtonElement | null;
    expect(toggle?.disabled).toBe(false);
    await act(async () => toggle?.click());
    await flushEffects();

    const enabled = container.querySelector('button[aria-label="启用Fixture"]') as HTMLButtonElement | null;
    expect(writes).toBe(1);
    expect(enabled).not.toBeNull();
    expect(enabled?.disabled).toBe(false);
    if (remoteState === 'rejected') {
      remote.reject(new Error('offline'));
      await flushEffects();
      expect(container.textContent).toContain('目录暂时不可用');
    }
  });

  it('sends a local enable request even when remote hydration rejects', async () => {
    const remote = deferred<Response>();
    const disabledPlugin = { ...plugin, intent: 'disabled' as const, lifecycleRevision: 2 };
    let enabled = false;
    let writes = 0;
    let localReads = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        localReads += 1;
        const localStates = [
          { ...disabledPlugin, actions: { ...disabledPlugin.actions, setEnabled: false } },
          disabledPlugin,
        ];
        const current = enabled ? { ...plugin, lifecycleRevision: 3 } : localStates[Math.min(localReads - 1, 1)];
        return json({
          plugins: [current],
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins') return remote.promise;
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/set-enabled' && init?.method === 'POST') {
        writes += 1;
        enabled = true;
        return json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    remote.reject(new Error('offline'));
    await flushEffects();
    const toggle = container.querySelector('button[aria-label="启用Fixture"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    await flushEffects();
    expect(writes).toBe(1);
    expect(container.querySelector('button[aria-label="禁用Fixture"]')).not.toBeNull();
  });

  it('keeps installed detail local when a filtered local search omits the row', async () => {
    const initialRemote = deferred<Response>();
    const canonicalPlugin = { ...plugin, publisher: 'Clowder AI' };
    let localDetails = 0;
    let canonicalDetails = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({ plugins: [plugin], catalog: { status: 'loading', refreshedAt: null } });
      }
      if (url === '/api/plugin-manager/plugins') return initialRemote.promise;
      if (url === '/api/plugin-manager/plugins/_local/search?q=Clowder%20AI') {
        return json({ plugins: [], catalog: { status: 'loading', refreshedAt: null } });
      }
      if (url === '/api/plugin-manager/plugins/search?q=Clowder%20AI') {
        return json({ plugins: [canonicalPlugin], catalog: { status: 'fresh', refreshedAt: 1 } });
      }
      if (url === '/api/plugin-manager/plugins/_local/dev.clowder.fixture') {
        localDetails += 1;
        return json({
          plugin: { ...canonicalPlugin, capabilities: [], configFields: [] },
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture') {
        canonicalDetails += 1;
        return new Promise<Response>(() => {});
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();

    const search = container.querySelector('input[aria-label="搜索插件"]') as HTMLInputElement | null;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(search, 'Clowder AI');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushEffects();

    expect(localDetails).toBeGreaterThanOrEqual(2);
    expect(canonicalDetails).toBe(0);
  });

  it('returns an uninstalled marketplace candidate to canonical detail without remounting', async () => {
    const marketplace = {
      sourceId: 'a'.repeat(24),
      commit: 'b'.repeat(40),
      path: 'packages/fixture',
      pluginId: plugin.pluginId,
      version: '1.0.0',
    };
    const source = {
      kind: 'git' as const,
      url: 'https://example.test/plugins.git',
      trust: 'unverified' as const,
      marketplace,
    };
    const installed = { ...plugin, source };
    const candidate = {
      ...installed,
      pluginInstanceId: null,
      installedVersion: null,
      artifact: 'absent' as const,
      intent: 'disabled' as const,
      lifecycleRevision: null,
      actions: { install: true, setEnabled: false, uninstall: false, blockingReasons: [] },
    };
    let isInstalled = true;
    let localDetails = 0;
    let canonicalDetails = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugin-manager/plugins/_local') {
        return json({
          plugins: isInstalled ? [installed] : [],
          catalog: { status: 'loading', refreshedAt: null },
        });
      }
      if (url === '/api/plugin-manager/plugins') {
        return json({
          plugins: [isInstalled ? installed : candidate],
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      }
      if (url === '/api/plugin-manager/plugins/_local/dev.clowder.fixture') {
        localDetails += 1;
        return isInstalled
          ? json({
              plugin: { ...installed, capabilities: [], configFields: [] },
              catalog: { status: 'loading', refreshedAt: null },
            })
          : json({}, 404);
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture') {
        canonicalDetails += 1;
        return json({
          plugin: { ...candidate, capabilities: [], configFields: [] },
          catalog: { status: 'fresh', refreshedAt: 1 },
        });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/documentation') {
        return json({ readmeMarkdown: isInstalled ? '# Installed README' : '# Marketplace README' });
      }
      if (url === '/api/plugin-manager/plugins/dev.clowder.fixture/uninstall' && init?.method === 'POST') {
        isInstalled = false;
        return json({ pluginId: plugin.pluginId, pluginInstanceId: plugin.pluginInstanceId });
      }
      return json({}, 404);
    });

    await act(async () => root.render(<PluginManagerLiveContent />));
    await flushEffects();
    expect(container.textContent).toContain('Installed README');

    const uninstall = container.querySelector('button[aria-label="卸载Fixture"]') as HTMLButtonElement | null;
    expect(uninstall).not.toBeNull();
    await act(async () => uninstall?.click());
    await flushEffects();

    expect(container.textContent).toContain('Marketplace README');
    expect(localDetails).toBeGreaterThan(0);
    expect(canonicalDetails).toBeGreaterThan(0);
  });
});
