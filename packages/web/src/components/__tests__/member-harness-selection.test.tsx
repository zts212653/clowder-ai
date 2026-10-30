import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  sendMemberSaveDiagnostics: vi.fn(),
  API_URL: 'isolated-harness',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));
const cat = {
  id: 'existing-yanyan',
  name: '缅因猫',
  displayName: '缅因猫',
  nickname: '砚砚',
  clientId: 'acp',
  carrier: 'acp',
  configurationSource: 'native_tool',
  defaultModel: 'company-model',
  mentionPatterns: ['@砚砚'],
  acp: { command: 'codeagent', startupArgs: ['--acp', '--permission-mode', 'bypassPermission'], transport: 'stdio' },
  color: { primary: '#111111', secondary: '#eeeeee' },
} as CatData;
const runtimes = [
  {
    id: 'codeagent',
    label: 'CodeAgent',
    kind: 'tool',
    harnessId: 'codeagent',
    clientId: 'acp',
    installed: true,
    models: [],
    acp: { command: 'codeagent', startupArgs: ['--acp'], transport: 'stdio' },
  },
  ...[
    ['claude', 'Claude Code', 'claudecode', 'anthropic'],
    ['codex', 'Codex', 'codex', 'openai'],
    ['dsh', 'DSH', 'dsh', 'acp'],
    ['pi', 'Pi', 'pi', 'acp'],
  ].map(([id, label, harnessId, clientId]) => ({
    id,
    label,
    harnessId,
    clientId,
    kind: 'tool',
    installed: true,
    models: [],
  })),
  {
    id: `acp:${cat.id}`,
    sourceCatId: cat.id,
    kind: 'binding',
    harnessId: 'codeagent',
    label: '缅因猫',
    clientId: 'acp',
    installed: true,
    models: ['company-model'],
    acp: cat.acp,
  },
];
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const fixtures: Record<string, unknown> = {
    '/api/accounts': { providers: [], projectPath: '/project' },
    '/api/session': { userId: 'fixture' },
    '/api/cat-templates': { templates: [] },
    '/api/agent-providers': {
      libraries: [
        {
          pluginId: 'approved',
          configurationKey: null,
          clients: [{ id: 'client', name: 'Custom ACP', ref: 'plugin:approved:client', available: false }],
        },
      ],
    },
  };
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).startsWith('/api/cats/native-runtimes')
            ? { edition: 'intranet', runtimes }
            : (fixtures[String(path)] ?? { status: 'configured', models: [], cats: [] }),
        ),
      ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<MemberSettingsPage cat={cat} cats={[cat]} onSaved={vi.fn()} onBack={vi.fn()} />));
}
async function choose(value: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]');
  if (!select) throw Error('Harness selector missing');
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw Error(`Button missing: ${label}`);
  await act(async () => button.click());
}
async function input(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!field) throw Error(`Field missing: ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('shows exactly five products while preserving a role-specific native binding on selection and refresh', async () => {
  await mount();
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]');
  if (!select) throw Error('Harness selector missing');
  expect([...select.options].map((option) => option.textContent?.split(' · ')[0])).toEqual([
    'CodeAgent',
    'Claude Code',
    'Codex',
    'DSH',
    'Pi',
  ]);
  expect(select?.value).toBe('codeagent');
  expect(host.textContent).not.toContain('跟随 缅因猫 设置');
  await choose('codeagent');
  expect(host.querySelector('[data-testid=member-save-bar] [role=status]')?.textContent).toContain('没有改动');
  const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent === '刷新');
  await act(async () => refresh?.click());
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('company-model');
  expect(host.querySelector('[data-testid=member-save-bar] [role=status]')?.textContent).toContain('没有改动');
  expect(host.querySelector<HTMLOptionElement>('option[value="plugin:approved:client"]')?.disabled).toBe(true);
});
it('restores the exact previous binding and identity after a harness round trip', async () => {
  await mount();
  await choose('codex');
  expect(host.querySelector('[data-testid=member-save-bar]')).not.toBeNull();
  expect(host.querySelector('[data-testid=member-save-bar]')?.textContent).not.toContain('没有改动');
  await choose('codeagent');
  expect(host.querySelector('[data-testid=member-save-bar] [role=status]')?.textContent).toContain('没有改动');
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('company-model');
  expect(host.textContent).toContain('砚砚');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});
it('restores edited unmatched launch arguments and model across sections and a harness round trip', async () => {
  await mount();
  await click('高级接入');
  const args = '--acp --permission-mode bypassPermission --custom-preference';
  await input('启动参数', args);
  await click('模型与工具');
  const model = host.querySelector<HTMLButtonElement>('[role=combobox]');
  if (!model) throw Error('Model picker missing');
  await act(async () => model.click());
  await click('手动指定模型…');
  await input('自定义模型', 'my-new-model');
  await click('使用');
  await choose('codex');
  await choose('codeagent');
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('my-new-model');
  await click('高级接入');
  expect(host.querySelector<HTMLInputElement>('input[aria-label="启动参数"]')?.value).toBe(args);
  expect(host.textContent).toContain('砚砚');
});
it('does not retain a previous harness label after changing the executable in advanced settings', async () => {
  await mount();
  await click('高级接入');
  await input('启动程序', 'unknown-wrapper');
  await click('模型与工具');
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.value).toBe('');
  expect(host.querySelector('[role=combobox]')?.textContent).not.toContain('CodeAgent');
  expect(host.textContent).toContain('使用已有接入配置');
});
it('keeps tool selection closed until the first discovery response establishes the edition', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation();
  if (!original) throw Error('API fixture missing');
  let finish: ((response: Response) => void) | undefined;
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    String(path).startsWith('/api/cats/native-runtimes')
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : original(path, init),
  );
  await mount();
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]');
  expect(selector?.disabled).toBe(true);
  expect(selector?.options.length).toBe(1);
  expect(host.textContent).not.toContain('Gemini');
  await act(async () => finish?.(new Response(JSON.stringify({ edition: 'intranet', runtimes }))));
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.disabled).toBe(false);
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.options.length).toBe(5);
});
it('preserves the member after initial discovery failure and admits tool choices only after retry succeeds', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation();
  if (!original) throw Error('API fixture missing');
  let fail = true;
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    fail && String(path).startsWith('/api/cats/native-runtimes')
      ? Promise.resolve(new Response('{}', { status: 503 }))
      : original(path, init),
  );
  await mount();
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.disabled).toBe(true);
  expect(host.textContent).not.toContain('Gemini');
  expect(host.querySelector('[data-testid=member-save-bar] [role=status]')?.textContent).toContain('没有改动');
  fail = false;
  await click('刷新');
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="使用工具"]')?.options.length).toBe(5);
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('company-model');
});
