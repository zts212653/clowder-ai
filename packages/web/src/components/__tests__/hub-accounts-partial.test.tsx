import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { HubAccountsTab } from '../HubAccountsTab';
import type { ProfileItem } from '../hub-accounts.types';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [] }) }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../UnifiedAuthModal', () => ({
  UnifiedAuthModal: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (id: string, error: string, profile: ProfileItem) => void;
  }) => (open ? <button onClick={() => onCreated(created.id, '网络请求超时', created)}>fixture create</button> : null),
}));
const created: ProfileItem = {
  id: 'retry',
  name: '私人',
  displayName: '私人',
  clientId: 'openai',
  authType: 'oauth',
  kind: 'oauth',
  builtin: false,
  hasApiKey: false,
  mode: 'subscription',
  createdAt: '',
  updatedAt: '',
  codex: {
    kind: 'managed',
    layoutVersion: 1,
    prepared: true,
    credentialHome: '/fixture/private',
    stateRoot: '/fixture/shared',
    sqliteHome: '/fixture/shared',
    status: 'not_logged_in',
  },
};
const waiting: ProfileItem = {
  ...created,
  codex: {
    ...created.codex!,
    attempt: {
      id: 'attempt',
      revision: 1,
      ownerBootId: 'boot',
      ownerPid: 1,
      ownerStartedAt: 'fixture',
      credentialHome: '/fixture/attempt',
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting',
    },
  },
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(apiFetch).mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const list = (providers: ProfileItem[]) => Response.json({ projectPath: '/fixture', providers });
const members = () => Response.json({ selection: { state: 'empty', members: [] } });
async function click(label: string) {
  await act(async () => {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(button).toBeTruthy();
    button!.click();
  });
}
it('healthy rows remain usable with rejected configuration collapsed and no quota for unlogged defaults', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    String(path).endsWith('/members')
      ? members()
      : Response.json({
          projectPath: '/fixture',
          providers: [
            created,
            {
              id: 'codex',
              displayName: '本机默认登录',
              name: 'Codex',
              clientId: 'openai',
              authType: 'oauth',
              builtin: true,
              hasApiKey: false,
              codexLoginStatus: 'not_logged_in',
            },
          ],
          unavailableAccounts: [{ accountRef: 'broken', reason: '真实冲突原因' }],
        }),
  );
  await act(async () => root.render(<HubAccountsTab />));
  expect(host.textContent).toContain('私人');
  expect(host.textContent).toContain('没登录');
  expect(host.textContent).not.toContain('查询此账号额度');
  expect(host.textContent).not.toContain('真实冲突原因');
  await click('1 个用不了的旧账号 ⌄');
  expect(host.textContent).toContain('真实冲突原因');
});
it('retry and cancel publish mutation results and polling before a list refresh that never settles', async () => {
  let get = 0;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/members')) return members();
    if (init?.method === 'POST')
      return Response.json({
        profiles: [
          String(path).endsWith('/start')
            ? waiting
            : { ...created, codex: { ...created.codex!, attempt: { ...waiting.codex!.attempt!, state: 'canceled' } } },
        ],
      });
    if (++get === 1) return list([]);
    return new Promise<Response>(() => {});
  });
  const polling = vi.spyOn(globalThis, 'setInterval');
  await act(async () => root.render(<HubAccountsTab />));
  await click('+ 添加账号');
  await click('Codex · 登录另一个账号');
  await click('fixture create');
  expect(host.textContent).toContain('网络请求超时');
  await click('重试');
  expect(host.textContent).toContain('终端已打开');
  expect(host.textContent).not.toContain('网络请求超时');
  expect(polling).toHaveBeenCalledWith(expect.any(Function), 2000);
  await click('取消');
  expect(host.textContent).toContain('已取消这次登录');
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '重试' && !b.disabled)).toBe(true);
});
for (const failure of ['reject', '503'])
  it(`stale ${failure} cannot erase a successful retry; current errors remain visible`, async () => {
    let get = 0,
      currentFails = false,
      failOld!: () => void;
    const old = new Promise<Response>((resolve, reject) => {
      failOld = () =>
        failure === '503'
          ? resolve(Response.json({ error: 'stale list failed' }, { status: 503 }))
          : reject(new Error('stale list failed'));
    });
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (String(path).endsWith('/members')) return members();
      if (init?.method === 'POST') return Response.json({ profiles: [waiting] });
      if (++get === 1) return list([]);
      if (get === 2) return old;
      return currentFails ? Response.json({ error: 'current list unavailable' }, { status: 503 }) : list([waiting]);
    });
    const interval = vi.spyOn(globalThis, 'setInterval');
    await act(async () => root.render(<HubAccountsTab />));
    await click('+ 添加账号');
    await click('Codex · 登录另一个账号');
    await click('fixture create');
    await click('重试');
    await act(async () => failOld());
    expect(host.textContent).not.toContain('stale list failed');
    expect(host.textContent).toContain('终端已打开');
    const polling = interval.mock.calls.findLast((call) => call[1] === 2000)?.[0];
    expect(typeof polling).toBe('function');
    currentFails = true;
    await act(async () => {
      if (typeof polling === 'function') polling();
    });
    expect(host.textContent).toContain('current list unavailable');
    currentFails = false;
    await act(async () => {
      if (typeof polling === 'function') polling();
    });
    expect(host.textContent).not.toContain('current list unavailable');
  });
