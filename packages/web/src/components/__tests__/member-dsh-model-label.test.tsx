import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { dshModelLabel } from '@/lib/dsh-model-label';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
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
