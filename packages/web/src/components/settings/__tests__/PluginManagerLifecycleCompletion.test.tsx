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
const listPath = '/api/plugin-manager/plugins';
const pluginPath = `${listPath}/dev.clowder.fixture`;
const plugin = {
  pluginId: 'dev.clowder.fixture',
  pluginInstanceId: 'pi_fixture',
  displayName: 'Fixture',
  source: { kind: 'catalog', catalogId: 'fixture', trust: 'official' },
  availableVersion: '1.0.0',
  installedVersion: '1.0.0',
  packageDigest: 'sha512-fixture',
  artifact: 'installed',
  config: 'ready',
  auth: 'not-required',
  intent: 'enabled',
  live: 'starting',
  lifecycleRevision: 1,
  capabilitySummary: [],
  actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('Plugin Manager lifecycle completion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let terminal: boolean;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    terminal = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function read(url: string, uninstalled = false) {
    const current = terminal ? { ...plugin, live: 'running', lifecycleRevision: 2 } : plugin;
    const catalog = { status: 'fresh', refreshedAt: 1 };
    if (url === listPath) return json({ plugins: terminal && uninstalled ? [] : [current], catalog });
    if (url === pluginPath) {
      return json({
        plugin: {
          ...current,
          capabilities: [],
          configFields: [{ key: 'name', label: 'Name', kind: 'text', currentValue: 'old', required: false }],
        },
        catalog,
      });
    }
    return json({}, 404);
  }

  async function save() {
    const input = container.querySelector('[data-testid="field-name"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'changed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('保存配置'),
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  }

  it.each([
    { operation: 'configuration', status: 200 },
    { operation: 'configuration', status: 503 },
    { operation: 'uninstall', status: 200 },
  ])('waits beyond 30 seconds for $operation ($status), then refreshes the terminal state', async ({
    operation,
    status,
  }) => {
    const path = `${pluginPath}/${operation === 'configuration' ? 'contributions/configuration' : 'uninstall'}`;
    mockApiFetch.mockImplementation(async (url, init, options) => {
      if (url !== path || init?.method !== 'POST') return read(url, operation === 'uninstall');
      return new Promise<Response>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error('client deadline elapsed')),
          options?.mutationTimeoutMs ?? 30_000,
        );
        setTimeout(() => {
          terminal = true;
          clearTimeout(deadline);
          resolve(
            json(status === 200 ? { ok: true } : { error: 'Restart failed after configuration was saved' }, status),
          );
        }, 45_000);
      });
    });
    await act(async () => root.render(<PluginManagerLiveContent />));
    if (operation === 'configuration') await save();
    else {
      const button = container.querySelector('button[aria-label="卸载Fixture"]') as HTMLButtonElement;
      expect(button).not.toBeNull();
      await act(async () => button.click());
    }
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(container.textContent).not.toMatch(/尚未确认|未能确认/);
    expect(mockApiFetch.mock.calls.filter(([url]) => url === listPath)).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(14_000));
    expect(mockApiFetch).toHaveBeenCalledWith(listPath, undefined, { afterCurrentGet: true });
    if (operation === 'uninstall') expect(container.querySelector('button[aria-label="卸载Fixture"]')).toBeNull();
    else if (status === 200) expect(container.textContent).toContain('配置已保存');
    else expect(container.textContent).toContain('Restart failed after configuration was saved');
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('refreshes after a lost configuration response without claiming success or repeating the write', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (init?.method !== 'POST') return read(url);
      terminal = true;
      throw new Error('connection lost after commit');
    });
    await act(async () => root.render(<PluginManagerLiveContent />));
    await save();
    expect(mockApiFetch).toHaveBeenCalledWith(listPath, undefined, { afterCurrentGet: true });
    expect(mockApiFetch).toHaveBeenCalledWith(pluginPath, undefined, { afterCurrentGet: true });
    expect(container.textContent).toContain('未能确认配置保存结果');
    expect(container.textContent).not.toContain('配置已保存');
    expect(mockApiFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
