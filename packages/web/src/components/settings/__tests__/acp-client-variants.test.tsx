import type { PluginManagerConfigField } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginManagerConfigurationSection } from '../plugin-manager/PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager/plugin-manager-fixtures';

const pluginId = 'dev.clowder.acp-variants';
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useAgentClientLibraries', () => ({
  useAgentClientLibraries: () => ({
    libraries: [{ pluginId: 'dev.clowder.acp-variants', configurationKey: 'clients', clients: [] }],
  }),
}));

const codeagent = {
  id: 'enterprise-codeagent',
  name: 'CodeAgent',
  command: 'codeagent',
  startupArgs: ['--acp', '--permission-mode', 'bypassPermission', '--allow-dangerously-skip-permissions'],
};
const variants: NonNullable<PluginManagerConfigField['configurationVariants']> = {
  discriminator: 'mode',
  branches: [
    { id: 'acp', when: { properties: { mode: { const: 'acp' } } }, fields: ['clients'] },
    { id: 'other', when: { properties: { mode: { const: 'other' } } }, fields: [] },
  ],
};
const field = (
  key: string,
  rest: Pick<PluginManagerConfigField, 'kind'> & Partial<PluginManagerConfigField>,
): PluginManagerConfigField => ({
  key,
  label: key,
  required: false,
  sensitive: false,
  currentValue: null,
  configurationVariants: variants,
  ...rest,
});

async function withForm(
  clients: string,
  check: (container: HTMLDivElement, onSave: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSave = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PluginManagerConfigurationSection
          plugin={{
            ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
            id: pluginId,
            config: 'incomplete',
            setupSteps: undefined,
            configFields: [
              field('mode', {
                kind: 'select',
                currentValue: 'acp',
                required: true,
                options: [
                  { value: 'acp', label: 'ACP' },
                  { value: 'other', label: 'Other' },
                ],
              }),
              field('clients', { kind: 'string', currentValue: clients }),
              field('name', { kind: 'string' }),
            ],
          }}
          busy={false}
          saved={false}
          validationRequest={0}
          onSaveConfig={onSave}
        />,
      ),
    );
    await check(container, onSave);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.mocked(apiFetch).mockReset();
  }
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(container: HTMLDivElement, text: string) {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('blocks saving an active ACP branch with an invalid client command', async () => {
  await withForm(JSON.stringify([{ ...codeagent, command: '' }]), async (container, onSave) => {
    await change(container.querySelector<HTMLInputElement>('[data-testid="field-name"]')!, 'changed');
    await click(container, '保存配置');
    expect(onSave).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请填写每个客户端的名称和启动命令。');
  });
});

it('does not validate or submit ACP clients after switching to another variant', async () => {
  await withForm(JSON.stringify([{ ...codeagent, command: '' }]), async (container, onSave) => {
    await change(container.querySelector<HTMLSelectElement>('[data-testid="field-mode"]')!, 'other');
    expect(container.querySelector('[aria-label="客户端 1 命令"]')).toBeNull();
    await click(container, '保存配置');
    expect(onSave).toHaveBeenCalledExactlyOnceWith([{ key: 'mode', value: 'other' }]);
  });
});

it('checks and adopts a bootstrap directory while preserving CodeAgent identity and launch arguments', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, root: 'D:/ACP/private', trustMode: 'trusted-host' }),
  } as Response);
  await withForm(JSON.stringify([codeagent]), async (container, onSave) => {
    await click(container, '检查引导目录');
    expect(apiFetch).toHaveBeenCalledWith('/api/agent-providers/bootstrap-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(container.textContent).toContain('兼容模式检查通过');
    await click(container, '使用此目录');
    await click(container, '保存配置');
    expect(onSave).toHaveBeenCalledExactlyOnceWith([
      { key: 'clients', value: JSON.stringify([{ ...codeagent, bootstrapRoot: 'D:/ACP/private' }]) },
    ]);
  });
});
