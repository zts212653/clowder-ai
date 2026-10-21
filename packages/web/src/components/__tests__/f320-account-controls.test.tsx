import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { AccountDirectoryRow } from '../accounts/AccountDirectoryRow';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import { MemberCodexAccount } from '../codex-accounts/MemberCodexAccount';
import type { ProfileItem } from '../hub-accounts.types';

const request = vi.hoisted(() => vi.fn());
vi.mock('../codex-accounts/account-request', () => ({ accountRequest: request }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
const managed = (ready = false): ProfileItem => ({
  id: 'backup',
  name: '主号',
  displayName: '主号',
  authType: 'oauth',
  kind: 'oauth',
  builtin: false,
  mode: 'subscription',
  clientId: 'openai',
  hasApiKey: false,
  createdAt: '',
  updatedAt: '',
  codex: {
    kind: 'managed',
    layoutVersion: 1,
    prepared: true,
    credentialHome: '/fixture/b',
    stateRoot: '/fixture/shared',
    sqliteHome: '/fixture/shared',
    status: ready ? 'ready' : 'not_logged_in',
    ...(ready ? { identity: { userId: 'u', workspaceId: 'w', email: 'fixture@example.test' } } : {}),
  },
});
const cat: CatData = {
  carrier: 'cli',
  id: 'sol',
  displayName: '小太阳',
  clientId: 'openai',
  cli: { command: 'codex' },
  accountRef: 'backup',
  defaultModel: 'fixture',
  color: { primary: '#123456', secondary: '#abcdef' },
  mentionPatterns: [],
  avatar: '/avatars/codex.png',
  roleDescription: 'fixture',
  personality: 'fixture',
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  request.mockReset();
  request.mockResolvedValue({});
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  await act(async () => {
    const b = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
    expect(b).toBeTruthy();
    b!.click();
  });
}
function Row({ profile, bound = false }: { profile: ProfileItem; bound?: boolean }) {
  const [account, setAccount] = useState(profile);
  return (
    <table>
      <tbody>
        <AccountDirectoryRow
          account={account}
          accounts={[account]}
          members={bound ? [{ id: 'sol', name: '小太阳', accountRef: account.id, available: true }] : []}
          used={false}
          provider="Codex"
          refresh={() => new Promise(() => {})}
          update={(profiles) => {
            if (profiles[0]) setAccount(profiles[0]);
          }}
          onSwitch={() => {}}
          onEdit={() => {}}
        />
      </tbody>
    </table>
  );
}
it('quota preserves remaining percentage/reset and publishes the response even with a hung list', async () => {
  request.mockResolvedValue({
    quota: {
      observedAt: 1,
      source: 'codex_official_readonly',
      status: 'ok',
      items: [{ label: '额度', usedPercent: 30, percentKind: 'remaining', resetsAt: '2030-01-02T03:04:05Z' }],
    },
  });
  await act(async () => root.render(<CodexQuotaControl accountRef="backup" reload={() => new Promise(() => {})} />));
  await click('查额度');
  expect(host.textContent).toContain('剩 30%');
  expect(host.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('30');
  expect([...host.querySelectorAll('button')][0].disabled).toBe(false);
});
it('quota controls hide prior identity values and reject a late result after same-ref identity changes', async () => {
  const owner = { accountRef: 'backup', userId: 'user-a', workspaceId: 'workspace-a' };
  const observation = {
    owner,
    observedAt: 1,
    source: 'codex_official_readonly' as const,
    status: 'ok' as const,
    items: [{ label: 'A额度', usedPercent: 99 }],
  };
  let finish: (value: { quota: typeof observation }) => void = () => {};
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const reload = () => Promise.resolve();
  await act(async () =>
    root.render(
      <CodexQuotaControl accountRef="backup" managed identity={owner} observation={observation} reload={reload} />,
    ),
  );
  expect(host.textContent).toContain('A额度');
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="刷新额度"]')?.click());
  await act(async () =>
    root.render(
      <CodexQuotaControl
        accountRef="backup"
        managed
        identity={{ userId: 'user-b', workspaceId: 'workspace-b' }}
        observation={observation}
        reload={reload}
      />,
    ),
  );
  expect(host.textContent).not.toContain('A额度');
  await act(async () => finish({ quota: observation }));
  expect(host.textContent).not.toContain('A额度');
  expect(host.textContent).toContain('账号登录已变化');
});
it('row retry uses immediate mutation state while GET never settles', async () => {
  const profile = managed();
  const waiting = {
    ...profile,
    codex: {
      ...profile.codex!,
      attempt: {
        id: 'a',
        revision: 1,
        ownerBootId: 'b',
        ownerPid: 1,
        ownerStartedAt: 'fixture',
        credentialHome: '/fixture/attempt',
        createdAt: 1,
        updatedAt: 1,
        state: 'waiting' as const,
      },
    },
  };
  request.mockResolvedValue({ profiles: [waiting] });
  await act(async () => root.render(<Row profile={profile} />));
  await click('重试');
  expect(host.textContent).toContain('终端已打开');
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '取消' && !b.disabled)).toBe(true);
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '重试')).toBe(false);
});
it('relogin failure keeps ready identity and offers retry without destroying the used login', async () => {
  const profile = managed(true);
  profile.codex = {
    ...profile.codex!,
    attempt: {
      id: 'a',
      revision: 1,
      ownerBootId: 'b',
      ownerPid: 1,
      ownerStartedAt: 'fixture',
      credentialHome: '/fixture/attempt',
      createdAt: 1,
      updatedAt: 1,
      state: 'failed',
      error: '终端没能启动',
    },
  };
  await act(async () => root.render(<Row profile={profile} />));
  expect(host.textContent).toContain('已登录');
  expect(host.textContent).toContain('上次重新登录没成功');
  expect([...host.querySelectorAll('button')].some((b) => b.textContent === '重试')).toBe(true);
});
it('bound active deletion stays disabled and never cancels the login', async () => {
  const profile = managed();
  profile.codex = {
    ...profile.codex!,
    attempt: {
      id: 'a',
      revision: 1,
      ownerBootId: 'b',
      ownerPid: 1,
      ownerStartedAt: 'fixture',
      credentialHome: '/fixture/attempt',
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting',
    },
  };
  await act(async () => root.render(<Row profile={profile} bound />));
  const del = [...host.querySelectorAll('button')].find((b) => b.textContent === '删除登记')!;
  expect(del.disabled).toBe(true);
  await act(async () => del.click());
  expect(request).not.toHaveBeenCalled();
  expect(host.textContent).toContain('先换走');
});
it('duplicate identity deletes only the extra record and offers no binding mutation', async () => {
  const profile = managed();
  profile.codex = {
    ...profile.codex!,
    attempt: {
      id: 'a',
      revision: 1,
      ownerBootId: 'b',
      ownerPid: 1,
      ownerStartedAt: 'fixture',
      credentialHome: '/fixture/attempt',
      createdAt: 1,
      updatedAt: 1,
      state: 'review',
      duplicateAccountRef: 'existing',
      identity: { userId: 'u', workspaceId: 'w' },
    },
  };
  const duplicate = { ...managed(true), id: 'existing', displayName: '已有主号' };
  const update = vi.fn();
  await act(async () =>
    root.render(
      <table>
        <tbody>
          <AccountDirectoryRow
            account={profile}
            accounts={[profile, duplicate]}
            members={[]}
            used={false}
            provider="Codex"
            refresh={async () => {}}
            update={update}
            onSwitch={vi.fn()}
            onEdit={vi.fn()}
          />
        </tbody>
      </table>,
    ),
  );
  await click('去处理');
  await click('删掉这条，回到已有主号');
  expect(request).toHaveBeenCalledWith('/api/accounts/backup', {}, 'DELETE');
  expect(update).toHaveBeenCalledWith([], ['backup']);
  expect(request).toHaveBeenCalledTimes(1);
});
it('native row has no managed-login or delete actions and unreadable identity cannot open quota', async () => {
  const profile = {
    ...managed(),
    id: 'codex',
    builtin: true,
    codex: undefined,
    codexLoginStatus: 'unreadable' as const,
  };
  await act(async () => root.render(<Row profile={profile} />));
  expect(host.textContent).toContain('读不到');
  expect(host.textContent).not.toContain('重新登录');
  expect(host.textContent).not.toContain('删除登记');
  await click('主号');
  expect(host.textContent).not.toContain('查询此账号额度');
});
it('member table is read-only, follows changed bindings, and disambiguates equal notes', async () => {
  const a = managed(true),
    b = {
      ...managed(true),
      id: 'B',
      codex: { ...managed(true).codex!, identity: { userId: 'u2', workspaceId: 'w2', email: 'second@example.test' } },
    };
  await act(async () => root.render(<MemberCodexAccount cat={cat} accounts={[a, b]} />));
  expect(host.textContent).toContain('fixture@example.test');
  await act(async () =>
    root.render(
      <MemberCodexAccount cat={{ ...cat, accountRef: 'B', accountBindingMode: 'override' }} accounts={[a, b]} />,
    ),
  );
  expect(host.textContent).toContain('second@example.test');
  expect(host.textContent).toContain('单独指定');
  expect(host.querySelector('select')).toBeNull();
  expect(host.querySelector('button')).toBeNull();
});
