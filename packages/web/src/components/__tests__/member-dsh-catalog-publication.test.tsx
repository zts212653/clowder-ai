import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useMemberModelCatalogs, useMemberModelLabel } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { type HubCatEditorFormState, initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

it('keeps a subscribed editor usable while a changed DSH model catalog is pending', async () => {
  const first = '["provider","first"]',
    second = '["provider","second"]';
  const cat = {
    id: 'dsh',
    clientId: 'acp',
    defaultModel: first,
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
  } as CatData;
  const models = [
    { value: first, label: 'First Model' },
    { value: second, label: 'Second Model' },
  ];
  let reads = 0;
  let finish: (response: Response) => void = () => {};
  const deferred = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/cats/native-runtimes')
      return new Response(
        JSON.stringify({
          runtimes: [{ id: 'dsh', label: 'DSH', clientId: 'acp', installed: true, models: [], acp: cat.acp }],
        }),
      );
    if (url === '/api/agent-providers') return new Response(JSON.stringify({ libraries: [] }));
    if (++reads === 2) return deferred;
    return new Response(JSON.stringify({ status: 'live', defaultModel: first, models }));
  });
  function Editor() {
    const [form, setForm] = useState<HubCatEditorFormState>({
      ...initialState(),
      catId: cat.id,
      clientId: 'acp',
      configurationSource: 'native_tool',
      carrier: 'acp',
      defaultModel: first,
      acpCommand: 'dsh',
      acpStartupArgs: '--profile acp',
    });
    const label = useMemberModelLabel();
    return (
      <>
        <span data-testid="parent-model">{label({ ...cat, defaultModel: form.defaultModel }, '跟随 DSH 设置')}</span>
        <MemberRuntimeFields
          form={form}
          accounts={[]}
          patch={(change) => setForm((previous) => ({ ...previous, ...change }))}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing
        />
      </>
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Editor />));
    expect(host.querySelector('[data-testid=parent-model]')?.textContent).toBe('First Model');
    await act(async () => host.querySelector<HTMLButtonElement>('[role=combobox]')?.click());
    const secondChoice = [...host.querySelectorAll<HTMLButtonElement>('[role=option]')].find((option) =>
      option.textContent?.includes('Second Model'),
    );
    await act(async () => secondChoice?.click());
    expect(reads).toBe(2);
    expect(host.querySelector('[data-testid=parent-model]')?.textContent).toBe('Second Model');
    expect(host.querySelector('[role=combobox]')?.textContent).toContain('Second Model');
    await act(async () => finish(new Response(JSON.stringify({ status: 'live', defaultModel: first, models }))));
    await act(async () => host.querySelector<HTMLButtonElement>('[role=combobox]')?.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[role=option]')?.click());
    expect(host.querySelector('[data-testid=parent-model]')?.textContent).toContain('First Model · 跟随 DSH 设置');
    expect(host.querySelector('[role=combobox]')?.textContent).toContain('First Model · 跟随 DSH 设置');
  } finally {
    await act(async () => root.unmount());
    useMemberModelCatalogs.setState({ catalogs: {} });
    vi.resetAllMocks();
  }
});
