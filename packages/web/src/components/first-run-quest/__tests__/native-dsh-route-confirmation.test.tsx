import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { RecommendedTeamSetup } from '../../settings/members/RecommendedTeamSetup';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ refresh: vi.fn() }) }));
let host: HTMLDivElement, root: Root;
let missing = false,
  prepareFailure = false;
let claudeReadiness: 'configured' | 'login_required' | undefined;
const created = vi.fn(),
  manual = vi.fn();
const route = {
  status: 'configured',
  sourceProfile: 'desktop',
  revision: 'a'.repeat(64),
  provider: 'company',
  model: 'private-model',
};
const preparedArgs = ['--profile', 'acp', '--patch', '/host/immutable-dsh-route.yml'];
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  missing = false;
  prepareFailure = false;
  claudeReadiness = undefined;
  route.provider = 'company';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/session') return response({ userId: 'compact-recommendation' });
    if (path === '/api/cat-templates') return response({ templates: [] });
    if (String(path).startsWith('/api/cats/native-runtimes'))
      return response({
        edition: 'intranet',
        runtimes: [
          ...(claudeReadiness
            ? [
                {
                  id: 'claude',
                  label: 'Claude Code',
                  clientId: 'anthropic',
                  installed: true,
                  models: [],
                  readiness: { status: claudeReadiness, checkedAt: 1, loginCommand: 'claude auth login' },
                },
              ]
            : []),
          {
            id: 'dsh',
            harnessId: 'dsh',
            kind: 'tool',
            clientId: 'acp',
            label: 'DSH',
            installed: true,
            dshSetupRequired: true,
            dshSetup: missing ? { status: 'unavailable', error: 'dsh_setup_credential_required' } : route,
            models: [],
            acp: { command: 'dsh', startupArgs: ['--profile', 'acp'], transport: 'stdio' },
          },
        ],
      });
    if (path === '/api/cats' && !init?.method) return response({ cats: [] });
    if (path === '/api/config/onboarding/entry') return response({ status: 'pending' });
    if (path === '/api/cats/dsh-setup/prepare')
      return prepareFailure
        ? response({ error: 'dsh_setup_changed' }, 409)
        : response({ id: 'receipt', command: 'dsh', startupArgs: preparedArgs });
    if (path === '/api/cats' && init?.method === 'POST') {
      const value = JSON.parse(String(init.body));
      return response(
        { cat: { id: value.catId, displayName: value.displayName, mentionPatterns: value.mentionPatterns } },
        201,
      );
    }
    throw Error(`Unexpected request: ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const mount = () =>
  act(async () => root.render(<RecommendedTeamSetup onCreated={created} onBack={vi.fn()} onManual={manual} />));
const create = () => [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('一键创建'))!;
it.each([
  'company',
  'deepseek-official',
])('keeps a detected usable DSH %s route collapsed and preselected, preparing it only on create', async (provider) => {
  route.provider = provider;
  await mount();
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
  expect(
    [...host.querySelectorAll('button')].some((item) =>
      ['调整', '收起', '使用此配置'].includes(item.textContent ?? ''),
    ),
  ).toBe(false);
  expect(host.querySelector('fieldset, select, input:not([type=checkbox])')).toBeNull();
  expect(host.textContent).not.toContain('DSH 自定义 LLM');
  expect(host.textContent).toContain('已检测到供应商与凭据配置');
  expect(host.textContent).not.toContain('此连接的登录状态尚未检查');
  expect(vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  await act(async () => create().click());
  const calls = vi.mocked(apiFetch).mock.calls;
  const prepare = calls.find(([path]) => path.endsWith('/prepare'))!;
  expect(JSON.parse(String(prepare[1]?.body))).toEqual({
    runtimeId: 'dsh',
    sourceProfile: route.sourceProfile,
    revision: route.revision,
    provider: route.provider,
    model: route.model,
  });
  const post = calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST')!;
  expect(calls.indexOf(prepare)).toBeLessThan(calls.indexOf(post));
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({
    configurationSource: 'native_tool',
    defaultModel: '',
    acp: { startupArgs: preparedArgs },
  });
  expect(calls.some(([path]) => path.endsWith('/test') || path.endsWith('/runtime-models'))).toBe(false);
  expect(created).toHaveBeenCalledOnce();
});
it('keeps a missing-credential DSH unselected without expanding configuration and retains the existing manual entry', async () => {
  missing = true;
  await mount();
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.closest('details')).not.toBeNull();
  expect(host.querySelector('fieldset, select')).toBeNull();
  const entry = [...host.querySelectorAll('button')].find((item) => item.textContent === '手动创建单个伙伴')!;
  await act(async () => entry.click());
  expect(manual).toHaveBeenCalledOnce();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
});
it('does not save a stale route and can retry after a fresh detection', async () => {
  prepareFailure = true;
  await mount();
  await act(async () => create().click());
  expect(host.textContent).toContain('重新检测');
  expect(vi.mocked(apiFetch).mock.calls.some(([path, init]) => path === '/api/cats' && init?.method === 'POST')).toBe(
    false,
  );
  prepareFailure = false;
  await act(async () => [...host.querySelectorAll('button')].find((item) => item.textContent === '重新检测')!.click());
  await act(async () => create().click());
  expect(created).toHaveBeenCalledOnce();
});

it('preselects both usable Claude and DSH recommendations without exposing member editors', async () => {
  claudeReadiness = 'configured';
  await mount();
  const choices = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
  expect(choices).toHaveLength(2);
  expect(choices.every((choice) => choice.checked && !choice.disabled && !choice.closest('details'))).toBe(true);
  expect(host.querySelector('fieldset, select')).toBeNull();
  await act(async () => create().click());
  expect(
    vi.mocked(apiFetch).mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST'),
  ).toHaveLength(2);
});
it('keeps an actually logged-out Claude in help rather than the usable recommendations', async () => {
  claudeReadiness = 'login_required';
  await mount();
  const claude = host.querySelector<HTMLInputElement>('input[aria-label="加入 Claude Code 伙伴"]')!;
  const dsh = host.querySelector<HTMLInputElement>('input[aria-label="加入 DSH 伙伴"]')!;
  expect(claude.closest('details')).not.toBeNull();
  expect(claude.disabled).toBe(true);
  expect(claude.checked).toBe(false);
  expect(dsh.closest('details')).toBeNull();
  expect(dsh.checked).toBe(true);
});
it('preselects a previously blocked draft after its route becomes usable and retains an explicit later deselection', async () => {
  missing = true;
  await mount();
  await act(async () => root.unmount());
  root = createRoot(host);
  missing = false;
  await mount();
  const checkbox = host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(checkbox.checked).toBe(true);
  await act(async () => checkbox.click());
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')?.checked).toBe(false);
});

it.each([
  { defaultModel: 'my-explicit-model', cliEffort: '' },
  { defaultModel: '', cliEffort: 'high' },
])('preserves an uncreated legacy DSH draft with explicit overrides $defaultModel/$cliEffort for manual confirmation', async (overrides) => {
  await mount();
  const key = 'cat-cafe:native-team-setup:v2:compact-recommendation';
  const draft = JSON.parse(localStorage.getItem(key)!);
  draft.partners[0].form = { ...draft.partners[0].form, ...overrides };
  const originalKey = draft.partners[0].creationRequestKey;
  const originalId = draft.partners[0].form.catId;
  localStorage.setItem(key, JSON.stringify(draft));
  await act(async () => root.unmount());
  root = createRoot(host);
  claudeReadiness = 'configured';
  vi.mocked(apiFetch).mockClear();
  await mount();
  const checkbox = host.querySelector<HTMLInputElement>('input[aria-label="加入 DSH 伙伴"]')!;
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.closest('details')).not.toBeNull();
  expect(host.textContent).toContain('已保留自定义设置');
  expect(host.textContent).toContain(overrides.defaultModel || overrides.cliEffort);
  const restored = JSON.parse(localStorage.getItem(key)!).partners.find(
    (partner: { form: { catId: string } }) => partner.form.catId === originalId,
  );
  expect(restored.creationRequestKey).toBe(originalKey);
  expect(restored.form).toMatchObject({ ...overrides, catId: originalId });
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method)).toBe(false);
  expect(host.querySelector('fieldset, select')).toBeNull();
  await act(async () => create().click());
  const posts = vi
    .mocked(apiFetch)
    .mock.calls.filter(([path, init]) => path === '/api/cats' && init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0][1]?.body)).clientId).toBe('anthropic');
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => path.endsWith('/prepare'))).toBe(false);
});
