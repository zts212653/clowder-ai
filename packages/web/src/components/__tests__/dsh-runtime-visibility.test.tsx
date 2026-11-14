import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';
import { useRuntimeCatalog } from '../settings/members/useRuntimeCatalog';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  'acp:dsh',
  'plugin:official.codeagent/codeagent',
])('allows slow %s discovery to finish, ends a failed refresh and permits retry', async (runtimeId) => {
  const pending: Array<{ resolve(value: Response): void; reject(reason: Error): void }> = [];
  vi.mocked(apiFetch).mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const host = document.createElement('div');
  const root = createRoot(host);
  function Catalog({ refresh = 0 }) {
    return <output>{JSON.stringify(useRuntimeCatalog(runtimeId, 'dsh', '', '', refresh))}</output>;
  }
  const snapshot = () => JSON.parse(host.textContent || '{}');
  try {
    await act(async () => root.render(<Catalog />));
    expect(vi.mocked(apiFetch).mock.calls[0]?.[2]).toEqual({ mutationTimeoutMs: 60_000 });
    await act(async () =>
      pending[0]?.resolve(
        new Response(
          JSON.stringify({
            status: 'live',
            models: [{ value: 'opaque', label: 'Model' }],
            defaultModel: 'opaque',
            defaultModelLabel: 'Custom Gateway / Model',
            defaultModelStatus: 'reported',
            defaultModelSource: 'client_report',
          }),
        ),
      ),
    );
    expect(snapshot().loading).toBe(false);
    await act(async () => root.render(<Catalog refresh={1} />));
    await act(async () => pending[1]?.reject(new DOMException('Timed out', 'TimeoutError')));
    expect(snapshot().loading).toBe(false);
    expect(snapshot().catalog.defaultModel).toBeUndefined();
    expect(snapshot().catalog.message).toBe('refresh_failed');
    await act(async () => root.render(<Catalog refresh={2} />));
    expect(snapshot().loading).toBe(true);
    await act(async () => pending[2]?.resolve(new Response(JSON.stringify({ status: 'live', models: [] }))));
    expect(snapshot().loading).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});

it.each([
  'acp:dsh',
  'plugin:official.codeagent/codeagent',
])('cancels %s requests on model changes and unmount, ignoring obsolete responses', async (runtimeId) => {
  const pending: Array<{ signal: AbortSignal | null | undefined; resolve(value: Response): void }> = [];
  vi.mocked(apiFetch).mockImplementation(
    (_path, init) => new Promise((resolve) => pending.push({ signal: init?.signal, resolve })),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Catalog({ model = 'old' }) {
    return <output>{JSON.stringify(useRuntimeCatalog(runtimeId, 'dsh', '', model, 0))}</output>;
  }
  const response = (model: string) =>
    new Response(
      JSON.stringify({
        status: 'live',
        models: [{ value: model, label: model }],
        defaultModel: model,
        defaultModelStatus: 'reported',
        defaultModelSource: 'client_report',
      }),
    );
  const snapshot = () => JSON.parse(host.textContent || '{}');
  try {
    await act(async () => root.render(<Catalog />));
    await act(async () => root.render(<Catalog model="current" />));
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(pending[1]?.signal?.aborted).toBe(false);
    await act(async () => pending[1]?.resolve(response('current')));
    expect(snapshot().catalog.defaultModel).toBe('current');
    await act(async () => pending[0]?.resolve(response('obsolete')));
    expect(snapshot().catalog.defaultModel).toBe('current');
    expect(snapshot().loading).toBe(false);
    await act(async () => root.render(<Catalog model="unmounted" />));
    await act(async () => root.unmount());
    expect(pending[2]?.signal?.aborted).toBe(true);
    await act(async () => pending[2]?.resolve(response('late after unmount')));
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});

it('shows the reported ACP route on the inherited model choice without changing the member', async () => {
  const patch = vi.fn();
  let failCatalog = false;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/cats/runtime-models' && failCatalog)
      return new Response(JSON.stringify({ error: 'discovery_failed' }), { status: 503 });
    return path.endsWith('/dsh-setup/inspect')
      ? new Response(JSON.stringify({ error: 'dsh_setup_custom_startup' }), { status: 422 })
      : new Response(
          JSON.stringify(
            path.startsWith('/api/cats/native-runtimes')
              ? {
                  runtimes: [
                    {
                      id: 'acp:dsh',
                      label: 'DSH',
                      clientId: 'acp',
                      installed: true,
                      models: [],
                      command: 'dsh.cmd',
                      acp: { command: 'dsh.cmd', startupArgs: ['--profile', 'acp'] },
                    },
                  ],
                }
              : path === '/api/agent-providers'
                ? { libraries: [] }
                : {
                    status: 'live',
                    models: [{ value: 'opaque', label: 'Model', group: 'Custom Gateway' }],
                    defaultModel: 'opaque',
                    defaultModelLabel: 'Custom Gateway / Model',
                    defaultModelStatus: 'reported',
                    defaultModelSource: 'client_report',
                  },
          ),
        );
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{
            ...initialState(),
            catId: 'dsh',
            clientId: 'acp',
            configurationSource: 'native_tool',
            defaultModel: '',
            carrier: 'acp',
            acpCommand: 'dsh.cmd',
            acpStartupArgs: '--profile acp',
          }}
          accounts={[]}
          patch={patch}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing
        />,
      ),
    );
    const model = host.querySelectorAll('[role=combobox]')[0];
    expect(model?.textContent).toContain('Custom Gateway / Model · 跟随 DSH 设置');
    await act(async () => (model as HTMLButtonElement).click());
    expect(host.querySelector('[role=option][aria-selected=true]')?.textContent).toContain('跟随 DSH 设置');
    expect(host.querySelectorAll('[role=option][aria-selected=true]')).toHaveLength(1);
    expect(host.querySelectorAll('[role=option]')[1]?.getAttribute('aria-selected')).toBe('false');
    expect(host.querySelectorAll('[role=option]')[1]?.textContent).toContain('当前继承模型');
    expect(host.querySelector('[role=option]')?.textContent).toContain('Custom Gateway / Model');
    expect(host.querySelector('[role=option]')?.textContent).toContain('客户端回报');
    expect(host.textContent).toContain('客户端回报');
    expect(host.textContent).not.toContain('读取 Desktop 配置');
    const summary = host.querySelector('[data-testid=member-model-summary]');
    expect(summary?.textContent).toContain('Custom Gateway / Model');
    expect(summary?.textContent).toContain('客户端回报');
    failCatalog = true;
    const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent === '刷新');
    await act(async () => refresh?.click());
    expect(host.textContent).toContain('模型目录暂不可读取');
    expect(host.textContent).not.toContain('已读取模型信息，但默认模型尚未确认');
    expect(model?.textContent).toContain('跟随 DSH 设置');
    expect(model?.textContent).not.toContain('Custom Gateway / Model');
    failCatalog = false;
    await act(async () => refresh?.click());
    expect(model?.textContent).toContain('Custom Gateway / Model · 跟随 DSH 设置');
    expect(patch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});
