import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../../../hub-cat-editor.model';
import { PluginAgentClientPicker } from '../../../PluginAgentClientPicker';
import { MemberRuntimeFields } from '../../members/MemberRuntimeFields';
import { PluginManagerConfigurationSection } from '../PluginManagerConfigurationSection';
import { PLUGIN_MANAGER_DESIGN_FIXTURES } from '../plugin-manager-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const diagnostic = 'ACP 客户端配置无效：Package-local commands are forbidden';
const otherDiagnostic = '另一个插件的独立配置错误';
const rawConfig = JSON.stringify([{ id: 'bad', name: 'Bad', command: './bundled-agent', startupArgs: [] }]);
let broken = true;
let host: HTMLDivElement;
let root: Root;
const change = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  broken = true;
  change.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).startsWith('/api/cats/native-runtimes')
            ? { runtimes: [] }
            : {
                libraries: [
                  {
                    pluginId: 'official.acp-clients',
                    configurationKey: 'clients',
                    clients: [],
                    ...(broken ? { error: diagnostic } : {}),
                  },
                  {
                    pluginId: 'local.healthy',
                    configurationKey: 'clients',
                    clients: [{ id: 'ok', name: 'Healthy client', ref: 'plugin:local.healthy/ok', available: true }],
                  },
                  { pluginId: 'local.other', configurationKey: 'clients', clients: [], error: otherDiagnostic },
                ],
              },
        ),
      ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(apiFetch).mockReset();
  vi.unstubAllGlobals();
});
const form = () => ({
  ...initialState(),
  clientId: 'acp' as const,
  carrier: 'acp' as const,
  acpAgentProvider: 'plugin:official.acp-clients/bad',
});
async function render(surface: 'plugin' | 'picker' | 'member') {
  await act(async () => {
    root.render(
      surface === 'plugin' ? (
        <PluginManagerConfigurationSection
          plugin={{
            ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
            id: 'official.acp-clients',
            artifact: 'installed',
            configFields: [
              {
                key: 'clients',
                label: 'Clients',
                kind: 'string',
                required: false,
                sensitive: false,
                currentValue: rawConfig,
              },
            ],
          }}
          busy={false}
          onSaveConfig={change}
          validationRequest={0}
          saved={false}
        />
      ) : surface === 'picker' ? (
        <PluginAgentClientPicker form={form()} onChange={change} />
      ) : (
        <MemberRuntimeFields
          form={form()}
          accounts={[]}
          patch={change}
          t={(zh) => zh}
          accountHref="/settings"
          editing
        />
      ),
    );
  });
}
for (const surface of ['plugin', 'picker', 'member'] as const) {
  it(`${surface} exposes the server library diagnostic without erasing configuration or healthy choices`, async () => {
    await render(surface);
    expect([...host.querySelectorAll('[role="alert"]')].some((node) => node.textContent?.includes(diagnostic))).toBe(
      true,
    );
    if (surface === 'plugin') {
      expect(host.textContent).not.toContain(otherDiagnostic);
      expect(host.querySelector<HTMLInputElement>('[aria-label="客户端 1 命令"]')?.value).toBe('./bundled-agent');
    } else {
      expect(host.textContent).toContain('official.acp-clients');
      expect(
        [...host.querySelectorAll('option')].some(
          (option) => option.textContent?.includes('Healthy client') && !option.disabled,
        ),
      ).toBe(true);
    }
    expect(change).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    broken = false;
    await render(surface);
    expect(host.textContent).not.toContain(diagnostic);
    expect(change).not.toHaveBeenCalled();
  });
}
