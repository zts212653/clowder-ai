import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { type HubCatEditorFormState, initialState } from '../../hub-cat-editor.model';
import { buildCatPayload } from '../../hub-cat-editor.payload';
import { MemberRuntimeFields } from '../members/MemberRuntimeFields';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const host = document.createElement('div');
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  vi.resetAllMocks();
});
const args = ['/fixture/dsh/lib/bin.js', '--profile', 'acp'];
const generated = [...args, '--patch', '/fixture/host/custom.yml'];
async function prepare(runtimeId = 'acp:existing-dsh') {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const data =
      path === '/api/cats/native-runtimes'
        ? {
            runtimes: [
              {
                id: runtimeId,
                kind: runtimeId === 'dsh' ? 'tool' : 'binding',
                harnessId: 'dsh',
                label: 'DSH',
                clientId: 'acp',
                installed: true,
                models: [],
                acp: { command: 'node', startupArgs: args, transport: 'stdio' },
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
              ? { id: 'receipt', command: 'node', startupArgs: generated }
              : path.endsWith('/test')
                ? { ok: true }
                : { status: 'live', models: [], effortOptions: [] };
    return new Response(JSON.stringify(data));
  });
  function Editor() {
    const [form, setForm] = useState<HubCatEditorFormState>({
      ...initialState(),
      catId: 'new-dsh',
      name: 'New DSH',
      clientId: 'acp' as const,
      carrier: 'acp' as const,
      configurationSource: 'native_tool' as const,
      acpCommand: 'node',
      acpStartupArgs: args.join(' '),
      defaultModel: 'old-official',
      cliEffort: 'max',
    });
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
        <output>{JSON.stringify({ form, payload: buildCatPayload(form) })}</output>
      </>
    );
  }
  await act(async () => root.render(<Editor />));
  await click('读取 DSH 配置');
  await click('使用此配置');
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
