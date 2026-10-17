import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { MemberSettingsPage } from '../settings/members/MemberSettingsPage';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
  sendMemberSaveDiagnostics: vi.fn(async () => new Response(null, { status: 204 })),
  API_URL: 'isolated',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('lang=zh'),
}));
const cat = {
  id: 'switch-test',
  name: '布偶猫',
  displayName: '布偶猫',
  clientId: 'anthropic',
  defaultModel: 'opus',
  accountRef: 'legacy',
  cli: { effort: 'high' },
  cliConfigArgs: ['--custom'],
  mentionPatterns: ['@switch'],
  color: { primary: '#123456', secondary: '#abcdef' },
} as CatData;
let host: HTMLDivElement, root: Root;
const saved = vi.fn(async () => {});
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  saved.mockClear();
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          path === '/api/accounts'
            ? { providers: [], projectPath: '/test' }
            : path === '/api/session'
              ? { userId: 'test' }
              : path === '/api/cat-templates'
                ? { templates: [] }
                : path === '/api/cats/native-runtimes'
                  ? {
                      runtimes: [
                        {
                          id: 'claude',
                          label: 'Claude Code',
                          clientId: 'anthropic',
                          installed: true,
                          models: ['opus'],
                        },
                        { id: 'codex', label: 'Codex', clientId: 'openai', installed: true, models: ['gpt-test'] },
                      ],
                    }
                  : { status: 'configured', models: [], cats: [] },
        ),
      ),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MemberSettingsPage cat={cat} cats={[cat]} onSaved={saved} onBack={() => {}} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function choose(value: string) {
  const select = [...host.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === 'claude'))!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function legacyConfirm() {
  const confirm = [...host.querySelectorAll('button')].find((e) => e.textContent === '切换工具');
  if (confirm) await act(async () => confirm.click());
}
it('switches tools in one selection and shows the actual unsaved changes', async () => {
  await choose('codex');
  expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toContain('Codex');
  expect(host.textContent).not.toContain('切换为 Codex');
  expect(host.querySelector('[data-testid=member-save-bar]')?.textContent).toContain('使用工具');
  expect(saved).not.toHaveBeenCalled();
});
it('restores the exact legacy configuration after a round trip, including after changing sections', async () => {
  await choose('codex');
  await legacyConfirm();
  const advanced = [...host.querySelectorAll('button')].find((e) => e.textContent === '身份与职责')!;
  await act(async () => advanced.click());
  const runtime = [...host.querySelectorAll('button')].find((e) => e.textContent === '模型与工具')!;
  await act(async () => runtime.click());
  await choose('claude');
  await legacyConfirm();
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('opus');
});

it('keeps the draft and exact old configuration after a rejected save', async () => {
  await choose('codex');
  const originalFetch = vi.mocked(apiFetch).getMockImplementation();
  vi.mocked(apiFetch).mockImplementation((path, init) => {
    if (path === '/api/cats/switch-test' && init?.method === 'PATCH')
      return Promise.resolve(new Response(JSON.stringify({ error: '配置已被其他窗口修改' }), { status: 409 }));
    if (!originalFetch) throw Error('API fixture missing');
    return originalFetch(path, init);
  });
  const save = [...host.querySelectorAll('button')].find((e) => e.textContent === '保存');
  if (!save) throw Error('Save missing');
  await act(async () => save.click());
  const write = vi
    .mocked(apiFetch)
    .mock.calls.find(([path, init]) => path === '/api/cats/switch-test' && init?.method === 'PATCH');
  expect(new Headers(write?.[1]?.headers).get('x-clowder-save-id')).toMatch(/^[\da-f-]{36}$/i);
  expect(host.textContent).toContain('配置已被其他窗口修改');
  expect(host.querySelector('[data-testid=member-identity-summary]')?.textContent).toContain('Codex');
  expect(saved).not.toHaveBeenCalled();
  await choose('claude');
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
  expect(host.querySelector('[role=combobox]')?.textContent).toContain('opus');
});

it('allows returning to a saved custom ACP tool that discovery does not list', async () => {
  const custom = {
    ...cat,
    clientId: 'acp',
    acp: { command: 'private-agent', startupArgs: ['--acp'], transport: 'stdio' },
  } as CatData;
  await act(async () => root.unmount());
  root = createRoot(host);
  sessionStorage.clear();
  await act(async () =>
    root.render(<MemberSettingsPage cat={custom} cats={[custom]} onSaved={saved} onBack={() => {}} />),
  );
  await choose('codex');
  const select = [...host.querySelectorAll('select')].find((e) => [...e.options].some((o) => o.value === 'claude'));
  const oldTool = [...(select?.options ?? [])].find((o) => o.textContent?.includes('private-agent'));
  expect(oldTool).toBeDefined();
  await choose(oldTool?.value ?? 'missing');
  expect(host.querySelector('[data-testid=member-save-bar]')).toBeNull();
});

it('keeps the save trace open through the actual editor refresh and records the UI commit', async () => {
  await choose('codex');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  saved.mockImplementationOnce(() => gate);
  const originalFetch = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation((path, init) =>
    path === '/api/cats/switch-test' && init?.method === 'PATCH'
      ? Promise.resolve(new Response(JSON.stringify({ cat: { ...cat, clientId: 'openai' } })))
      : originalFetch(path, init),
  );
  const save = [...host.querySelectorAll('button')].find((e) => e.textContent === '保存')!;
  const events = () => JSON.parse(sessionStorage.getItem('member-save-diagnostics:v1') ?? '[]')[0]?.events ?? [];
  try {
    await act(async () => save.click());
    expect(saved).toHaveBeenCalled();
    expect(events()).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'refresh', state: 'start' })]));
    expect(events()).not.toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'save', state: 'finish' })]));
  } finally {
    await act(async () => release());
  }
  expect(events()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ phase: 'save', state: 'finish' }),
      expect.objectContaining({ phase: 'ui.commit', state: 'finish' }),
    ]),
  );
});
