import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
// Operation HTTP responses are one-shot bodies; library discovery has its own
// real-hook diagnostic suite and must not consume this operation-only fixture.
vi.mock('@/hooks/useAgentClientLibraries', () => ({
  useAgentClientLibraries: () => ({ libraries: [], loading: false, error: '' }),
}));

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

  it.each([
    'v1',
    'v2',
  ] as const)('keeps instructions, inputs and operations in declared configuration order (%s)', async (presentation) => {
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{
            ...plugin,
            steps: ['Read before configuring'],
            configFields: [
              plugin.configFields[0],
              plugin.configFields[1],
              { ...plugin.configFields[0], key: 'after', label: 'After action' },
            ],
          }}
          busy={false}
          saved={false}
          validationRequest={0}
          presentation={presentation}
          beforeConfiguration={<p>Introduction</p>}
        />,
      ),
    );
    const before = container.querySelector('input');
    const action = container.querySelector('[data-testid="dev.clowder.fixture-action-generate"]');
    const after = container.querySelectorAll('input')[1];
    if (!before || !action || !after) throw new Error('Expected inputs and action');
    expect(before.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((container.textContent ?? '').indexOf('Read before configuring')).toBeLessThan(
      (container.textContent ?? '').indexOf('Generate QR'),
    );
  });

  it('expires test success and invalidates in-flight results after a configuration change', async () => {
    vi.useFakeTimers();
    try {
      let resolveTest!: (value: Response) => void;
      mockApiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      const render = async (config: 'ready' | 'incomplete') => {
        await act(async () =>
          root.render(
            <PluginManagerConfigurationSection
              plugin={{ ...plugin, config, testable: true }}
              busy={false}
              saved={false}
              validationRequest={0}
            />,
          ),
        );
      };
      const test = () => {
        const button = Array.from(container.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('测试连接'),
        );
        if (!button) throw new Error('Missing test connection button');
        return button;
      };
      await render('ready');
      await act(async () => test().click());
      expect(container.textContent).toContain('连接测试成功');
      await act(async () => vi.advanceTimersByTime(5000));
      expect(container.textContent).not.toContain('连接测试成功');
      mockApiFetch.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTest = resolve;
          }),
      );
      await act(async () => test().click());
      await render('incomplete');
      expect(mockApiFetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
      await act(async () => resolveTest(new Response(JSON.stringify({ ok: true }))));
      expect(container.textContent).not.toContain('连接测试成功');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears test success when an owner operation changes connection state', async () => {
    mockApiFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true, render: 'status', data: {} })));
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{ ...plugin, testable: true }}
          busy={false}
          saved={false}
          validationRequest={0}
        />,
      ),
    );
    const test = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('测试连接'));
    await act(async () => test?.click());
    expect(container.textContent).toContain('连接测试成功');
    const action = container.querySelector<HTMLButtonElement>('[data-testid="dev.clowder.fixture-action-generate"]');
    await act(async () => action?.click());
    expect(container.textContent).not.toContain('连接测试成功');
  });

  it.each([
    'v1',
    'v2',
  ] as const)('refreshes rows after enable without clearing configuration drafts (%s)', async (presentation) => {
    let enabled = false;
    mockApiFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify(
            enabled
              ? { ok: true, render: 'rows', data: { rows: [], empty: 'No held operations' } }
              : { error: 'Plugin is not enabled' },
          ),
          { status: enabled ? 200 : 409 },
        ),
    );
    const fields = [
      plugin.configFields[0],
      {
        kind: 'operation' as const,
        key: 'recovery',
        label: 'Recovery',
        required: false,
        currentValue: null,
        sensitive: false,
        actions: [{ id: 'list', label: 'Held operations', render: 'button' as const, resultRender: 'rows' as const }],
      },
    ];
    const render = async () => {
      await act(async () =>
        root.render(
          <PluginManagerConfigurationSection
            plugin={{
              ...plugin,
              intent: enabled ? 'enabled' : 'disabled',
              live: enabled ? 'running' : 'stopped',
              configFields: fields,
            }}
            busy={false}
            validationRequest={0}
            saved={false}
            presentation={presentation}
            beforeConfiguration={<p>Introduction</p>}
          />,
        ),
      );
      await flushEffects();
    };
    await render();
    expect(container.textContent).toContain('Plugin is not enabled');
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'unsaved account');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    enabled = true;
    await render();
    expect(container.textContent).toContain('No held operations');
    expect(container.textContent).not.toContain('Plugin is not enabled');
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('unsaved account');
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    await render();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
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
    expect(container.querySelector('[data-testid="dev.clowder.fixture-action-image"]')).not.toBeNull();
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
