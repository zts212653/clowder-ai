import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { dshModelLabel } from '@/lib/dsh-model-label';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import { MemberRuntimeSummary } from '../members/MemberRuntimeSummary';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each([
  'loading',
  'unavailable',
  'configured',
  'live',
  'duplicates',
  'inherited',
])('shows a readable DSH route while the catalog is %s, preserving its selection value', async (status) => {
  const route = '["deepseek-official","deepseek-flash"]';
  const live = status === 'live' || status === 'duplicates';
  const patch = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/cats/native-runtimes')
      return new Response(
        JSON.stringify({
          runtimes: [
            {
              id: 'dsh',
              label: 'DSH',
              clientId: 'acp',
              installed: true,
              models: [],
              acp: { command: 'dsh.cmd', startupArgs: ['--profile', 'acp'] },
            },
          ],
        }),
      );
    if (path === '/api/agent-providers') return new Response(JSON.stringify({ libraries: [] }));
    if (status === 'loading') return new Promise<Response>(() => {});
    if (status === 'unavailable') return new Response('{}', { status: 503 });
    return new Response(
      JSON.stringify({
        status: live ? 'live' : 'configured',
        defaultModel: route,
        models: [
          { value: route, label: live ? 'DeepSeek Flash' : route },
          ...(status === 'duplicates' ? [{ value: '["gateway","deepseek-flash"]', label: 'DeepSeek Flash' }] : []),
        ],
      }),
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
            defaultModel: status === 'inherited' ? '' : route,
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
    const label = live ? 'DeepSeek Flash' : 'deepseek-official / deepseek-flash';
    const model = host.querySelector<HTMLButtonElement>('[role=combobox]');
    expect(model?.textContent).toContain(label);
    if (status === 'inherited') expect(model?.textContent).toContain('跟随 DSH 设置');
    expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain(label);
    expect(patch).not.toHaveBeenCalled();
    await act(async () => model?.click());
    const saved = host.querySelector<HTMLButtonElement>('[role=option][aria-selected=true]');
    expect(saved?.textContent).toContain(label);
    expect(host.querySelector('[role=listbox]')?.textContent).not.toContain('["');
    await act(async () => saved?.click());
    expect(patch).toHaveBeenCalledWith({ defaultModel: status === 'inherited' ? '' : route });
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});

it.each([
  'custom-model',
  '[invalid',
  '["provider"]',
  '["provider",42]',
])('leaves a non-route or malformed manual model ID unchanged: %s', (value) =>
  expect(dshModelLabel(value)).toBe(value));

it('preserves another ACP client opaque ID when its arguments mention DeepSeek', async () => {
  const route = '["gateway","model"]';
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{
            ...initialState(),
            catId: 'custom',
            clientId: 'acp',
            configurationSource: 'native_tool',
            defaultModel: route,
            carrier: 'acp',
            acpCommand: 'custom-acp',
            acpStartupArgs: '--provider deepseek',
          }}
          accounts={[]}
          patch={vi.fn()}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing
        />,
      ),
    );
    expect(host.querySelector('[role=combobox]')?.textContent).toContain(route);
    expect(host.textContent).not.toContain('DSH 自定义 LLM');
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});

it.each([
  'explicit',
  'inherited',
])('distinguishes routes with identical model and group names: %s', async (selection) => {
  const first = '["gateway-a","flash"]',
    second = '["gateway-b","flash"]';
  const cat = {
    id: 'dsh',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: selection === 'inherited' ? '' : second,
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
  } as CatData;
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/cats/native-runtimes'
            ? { runtimes: [{ id: 'dsh', label: 'DSH', clientId: 'acp', installed: true, models: [], acp: cat.acp }] }
            : url === '/api/agent-providers'
              ? { libraries: [] }
              : {
                  status: 'live',
                  defaultModel: second,
                  defaultModelLabel: 'Gateway / Flash',
                  models: [
                    { value: first, label: 'Flash', group: 'Gateway' },
                    { value: second, label: 'Flash', group: 'Gateway' },
                  ],
                },
        ),
      ),
  );
  const patch = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <MemberRuntimeFields
            form={{
              ...initialState(),
              catId: cat.id,
              clientId: 'acp',
              carrier: 'acp',
              configurationSource: 'native_tool',
              defaultModel: cat.defaultModel,
              acpCommand: 'dsh',
              acpStartupArgs: '--profile acp',
            }}
            accounts={[]}
            patch={patch}
            t={(zh) => zh}
            accountHref="/settings?s=accounts"
            editing
          />
          <div data-testid="shared-summary">
            <MemberRuntimeSummary cat={cat} />
          </div>
        </>,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[role=combobox]');
    expect(trigger?.textContent).toContain('Flash · gateway-b / flash');
    expect(host.querySelector('[data-testid=shared-summary]')?.textContent).toContain('Flash · gateway-b / flash');
    expect(host.querySelector('[data-testid=member-model-summary]')?.textContent).toContain(
      'Flash · gateway-b / flash',
    );
    if (selection === 'inherited') expect(trigger?.textContent).toContain('跟随 DSH 设置');
    expect(patch).not.toHaveBeenCalled();
    await act(async () => trigger?.click());
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>('[role=option]'));
    expect(options[1].textContent).toContain('Flash · gateway-a / flash');
    expect(options[2].textContent).toContain('Flash · gateway-b / flash');
    expect(options.filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(options[selection === 'inherited' ? 0 : 2].getAttribute('aria-selected')).toBe('true');
    if (selection === 'inherited') expect(options[2].textContent).toContain('当前继承模型');
    await act(async () => options[1].click());
    expect(patch).toHaveBeenLastCalledWith({ defaultModel: first });
    await act(async () => trigger?.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[role=option]')?.click());
    expect(patch).toHaveBeenLastCalledWith({ defaultModel: '' });
  } finally {
    await act(async () => root.unmount());
    useMemberModelCatalogs.setState({ catalogs: {} });
    vi.resetAllMocks();
  }
});

it('preserves plugin opaque IDs despite a retained DSH launcher', async () => {
  const route = '["plugin-provider","plugin-model"]';
  vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 503 }));
  const patch = vi.fn();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemberRuntimeFields
          form={{
            ...initialState(),
            catId: 'plugin',
            clientId: 'acp',
            carrier: 'acp',
            configurationSource: 'native_tool',
            acpAgentProvider: 'plugin:official.codeagent/codeagent',
            acpCommand: 'dsh',
            acpStartupArgs: '--profile acp',
            defaultModel: route,
          }}
          accounts={[]}
          patch={patch}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing
        />,
      ),
    );
    expect(host.querySelector('[role=combobox]')?.textContent).toContain(route);
    expect(host.textContent).not.toContain('DSH 自定义 LLM');
    expect(patch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.resetAllMocks();
  }
});
