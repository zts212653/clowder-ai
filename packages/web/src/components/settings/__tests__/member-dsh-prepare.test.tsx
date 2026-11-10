import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { NativePartnerCard } from '../../first-run-quest/NativePartnerCard';
import type { NativePartner } from '../../first-run-quest/native-onboarding';
import { type HubCatEditorFormState, initialState } from '../../hub-cat-editor.model';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { MemberRuntimeFields } from '../members/MemberRuntimeFields';
import { runtimeDefaults } from '../members/member-runtime-draft';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const host = document.createElement('div');
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  vi.resetAllMocks();
});
const args = ['/fixture/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'acp'];
const generated = [...args, '--patch', '/fixture/host/custom.yml'];

it('one-click DSH remains unavailable until its current configuration is verified and invalidates after a model edit', async () => {
  const runtime = {
    id: 'dsh',
    label: 'DSH Desktop',
    clientId: 'acp' as const,
    installed: true,
    models: [],
    acp: { command: 'node', startupArgs: args, transport: 'stdio' as const },
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/verify')) {
      expect(JSON.parse(init!.body as string)).toEqual({ runtimeId: 'dsh' });
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response(
      JSON.stringify(
        path.startsWith('/api/cats/native-runtimes')
          ? { runtimes: [runtime] }
          : { status: 'live', models: [], effortOptions: [] },
      ),
    );
  });
  function WizardCard() {
    const [partner, setPartner] = useState<NativePartner>({
      id: 'dsh-card',
      runtime,
      form: { ...initialState(), ...runtimeDefaults(runtime), name: 'DSH', displayName: 'DSH' },
      selected: false,
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
          onClick={() => setPartner((old) => ({ ...old, form: { ...old.form, defaultModel: 'another-model' } }))}
        >
          Change model
        </button>
      </>
    );
  }
  await act(async () => root.render(<WizardCard />));
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '配置与验证')!.click(),
  );
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '验证当前配置')!.click(),
  );
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.disabled).toBe(false);
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(true);
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === 'Change model')!.click(),
  );
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.checked).toBe(false);
});

async function prepare(runtimeId = 'acp:existing-dsh', launchArgs = args) {
  let currentArgs = launchArgs;
  let reopened = false;
  const preparedArgs = [...launchArgs, '--patch', '/fixture/host/custom.yml'];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const data = path.startsWith('/api/cats/native-runtimes')
      ? {
          runtimes: [
            {
              id: runtimeId,
              label: 'DSH',
              clientId: 'acp',
              installed: true,
              discoveryStatus: currentArgs.includes('--patch') ? undefined : 'configured',
              dshSetupSupported: true,
              models: [],
              acp: { command: 'node', startupArgs: currentArgs, transport: 'stdio' },
            },
          ],
        }
      : path === '/api/agent-providers'
        ? { libraries: [] }
        : path.endsWith('/inspect')
          ? {
              profiles: ['acp'],
              sourceProfile: 'acp',
              revision: 'a'.repeat(64),
              active: { providers: [] },
              source: { providers: [{ id: 'custom', models: [{ id: 'custom-model', label: 'Custom' }] }] },
            }
          : path.endsWith('/prepare')
            ? { id: 'receipt', command: 'node', startupArgs: preparedArgs }
            : path.endsWith('/test')
              ? { ok: true }
              : { status: 'live', models: [], effortOptions: [] };
    return new Response(JSON.stringify(data));
  });
  function Editor() {
    const baseline: HubCatEditorFormState = {
      ...initialState(),
      catId: 'new-dsh',
      name: 'New DSH',
      clientId: 'acp' as const,
      carrier: 'acp' as const,
      configurationSource: 'native_tool' as const,
      acpCommand: 'node',
      acpStartupArgs: currentArgs.join(' '),
      defaultModel: reopened ? '' : 'old-official',
      cliEffort: reopened ? '' : 'max',
    };
    const [form, setForm] = useState<HubCatEditorFormState>(baseline);
    return (
      <>
        <MemberRuntimeFields
          form={form}
          accounts={[]}
          patch={(value) => setForm((old) => ({ ...old, ...value }))}
          t={(zh) => zh}
          accountHref="/settings?s=accounts"
          editing={false}
        />
        <button
          type="button"
          onClick={() => setForm((old) => ({ ...old, acpStartupArgs: `${old.acpStartupArgs} --manual` }))}
        >
          Edit launch
        </button>
        <button type="button" onClick={() => setForm(baseline)}>
          Discard prepare
        </button>
        <button type="button" onClick={() => setForm((old) => ({ ...old, acpAgentProvider: 'plugin:fixture/tool' }))}>
          Switch plugin
        </button>
        <button
          type="button"
          onClick={() =>
            setForm((old) => ({ ...old, acpCommand: 'custom-acp', acpStartupArgs: '--provider deepseek' }))
          }
        >
          Switch ACP
        </button>
        <output>{JSON.stringify({ form, payload: buildCatPayload(form) })}</output>
      </>
    );
  }
  await act(async () => root.render(<Editor />));
  await click('读取 DSH 配置');
  await click('使用此配置');
  return {
    preparedArgs,
    reopen: async () => {
      const { payload } = JSON.parse(host.querySelector('output')!.textContent!);
      currentArgs = payload.acp.startupArgs;
      reopened = true;
      await act(async () => root.render(null));
      await act(async () => root.render(<Editor />));
    },
  };
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
it('keeps the preparation receipt when a new member reuses an existing DSH runtime', async () => {
  await prepare();
  expect(host.textContent).toContain('已加入草稿，请保存成员后使用');
  await click('发送一次请求验证此配置');
  const test = vi.mocked(apiFetch).mock.calls.find(([path]) => path.endsWith('/dsh-setup/test'));
  expect(JSON.parse(String(test?.[1]?.body))).toEqual({ id: 'receipt' });
  expect(host.textContent).toContain('已收到模型文本回复');
});
it('clears stale model and effort overrides in the saved member payload', async () => {
  await prepare();
  const { form, payload } = JSON.parse(host.querySelector('output')!.textContent!);
  expect(form.defaultModel).toBe('');
  expect(form.cliEffort).toBe('');
  expect(payload.cli?.effort).toBeUndefined();
  expect(payload.acp.startupArgs).toEqual(generated);
});
it.each(['acp:existing-dsh', 'dsh'])('invalidates the receipt after manually changing %s launch', async (runtimeId) => {
  await prepare(runtimeId);
  await click('Edit launch');
  expect(host.textContent).not.toContain('已加入草稿，请保存成员后使用');
  expect(host.textContent).not.toContain('发送一次请求验证此配置');
});

