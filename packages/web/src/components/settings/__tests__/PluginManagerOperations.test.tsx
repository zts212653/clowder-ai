import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

const mockApiFetch = vi.mocked(apiFetch);
const plugin = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  id: 'dev.clowder.fixture',
  config: 'incomplete' as const,
  setupSteps: undefined,
  configFields: [
    {
      kind: 'string' as const,
      key: 'account',
      label: 'Account',
      required: false,
      currentValue: null,
      sensitive: false,
    },
    {
      kind: 'operation' as const,
      key: 'qr_login',
      label: 'QR login',
      required: true,
      currentValue: null,
      sensitive: false,
      actions: [
        { id: 'generate', label: 'Generate QR', render: 'button' as const, next: 'connected' },
        { id: 'connected', label: 'Connected', render: 'status' as const },
      ],
    },
  ],
};

async function flushEffects() {
  await act(async () => Promise.resolve());
}

describe('Plugin Manager operation fields', () => {
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

  it('keeps a persisted disconnect action reachable when operation targets are configured', async () => {
    const operation = {
      kind: 'operation' as const,
      key: 'qr_login',
      label: 'QR login',
      required: false,
      currentValue: null,
      sensitive: false,
      configured: true,
      operationState: { currentAction: 'disconnect' },
      actions: [
        { id: 'generate', label: 'Generate QR', render: 'button' as const, next: 'disconnect' },
        { id: 'disconnect', label: 'Disconnect', render: 'button' as const, next: 'generate' },
      ],
    };
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{ ...plugin, configFields: [operation] }}
          busy={false}
          validationRequest={0}
          saved
        />,
      ),
    );
    await flushEffects();
    expect(container.querySelector('[data-testid="dev.clowder.fixture-connected"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dev.clowder.fixture-disconnect"]')).not.toBeNull();

    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{ ...plugin, configFields: [{ ...operation, configured: false }] }}
          busy={false}
          validationRequest={0}
          saved
        />,
      ),
    );
    await flushEffects();
    expect(container.querySelector('[data-testid="dev.clowder.fixture-connected"]')).toBeNull();
    expect(container.querySelector('[data-testid="dev.clowder.fixture-action-generate"]')).not.toBeNull();
  });

  it('renders an operation action, sends flat drafts, and refreshes its detail', async () => {
    const onOperationChange = vi.fn();
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, render: 'img', data: { url: 'https://example.com/qr.png' } })),
    );
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={plugin}
          busy={false}
          validationRequest={0}
          saved={false}
          onOperationChange={onOperationChange}
        />,
      ),
    );

    expect(container.querySelector('[data-testid="field-qr_login"]')).toBeNull();
    const account = container.querySelector('[data-testid="field-account"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(account, 'alice');
      account.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const action = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Generate QR'),
    );
    await act(async () => action?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/dev.clowder.fixture/actions/qr_login/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'alice' }),
    });
    expect(container.querySelector('[data-testid="dev.clowder.fixture-qr-image"]')).not.toBeNull();
    expect(onOperationChange).toHaveBeenCalledOnce();
  });

  it('excludes required operations from validation and saved updates', async () => {
    const onSaveConfig = vi.fn();
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={plugin}
          busy={false}
          validationRequest={0}
          saved={false}
          onSaveConfig={onSaveConfig}
        />,
      ),
    );
    const account = container.querySelector('[data-testid="field-account"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(account, 'alice');
      account.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存配置');
    await act(async () => save?.click());

    expect(container.textContent).not.toContain('请填写 QR login');
    expect(onSaveConfig).toHaveBeenCalledWith([{ key: 'account', value: 'alice' }]);
  });

  it('hides internal fields and validates conditional requirements against unsaved selector values', async () => {
    const onSaveConfig = vi.fn();
    const conditionalPlugin = {
      ...plugin,
      configFields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'select' as const,
          required: false,
          default: 'webhook',
          options: [
            { value: 'webhook', label: 'Webhook' },
            { value: 'polling', label: 'Polling' },
          ],
          currentValue: null,
          sensitive: false,
        },
        {
          key: 'internal',
          label: 'Internal',
          kind: 'string' as const,
          required: false,
          hidden: true,
          currentValue: 'preserve-me',
          sensitive: false,
        },
        {
          key: 'token',
          label: 'Token',
          kind: 'string' as const,
          required: true,
          requiredWhen: { key: 'mode', value: ['webhook', 'hybrid'] },
          currentValue: null,
          sensitive: false,
        },
      ],
    };
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={conditionalPlugin}
          busy={false}
          validationRequest={0}
          saved={false}
          onSaveConfig={onSaveConfig}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="field-internal"]')).toBeNull();
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存配置');
    await act(async () => save?.click());
    expect(container.textContent).toContain('请填写 Token');
    expect(onSaveConfig).not.toHaveBeenCalled();

    const mode = container.querySelector('[data-testid="field-mode"]') as HTMLSelectElement;
    await act(async () => {
      mode.value = 'polling';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => save?.click());
    expect(container.textContent).not.toContain('请填写 Token');
    expect(onSaveConfig).toHaveBeenCalledWith([{ key: 'mode', value: 'polling' }]);
  });

  it('uses the Host condition result when its selector is a masked stored secret', async () => {
    const onSaveConfig = vi.fn();
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{
            ...plugin,
            configFields: [
              {
                key: 'selector',
                label: 'Selector',
                kind: 'secret',
                required: false,
                currentValue: '••••••',
                sensitive: true,
              },
              {
                key: 'detail',
                label: 'Detail',
                kind: 'string',
                required: false,
                requiredWhen: { key: 'selector', value: 'enable' },
                requiredNow: true,
                currentValue: null,
                sensitive: false,
              },
            ],
          }}
          busy={false}
          validationRequest={0}
          saved={false}
          onSaveConfig={onSaveConfig}
        />,
      ),
    );
    const save = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存配置');
    await act(async () => save?.click());
    expect(container.textContent).toContain('请填写 Detail');
    expect(onSaveConfig).not.toHaveBeenCalled();
  });
});
