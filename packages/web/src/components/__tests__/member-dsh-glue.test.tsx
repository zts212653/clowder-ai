import { act, type Dispatch, type SetStateAction, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { type HubCatEditorFormState, initialState } from '../hub-cat-editor.model';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';
import { type RuntimeChoice, runtimeDefaults } from '../settings/members/member-runtime-draft';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const runtime: RuntimeChoice = {
  id: 'dsh',
  kind: 'tool',
  harnessId: 'dsh',
  label: 'DSH',
  clientId: 'acp',
  installed: true,
  models: [],
  acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
};
const inspection = {
  profiles: ['acp', 'desktop'],
  sourceProfile: 'acp',
  revision: 'revision',
  active: { provider: 'deepseek-official', model: 'official', providers: [] },
  source: { providers: [{ id: 'company', models: [{ id: 'private-model', label: 'Private model' }] }] },
};
const prepared = { id: 'receipt', command: 'dsh', startupArgs: ['--profile', 'acp', '--patch', '/host/company.yml'] };
let host: HTMLDivElement, root: Root;
let current: HubCatEditorFormState;
let change: Dispatch<SetStateAction<HubCatEditorFormState>>;
let patches: Partial<HubCatEditorFormState>[];
let runtimes: RuntimeChoice[];
let deferPrepare: boolean;
let finish: ((response: Response) => void) | undefined;
const response = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  patches = [];
  deferPrepare = false;
  finish = undefined;
  runtimes = [runtime];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).startsWith('/api/cats/native-runtimes')) return response({ edition: 'intranet', runtimes });
    if (path === '/api/cats/dsh-setup/inspect') return response(inspection);
    if (path === '/api/cats/dsh-setup/prepare')
      return deferPrepare
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : response(prepared);
    if (path === '/api/cats/runtime-models')
      return response({
        status: 'live',
        defaultModel: 'official',
        models: [{ value: 'official', label: 'Official model' }],
      });
    return response({ libraries: [] });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount(initial: Partial<HubCatEditorFormState> = {}) {
  function Harness() {
    const [form, setForm] = useState({
      ...initialState(),
      ...runtimeDefaults(runtime),
      catId: 'same-member',
      defaultModel: 'official',
      cliEffort: 'max',
      ...initial,
    });
    current = form;
    change = setForm;
    return (
      <MemberRuntimeFields
        form={form}
        accounts={[]}
        patch={(value) => {
          patches.push(value);
          setForm((old) => ({ ...old, ...value }));
        }}
        t={(zh) => zh}
        accountHref="/settings?s=members"
        editing={false}
      />
    );
  }
  await act(async () => root.render(<Harness />));
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw Error(`Button missing: ${label}`);
  await act(async () => button.click());
}
const hasReceipt = () => host.textContent?.includes('已加入草稿，请保存成员后使用。');

it('keeps its own prepared descriptor and receipt while clearing the explicitly replaced role model', async () => {
  await mount();
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('/dsh-setup/'))).toBe(false);
  await click('读取 DSH 配置');
  await click('使用此配置');
  expect(current.defaultModel).toBe('');
  expect(current.cliEffort).toBe('');
  expect(current.acpStartupArgs).toContain('/host/company.yml');
  expect(hasReceipt()).toBe(true);
  await act(async () => change((old) => ({ ...old, name: 'New display name' })));
  expect(hasReceipt()).toBe(true);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/cats/dsh-setup/test')).toBe(false);
  await click('发送一次请求验证此配置');
  expect(
    JSON.parse(String(vi.mocked(apiFetch).mock.calls.find(([path]) => path === '/api/cats/dsh-setup/test')?.[1]?.body)),
  ).toEqual({ id: 'receipt' });
  expect(host.textContent).toContain('已收到模型文本回复');
  const picker = host.querySelector<HTMLButtonElement>('[role=combobox]');
  await act(async () => picker?.click());
  expect(host.textContent).not.toContain('Official model');
});

it.each([
  { acpStartupArgs: '--profile acp --user-change' },
  { acpCommand: 'different-dsh' },
  { acpTransport: 'httpstream' as const },
  { acpAgentProvider: 'plugin:approved:dsh' },
  { accountRef: 'another-account' },
  { defaultModel: 'another-model' },
  { cliEffort: 'another-effort' },
])('invalidates the receipt after an external form edit: %j', async (edit) => {
  await mount();
  await click('读取 DSH 配置');
  await click('使用此配置');
  await act(async () => change((old) => ({ ...old, ...edit })));
  expect(hasReceipt()).toBe(false);
  expect(host.textContent).not.toContain('发送一次请求验证此配置');
});

it.each([
  { acpStartupArgs: '--profile acp --user-change' },
  { acpCommand: 'different-dsh' },
  { acpTransport: 'httpstream' as const },
  { acpAgentProvider: 'plugin:approved:dsh' },
  { accountRef: 'another-account' },
  { defaultModel: 'another-model' },
  { cliEffort: 'another-effort' },
  { clientId: 'openai' as const, carrier: 'app_server' as const, acpCommand: '', acpStartupArgs: '' },
])('does not apply a late prepare over a newer form context: %j', async (edit) => {
  deferPrepare = true;
  await mount();
  await click('读取 DSH 配置');
  await click('使用此配置');
  await act(async () => change((old) => ({ ...old, ...edit })));
  const changed = { ...current };
  await act(async () => finish?.(response(prepared)));
  expect(current).toEqual(changed);
  expect(patches).toEqual([]);
  expect(hasReceipt()).toBe(false);
});

it.each([
  { harnessId: undefined },
  { harnessId: 'codeagent' },
])('requires reliable DSH classification instead of matching its name in command text: %j', async (metadata) => {
  runtimes = [{ ...runtime, ...metadata }];
  await mount();
  expect(host.textContent).not.toContain('DSH 自定义 LLM');
});

it('does not offer native DSH setup for a plugin-owned binding', async () => {
  await mount({ acpAgentProvider: 'plugin:approved:dsh' });
  expect(host.textContent).not.toContain('DSH 自定义 LLM');
});
