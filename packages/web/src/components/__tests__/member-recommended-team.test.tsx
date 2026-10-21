import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { RecommendedTeamSetup } from '../settings/members/RecommendedTeamSetup';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], refresh: vi.fn() }) }));
let root: Root, host: HTMLDivElement;
let installed = true;
let failed = false;
let loginRequired = false;
let existing: CatData[] = [];
const created = vi.fn(),
  manual = vi.fn(),
  back = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(name))!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  installed = true;
  failed = false;
  loginRequired = false;
  existing = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return json({ userId: 'first-team-owner' });
    if (path === '/api/config/onboarding/entry') return json({ status: 'pending' });
    if (path === '/api/cat-templates')
      return json({
        templates: [
          {
            id: 'ragdoll',
            name: '布偶猫',
            nickname: '宪宪',
            avatar: '',
            color: { primary: '#000000', secondary: '#ffffff' },
            personality: '可靠',
            roleDescription: '负责方案和审查',
          },
        ],
      });
    if (String(path).startsWith('/api/cats/native-runtimes'))
      return failed
        ? json({ error: '检测服务离线' }, 503)
        : json({
            runtimes: [
              {
                id: 'claude',
                label: 'Claude Code',
                clientId: 'anthropic',
                installed,
                models: [],
                readiness: loginRequired
                  ? { status: 'login_required', checkedAt: 1, loginCommand: 'claude auth login' }
                  : undefined,
              },
              { id: 'codex', label: 'Codex', clientId: 'openai', installed, models: [] },
              {
                id: 'dsh',
                label: 'DSH',
                clientId: 'acp',
                installed,
                models: [],
                acp: { command: 'dsh', startupArgs: ['--profile', 'acp'] },
              },
            ],
          });
    if (path === '/api/cats' && !init?.method) return json({ cats: existing });
    if (path === '/api/cats' && init?.method === 'POST') {
      const data = JSON.parse(String(init.body));
      return json(
        { cat: { id: data.catId, displayName: data.displayName, mentionPatterns: data.mentionPatterns } },
        201,
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const mount = () =>
  act(async () => root.render(<RecommendedTeamSetup onCreated={created} onManual={manual} onBack={back} />));

it('blocks the default logged-out partner while keeping connection adjustment and other partners available', async () => {
  loginRequired = true;
  await mount();
  expect(host.textContent).toContain('Claude Code 尚未登录');
  expect(host.textContent).toContain('claude auth login');
  expect(host.textContent).toContain('新增伙伴前需要先登录；其他连接请通过手动入口创建。');
  expect(host.textContent).not.toContain('创建后还需登录');
  const claude = host.querySelector<HTMLInputElement>('input[aria-label="加入 Claude Code 伙伴"]');
  expect(claude).not.toBeNull();
  expect(claude?.checked).toBe(false);
  expect(claude?.disabled).toBe(true);
  const adjust = [...(claude?.closest('article')?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === '调整',
  );
  expect(adjust).toBeDefined();
  expect(adjust?.disabled).toBe(false);
  expect(host.querySelectorAll('input:checked')).toHaveLength(2);
  await act(async () => button('一键创建').click());
  const writes = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)).clientId)).toEqual(['openai', 'acp']);
});

it('detects and preselects a complete team, and creates it in one click with inherited defaults', async () => {
  await mount();
  expect(host.querySelectorAll('input:checked')).toHaveLength(3);
  expect(host.textContent).toContain('负责方案和审查');
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  await act(async () => button('一键创建 3 位伙伴').click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(3);
  expect(posts.every(([path]) => path === '/api/cats')).toBe(true);
  for (const [, init] of posts)
    expect(JSON.parse(String(init?.body))).toMatchObject({ configurationSource: 'native_tool', defaultModel: '' });
  expect(created).toHaveBeenCalledOnce();
});

it('shows installation help and blocks creation when no supported tools are found', async () => {
  installed = false;
  await mount();
  expect(host.textContent).toContain('还没有找到可加入的工具');
  expect(host.querySelector('details')?.open).toBe(true);
  expect(button('暂不创建').disabled).toBe(false);
  await act(async () => button('手动创建单个伙伴').click());
  expect(manual).toHaveBeenCalledOnce();
  expect(created).not.toHaveBeenCalled();
});

it('distinguishes discovery failure from no tools and recovers through detection', async () => {
  failed = true;
  await mount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('暂时无法检测工具');
  expect(host.textContent).not.toContain('还没有找到可加入的工具');
  expect(button('暂不创建').disabled).toBe(false);
  await act(async () => button('手动创建单个伙伴').click());
  expect(manual).toHaveBeenCalledOnce();
  failed = false;
  await act(async () => button('重新检测').click());
  expect(button('一键创建 3 位伙伴').disabled).toBe(false);
});

it('allows one selected partner and ignores the unselected partners', async () => {
  await mount();
  const choices = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  act(() => choices[1].click());
  act(() => choices[2].click());
  await act(async () => button('一键创建 1 位伙伴').click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0][1]?.body)).clientId).toBe('anthropic');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.some(([path, init]) => path === '/api/config/onboarding/entry' && init?.method === 'PUT'),
  ).toBe(true);
  expect(created).toHaveBeenCalledOnce();
});

it('allows no selection to return without creating roles or invoking models', async () => {
  await mount();
  act(() => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((choice) => choice.click()));
  await act(async () => button('暂不创建').click());
  expect(back).toHaveBeenCalledOnce();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});

it('reads the real roster before recommending and does not overwrite an existing partner', async () => {
  existing = [
    {
      id: 'owned-claude',
      carrier: 'cli',
      displayName: '我的架构师',
      clientId: 'anthropic',
      configurationSource: 'native_tool',
      defaultModel: 'my-model',
      mentionPatterns: ['@my-cat'],
      color: { primary: '#000000', secondary: '#ffffff' },
      avatar: '',
      personality: '保留',
      roleDescription: '原职责',
    },
  ];
  await mount();
  expect(host.textContent).toContain('我的架构师');
  await act(async () => button('一键创建 2 位伙伴').click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts.some(([, init]) => String(init?.body).includes('owned-claude'))).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path === '/api/config/onboarding/entry')).toBe(false);
  expect(created).toHaveBeenCalledOnce();
});
