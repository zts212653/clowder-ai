import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const mockApiFetch = vi.mocked(apiFetch);
const basePlugin = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  id: 'dev.clowder.fixture',
  setupSteps: ['legacy step'],
  steps: ['Install fixture', 'Authorize fixture'],
  testable: true,
  configFields: [],
};

async function flushEffects() {
  await act(async () => Promise.resolve());
}

describe('Plugin Manager test connection', () => {
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

  async function render(plugin: PluginManagerDesignFixture = basePlugin) {
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection plugin={plugin} busy={false} validationRequest={0} saved={false} />,
      ),
    );
  }

  function testButton() {
    return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '测试连接');
  }

  it('prefers package steps and shows a successful test result', async () => {
    mockApiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, message: 'Connection healthy' })));
    await render();

    expect(container.textContent).toContain('Install fixture');
    expect(container.textContent).toContain('Authorize fixture');
    expect(container.textContent).not.toContain('legacy step');
    await act(async () => testButton()?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/dev.clowder.fixture/test', { method: 'POST' });
    expect(container.textContent).toContain('Connection healthy');
    expect(container.querySelector('.bg-conn-emerald-bg')).not.toBeNull();
  });

  it('shows declared and HTTP test failures without rewriting their message', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, message: 'Credentials rejected' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Handler returned an invalid result' }), { status: 502 }),
      );
    await render();
    await act(async () => testButton()?.click());
    await flushEffects();
    expect(container.textContent).toContain('Credentials rejected');

    await act(async () => testButton()?.click());
    await flushEffects();
    expect(container.textContent).toContain('Handler returned an invalid result');
  });

  it('hides the test action when the manifest does not declare one', async () => {
    const withoutTest: PluginManagerDesignFixture = { ...basePlugin };
    delete withoutTest.testable;
    await render(withoutTest);
    expect(testButton()).toBeUndefined();
  });
});
