import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HubAccountsTab } from '../HubAccountsTab';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
const native = {
  id: 'codex',
  displayName: 'Codex App 登录（本机默认）',
  name: 'Codex',
  clientId: 'openai',
  authType: 'oauth',
  builtin: true,
  hasApiKey: false,
  codexLoginStatus: 'ready',
};
const backup = {
  ...native,
  id: 'backup',
  displayName: '主号',
  builtin: false,
  codex: {
    status: 'ready',
    prepared: true,
    identity: { email: 'fixture@example.test', userId: 'u', workspaceId: 'w' },
  },
};
const member = {
  id: 'sol',
  name: '小太阳',
  avatar: '/avatars/codex.png',
  accountRef: 'codex',
  available: true,
  bindingMode: 'follow',
};
const fixture = () => {
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).includes('/codex/members'))
      return Response.json({
        members: [member],
        selection: { state: 'consensus', accountRef: 'codex', members: [member] },
      });
    if (init?.method === 'POST')
      return Response.json({
        previewToken: 'a'.repeat(64),
        accountRef: 'backup',
        targets: [{ catId: 'sol', name: '小太阳', previousAccountRef: 'codex' }],
        exceptions: [],
      });
    return Response.json({
      projectPath: '/fixture',
      providers: [native, backup],
      unavailableAccounts: [{ accountRef: 'broken', reason: '真实冲突原因' }],
    });
  });
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.clearAllMocks();
});
async function render() {
  fixture();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<HubAccountsTab />));
}
it('shows one OAuth table, distinguishes logged-in backup from the used default, and searches cat names', async () => {
  await render();
  expect(host.querySelector('[data-account-id="codex"]')?.textContent).toContain('正在用');
  expect(host.querySelector('[data-account-id="backup"]')?.textContent).toContain('已登录');
  expect(host.querySelector('[data-account-id="backup"]')?.textContent).not.toContain('正在用');
  expect(host.textContent).not.toContain('当前绑定');
  expect(host.querySelectorAll('table')).toHaveLength(1);
  const search = host.querySelector<HTMLInputElement>('input[aria-label="搜索账户或成员"]')!;
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '小太阳');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host.querySelector('[data-account-id="codex"]')).not.toBeNull();
  expect(host.querySelector('[data-account-id="backup"]')).toBeNull();
});
it('uses local atomic preview, requires confirmation, and collapses rejected configuration reasons', async () => {
  await render();
  expect(host.textContent).not.toContain('真实冲突原因');
  const change = [...host.querySelectorAll('button')].find((b) => b.textContent === '换成这个')!;
  expect(change).not.toBeUndefined();
  await act(async () => change.click());
  const posts = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0][1]?.body)).scope).toBe('local');
  expect(host.textContent).toContain('从下一次调用起生效');
  expect(host.textContent).toContain('本机默认登录不受影响');
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '确认换号')).toBe(true);
});

it('re-previews included exceptions without duplicating their owner and keeps the toggle reversible', async () => {
  fixture();
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  const exception = { catId: 'astra', name: '小星星', previousAccountRef: 'other', previousAccountName: '公司号' };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/binding/preview')) {
      const included = JSON.parse(String(init?.body)).includeOverrides;
      return Response.json({
        previewToken: included ? 'b'.repeat(64) : 'a'.repeat(64),
        accountRef: 'backup',
        targets: [{ catId: 'sol', name: '小太阳', previousAccountRef: 'codex' }, ...(included ? [exception] : [])],
        exceptions: included ? [] : [exception],
      });
    }
    if (String(path).endsWith('/binding/commit'))
      return Response.json({ selection: { state: 'selected', accountRef: 'backup', members: [] } });
    return base(path, init);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<HubAccountsTab />));
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '换成这个')!.click());
  expect(host.textContent).toContain('公司号');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(host.textContent).toContain('会跟着换的 2 只');
  expect(host.textContent!.match(/小星星/g)).toHaveLength(1);
  expect(host.textContent).not.toContain('现在用别的号的');
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(host.textContent).toContain('现在用别的号的 1 只');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '确认换号')!.click());
  const request = vi.mocked(apiFetch).mock.calls.find(([path]) => String(path).endsWith('/binding/commit'))!;
  expect(JSON.parse(String(request[1]?.body))).toMatchObject({ includeOverrides: true, previewToken: 'b'.repeat(64) });
});
