import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

it('shows an ACP empty native model label in both the summary and the inherited picker option', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/cats/native-runtimes'
            ? {
                runtimes: [
                  {
                    id: 'acp:fixture',
                    label: 'Owned ACP',
                    clientId: 'acp',
                    installed: true,
                    models: ['', 'opaque/custom'],
                    acp: { command: 'owned-acp', startupArgs: [], transport: 'stdio' },
                  },
                ],
              }
            : {
                status: 'live',
                defaultModel: '',
                defaultModelLabel: 'Provider default',
                defaultModelStatus: 'reported',
                defaultModelSource: 'client_report',
                models: [
                  { value: '', label: 'Provider default' },
                  { value: 'opaque/custom', label: 'Custom' },
                ],
              },
        ),
      ),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{
            ...initialState(),
            clientId: 'acp',
            carrier: 'acp',
            configurationSource: 'native_tool',
            acpCommand: 'owned-acp',
          }}
          accounts={[]}
          patch={() => {}}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing={false}
          nativeSetup
        />,
      ),
    );
    expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain('Provider default');
    await act(async () => host.querySelector<HTMLButtonElement>('[role=combobox]')?.click());
    expect(host.querySelector('[role=option]')?.textContent).toContain('Provider default');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.resetAllMocks();
  }
});

it.each([
  { saved: '', thinkingEnabled: undefined },
  { saved: 'high', thinkingEnabled: undefined },
  { saved: '', thinkingEnabled: false },
  { saved: 'high', thinkingEnabled: false },
])('keeps tierless Kimi state and saved preferences (saved=$saved, thinking=$thinkingEnabled)', async ({
  saved,
  thinkingEnabled,
}) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/agent-providers'
            ? { libraries: [] }
            : path === '/api/cats/native-runtimes'
              ? {
                  runtimes: [
                    { id: 'kimi', label: 'Kimi', clientId: 'kimi', installed: true, models: ['boolean-model'] },
                  ],
                }
              : {
                  status: 'configured',
                  message: 'configured_only',
                  defaultModel: 'boolean-model',
                  models: [{ value: 'boolean-model', label: 'Boolean', efforts: [] }],
                  effortOptions: [],
                  thinkingEnabled,
                },
        ),
      ),
  );
  const patch = vi.fn(),
    valid = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{ ...initialState(), clientId: 'kimi', configurationSource: 'native_tool', cliEffort: saved }}
          accounts={[]}
          patch={patch}
          onValidityChange={valid}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing={false}
        />,
      ),
    );
    expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain('未提供独立强度档位');
    const picker = host.querySelectorAll<HTMLButtonElement>('[role=combobox]')[1];
    await act(async () => picker.click());
    expect(host.textContent).not.toContain('手动指定');
    if (thinkingEnabled === false) expect(host.textContent).toContain('已关闭思考');
    else expect(host.textContent).not.toContain('已关闭思考');
    if (saved) expect(host.textContent).toContain(`已保留强度偏好 ${saved}`);
    expect(valid).toHaveBeenLastCalledWith(true);
    expect(patch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.resetAllMocks();
  }
});

it.each([
  { draft: false, saved: false },
  { draft: true, saved: false },
  { draft: true, saved: true },
])('labels an unread manual/draft tool honestly (draft=$draft, saved=$saved)', async ({ draft, saved }) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(JSON.stringify(path === '/api/agent-providers' ? { libraries: [] } : { runtimes: [] })),
  );
  const form = {
    ...initialState(),
    clientId: 'opencode' as const,
    configurationSource: 'native_tool' as const,
    defaultModel: saved ? 'saved-model' : '',
    cliEffort: saved ? 'saved-tier' : '',
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={form}
          runtimeDrafts={draft ? { saved: form } : undefined}
          accounts={[]}
          patch={() => {}}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing={false}
        />,
      ),
    );
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('/runtime-models'))).toBe(false);
    expect(host.textContent).toContain('尚未接入模型与思考强度读取');
    expect(host.textContent).not.toContain('客户端未上报');
    expect(host.textContent).not.toContain('稍后刷新重试');
    if (saved) {
      expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain('saved-model');
      expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain('saved-tier');
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.resetAllMocks();
  }
});
