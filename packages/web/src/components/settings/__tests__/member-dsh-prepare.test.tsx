import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMemberModelCatalogs } from '@/lib/member-model-display';
import { apiFetch } from '@/utils/api-client';
import { NativePartnerCard } from '../../first-run-quest/NativePartnerCard';
import type { NativePartner } from '../../first-run-quest/native-onboarding';
import { initialState } from '../../hub-cat-editor.model';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { runtimeDefaults } from '../members/member-runtime-draft';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const host = document.createElement('div');
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  vi.resetAllMocks();
  useMemberModelCatalogs.setState({ runtimes: [], catalogs: {} });
});
const runtime = {
  id: 'dsh',
  label: 'DSH Desktop',
  clientId: 'acp' as const,
  installed: true,
  dshDesktop: true,
  models: [],
  acp: { command: '/Desktop/dsh.cmd', startupArgs: ['--profile', 'acp'], transport: 'stdio' as const },
};
const generated = ['--profile', 'acp', '--patch', '/host/member.yml'];
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function mount() {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/inspect')) expect(JSON.parse(String(init?.body))).toEqual({ runtimeId: 'dsh' });
    return new Response(
      JSON.stringify(
        path.startsWith('/api/cats/native-runtimes')
          ? { runtimes: [runtime] }
          : path.endsWith('/inspect')
            ? {
                revision: 'a'.repeat(64),
                provider: 'custom',
                model: 'custom-model',
                providers: [
                  { id: 'custom', credential: 'configured', models: [{ id: 'custom-model', label: 'Custom' }] },
                ],
              }
            : path.endsWith('/prepare')
              ? {
                  id: 'receipt',
                  command: runtime.acp.command,
                  startupArgs: generated,
                  env: { DSH_HOME: '/host/private-home' },
                  provider: 'custom',
                  model: 'custom-model',
                }
              : { ok: true },
      ),
    );
  });
  function Card() {
    const [partner, setPartner] = useState<NativePartner>({
      id: 'dsh-card',
      runtime,
      selected: false,
      form: {
        ...initialState(),
        ...runtimeDefaults(runtime),
        catId: 'new-dsh',
        name: 'DSH',
        displayName: 'DSH',
        mentionPatterns: '@new-dsh',
        defaultModel: '["deepseek-official","old"]',
      },
    });
    return (
      <>
        <NativePartnerCard
          partner={partner}
          created={false}
          patch={(value) => setPartner((old) => ({ ...old, ...value }))}
          onValidityChange={() => {}}
        />
        <button
          type="button"
          onClick={() => setPartner((old) => ({ ...old, form: { ...old.form, env: { DSH_HOME: '/changed/home' } } }))}
        >
          Change HOME
        </button>
        <button
          type="button"
          onClick={() => setPartner((old) => ({ ...old, form: { ...old.form, defaultModel: 'another-model' } }))}
        >
          Change model
        </button>
        <output>{JSON.stringify({ form: partner.form, payload: buildCatPayload(partner.form) })}</output>
      </>
    );
  }
  await act(async () => root.render(<Card />));
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
  await click('配置与验证');
  await click('读取 Desktop 配置');
  await click('验证并使用此模型');
}

it('persists the same verified launch HOME and selected custom model instead of the old official model', async () => {
  await mount();
  const { form, payload } = JSON.parse(host.querySelector('output')!.textContent!);
  expect(form.defaultModel).toBe('["custom","custom-model"]');
  expect(payload.defaultModel).toBe(form.defaultModel);
  expect(payload.acp.startupArgs).toEqual(generated);
  expect(payload.env).toEqual({ DSH_HOME: '/host/private-home' });
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(false);
  const check = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/test'))!;
  expect(JSON.parse(String(check[1]?.body))).toEqual({ id: 'receipt', model: '["custom","custom-model"]' });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.includes('/runtime-models'))).toBe(false);
});
it.each(['Change HOME', 'Change model'])('invalidates the connection proof after %s', async (label) => {
  await mount();
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(true);
  await click(label);
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.checked).toBe(false);
});
