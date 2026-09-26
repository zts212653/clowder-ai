import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn() }));
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
});
