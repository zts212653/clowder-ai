import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';
import { useRuntimeCatalog } from '../settings/members/useRuntimeCatalog';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const ref = 'plugin:official.codeagent/codeagent';

it('discovers plugin models using the stable ref and keeps inherited model choice empty', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'live',
        models: [{ value: 'a', label: 'A' }],
        defaultModel: 'a',
        defaultModelStatus: 'reported',
      }),
    ),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Catalog() {
    return <output>{JSON.stringify(useRuntimeCatalog(ref, undefined, '', '', 0))}</output>;
  }
  try {
    await act(async () => root.render(<Catalog />));
    expect(apiFetch).toHaveBeenCalledWith('/api/agent-providers/models', expect.anything());
    const options = vi.mocked(apiFetch).mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toMatchObject({ ref });
    expect(JSON.parse(String(options?.body))).not.toHaveProperty('command');
    expect(host.textContent).toContain('reported');
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});

it('shows unknown native default and unverified native identity for a selected plugin without rewriting preferences', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/cats/native-runtimes'
            ? { runtimes: [] }
            : url === '/api/agent-providers'
              ? {
                  libraries: [
                    {
                      pluginId: 'official.codeagent',
                      configurationKey: 'connection',
                      clients: [{ id: 'codeagent', name: 'CodeAgent', ref, available: true }],
                    },
                  ],
                }
              : { status: 'live', models: [{ value: 'a', label: 'A' }], defaultModelStatus: 'unreported' },
        ),
      ),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const patch = vi.fn();
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{
            ...initialState(),
            clientId: 'acp',
            carrier: 'acp',
            configurationSource: 'native_tool',
            acpAgentProvider: ref,
            acpCommand: 'plugin-agent',
            acpStartupArgs: '',
          }}
          accounts={[]}
          patch={patch}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing={false}
        />,
      ),
    );
    expect(host.textContent).toContain('默认模型尚未确认');
    expect(host.textContent).toContain('原生身份入口尚未验证');
    expect(patch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.resetAllMocks();
  }
});
