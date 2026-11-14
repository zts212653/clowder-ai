import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HubAccountsTab } from '../HubAccountsTab';
import type { ProfileItem } from '../hub-accounts.types';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('creates a Google OAuth row, refreshes official login readiness, and switches only after explicit confirmation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: () => {} });
  let account: ProfileItem | undefined;
  let ref = 'gemini';
  const member = () => ({ id: 'gemini38', name: 'Flash', accountRef: ref, available: true, bindingMode: 'follow' });
  const selection = () => ({ state: 'selected', accountRef: ref, members: [member()] });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = String(path);
    if (url.endsWith('/agy/members')) return Response.json({ selection: selection() });
    if (url.endsWith('/members')) return Response.json({ selection: { state: 'empty', members: [] } });
    if (url.endsWith('/binding/preview'))
      return Response.json({
        previewToken: 'a'.repeat(64),
        accountRef: account!.id,
        targets: [{ catId: 'gemini38', name: 'Flash', previousAccountRef: ref }],
        exceptions: [],
      });
    if (url.endsWith('/binding/commit')) {
      ref = account!.id;
      return Response.json({ selection: selection() });
    }
    if (init?.method === 'POST') {
      account = {
        id: 'agy-fixture',
        name: '公司',
        displayName: '公司',
        authType: 'oauth',
        kind: 'oauth',
        builtin: false,
        clientId: 'google',
        mode: 'subscription',
        hasApiKey: false,
        createdAt: '',
        updatedAt: '',
        agy: { storage: 'cli_file', credentialHome: '/fixture/agy' },
        agyLoginStatus: 'not_logged_in',
        agyLoginCommand: "pnpm --dir '/fixture' agy:account:login --home '/fixture/agy'",
      };
      return Response.json({ profile: account });
    }
    return Response.json({ providers: account ? [account] : [], projectPath: '/fixture' });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<HubAccountsTab />));
  const click = async (text: string) =>
    act(async () => {
      const button = [...document.querySelectorAll('button')].find((button) => button.textContent === text);
      expect(button).toBeTruthy();
      button!.click();
    });
  await click('+ 添加账号');
  await click('AGY · Google OAuth');
  const input = document.querySelector<HTMLInputElement>('dialog input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '公司');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('保存账号');
  expect(document.querySelector('dialog textarea')?.textContent).toContain('agy:account:login');
  expect(ref).toBe('gemini');
  const createCall = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(createCall[1]?.body))).toMatchObject({
    agyOAuth: true,
    clientId: 'google',
    authType: 'oauth',
  });
  account = { ...account!, agyLoginStatus: 'refreshable' };
  await click('刷新登录状态');
  expect(document.querySelector('dialog')?.textContent).toContain('登录文件已就绪');
  await click('关闭');
  await click('换成这个');
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).includes('/agy/binding/preview'))).toBe(true);
  expect(ref).toBe('gemini');
  await click('确认换号');
  expect(ref).toBe('agy-fixture');
  expect(host.querySelector('[data-account-id="agy-fixture"]')?.textContent).toContain('正在用');
});
