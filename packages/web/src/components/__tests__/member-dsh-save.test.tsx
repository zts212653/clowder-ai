import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  sendMemberSaveDiagnostics: vi.fn(),
  API_URL: 'isolated-dsh-save',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));
const args = ['--profile', 'acp', '--patch', '/host/company.yml'];
let persisted: CatData;
let host: HTMLDivElement, root: Root;
const response = (body: unknown) => new Response(JSON.stringify(body));
function catalogFixture() {
  const custom = persisted.acp?.startupArgs.includes('/host/company.yml');
  const model = custom ? '["company","private-model"]' : 'official';
  return {
    status: 'live',
    defaultModel: model,
    models: [{ value: model, label: custom ? 'Private model' : 'Official model' }],
  };
}
function inspectionFixture() {
  const custom = persisted.acp?.startupArgs.includes('/host/company.yml');
  return {
    profiles: ['acp', 'desktop'],
    sourceProfile: 'acp',
    revision: 'revision',
    active: {
      provider: custom ? 'company' : 'deepseek-official',
      model: custom ? 'private-model' : 'official',
      providers: [],
    },
    source: { providers: [{ id: 'company', models: [{ id: 'private-model', label: 'Private model' }] }] },
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  persisted = {
    id: 'dsh-role',
    name: 'DSH partner',
    displayName: 'DSH partner',
    nickname: 'Owner nickname',
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'official',
    mentionPatterns: ['@dsh-partner'],
    acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
    color: { primary: '#111111', secondary: '#eeeeee' },
    configurationRevision: 'before-save',
  } as CatData;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === `/api/cats/${persisted.id}` && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as Partial<CatData>;
      persisted = {
        ...persisted,
        ...patch,
        acp: patch.acp ? { ...persisted.acp, ...patch.acp } : persisted.acp,
        configurationRevision: 'after-save',
      };
      return response({ cat: persisted });
    }
    if (String(path).startsWith('/api/cats/native-runtimes'))
      return response({
        edition: 'intranet',
        runtimes: [
          {
            id: `acp:${persisted.id}`,
            kind: 'binding',
            sourceCatId: persisted.id,
            harnessId: 'dsh',
            label: 'DSH',
            clientId: 'acp',
            installed: true,
            models: [],
            acp: persisted.acp,
          },
          {
            id: 'dsh',
            kind: 'tool',
            harnessId: 'dsh',
            label: 'DSH',
            clientId: 'acp',
            installed: true,
            models: [],
            acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
          },
        ],
      });
    if (path === '/api/cats/dsh-setup/prepare') return response({ id: 'receipt', command: 'dsh', startupArgs: args });
    const fixtures: Record<string, unknown> = {
      '/api/session': { userId: 'fixture' },
      '/api/accounts': { providers: [], projectPath: '/project' },
      '/api/cat-templates': { templates: [] },
      '/api/agent-providers': { libraries: [] },
      '/api/cats': { cats: [persisted] },
      '/api/cats/runtime-models': catalogFixture(),
      '/api/cats/dsh-setup/inspect': inspectionFixture(),
    };
    return response(fixtures[String(path)] ?? { cats: [] });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () =>
    root.render(<MemberSettingsPage cat={persisted} cats={[persisted]} onSaved={vi.fn()} onBack={vi.fn()} />),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!button) throw Error(`Button missing: ${label}`);
  await act(async () => button.click());
}
it('persists the prepared descriptor through the existing member save and reopens the saved DSH source', async () => {
  await mount();
  await click('读取 DSH 配置');
  expect(host.textContent).toContain('deepseek-official');
  await click('使用此配置');
  expect(host.textContent).toContain('已加入草稿，请保存成员后使用');
  expect(
    vi.mocked(apiFetch).mock.calls.some(([path, init]) => path === '/api/cats/dsh-role' && init?.method === 'PATCH'),
  ).toBe(false);
  await click('保存');
  const saved = vi
    .mocked(apiFetch)
    .mock.calls.find(([path, init]) => path === '/api/cats/dsh-role' && init?.method === 'PATCH');
  expect(JSON.parse(String(saved?.[1]?.body))).toMatchObject({
    defaultModel: '',
    acp: { command: 'dsh', startupArgs: args },
  });
  expect(persisted.defaultModel).toBe('');
  expect(persisted.acp?.startupArgs).toEqual(args);
  expect(persisted.acp?.transport).toBe('stdio');
  expect(persisted.nickname).toBe('Owner nickname');
  expect(persisted.mentionPatterns).toEqual(['@dsh-partner']);
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  expect(host.querySelector('[data-testid=member-save-bar] [role=status]')?.textContent).toContain('没有改动');
  expect(host.textContent).not.toContain('发送一次请求验证此配置');
  await click('读取 DSH 配置');
  expect(host.textContent).toContain('company / private-model');
  const inspections = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/cats/dsh-setup/inspect');
  expect(JSON.parse(String(inspections.at(-1)?.[1]?.body))).toMatchObject({ runtimeId: 'acp:dsh-role' });
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/cats/dsh-setup/test')).toBe(false);
});
