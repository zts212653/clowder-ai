import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NativePartnerCard } from '../../first-run-quest/NativePartnerCard';
import type { NativePartner } from '../../first-run-quest/native-onboarding';
import { initialState } from '../../hub-cat-editor.model';
import { runtimeDefaults } from '../members/member-runtime-draft';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(async () => Response.json({ runtimes: [], libraries: [] })) }));
it('lets a Desktop partner be selected without manually reading configuration or calling a model', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const runtime = {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: true,
    dshDesktop: true,
    models: [],
    acp: { command: '/desktop/dsh.cmd', startupArgs: ['--profile', 'acp'] },
  };
  function Card() {
    const [partner, setPartner] = useState<NativePartner>({
      id: 'card',
      runtime,
      selected: false,
      form: { ...initialState(), ...runtimeDefaults(runtime), name: 'Whale', displayName: 'Whale' },
    });
    return (
      <NativePartnerCard
        partner={partner}
        created={false}
        patch={(change) => setPartner((old) => ({ ...old, ...change }))}
        onValidityChange={vi.fn()}
      />
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Card />));
    const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(true);
    expect(host.textContent).toContain('添加时自动配置');
    expect(host.textContent).not.toContain('已验证当前配置');
    expect(host.textContent).not.toContain('保存后自动检查连接');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