it.each([
  args[0],
  '/fixture/installed/dsh/lib/bin.js',
])('keeps preparation, verification, refresh and saved reopen for %s', async (entry) => {
  const { preparedArgs, reopen } = await prepare('acp:existing-dsh', [entry, '--profile', 'acp']);
  expect(host.textContent).toContain('已加入草稿，请保存成员后使用');
  await click('刷新');
  expect(host.textContent).toContain('已加入草稿，请保存成员后使用');
  await click('发送一次请求验证此配置');
  expect(host.textContent).toContain('已收到模型文本回复');
  const { payload } = JSON.parse(host.querySelector('output')!.textContent!);
  expect(payload.acp.startupArgs).toEqual(preparedArgs);
  expect(payload.defaultModel).toBe('');
  await reopen();
  expect(host.textContent).toContain('DSH 自定义 LLM');
  await click('读取 DSH 配置');
  expect(host.textContent).toContain('使用此配置');
  expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
});

it.each([
  args[0],
  '/fixture/installed/dsh/lib/bin.js',
])('restores the saved tool and clears a discarded receipt for %s', async (entry) => {
  await prepare('acp:existing-dsh', [entry, '--profile', 'acp']);
  await click('Discard prepare');
  expect(host.querySelector('select')?.value).toBe('acp:existing-dsh');
  expect(host.textContent).not.toContain('已加入草稿，请保存成员后使用');
  expect(host.textContent).not.toContain('发送一次请求验证此配置');
  const { payload } = JSON.parse(host.querySelector('output')!.textContent!);
  expect(payload.acp.startupArgs).toEqual([entry, '--profile', 'acp']);
  expect(payload.defaultModel).toBe('old-official');
  expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
});

it.each(['Switch plugin', 'Switch ACP'])('does not retain prepared DSH evidence after %s', async (action) => {
  await prepare('acp:existing-dsh', ['/fixture/installed/dsh/lib/bin.js', '--profile', 'acp']);
  await click(action);
  expect(host.textContent).not.toContain('DSH 自定义 LLM');
  expect(host.textContent).not.toContain('已加入草稿，请保存成员后使用');
  expect(host.textContent).not.toContain('发送一次请求验证此配置');
  expect(vi.mocked(apiFetch).mock.calls.some(([, request]) => request?.method === 'PATCH')).toBe(false);
});
