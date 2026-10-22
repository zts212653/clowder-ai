import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AccountDirectoryRow } from '../accounts/AccountDirectoryRow';
import { nextQuotaAccount } from '../codex-accounts/quota-state';
import type { ProfileItem } from '../hub-accounts.types';
import { writeShellLanguage } from '../shell/shell-language';

const fixture = (id: string, left: number): ProfileItem => ({
  id,
  name: id,
  displayName: id,
  authType: 'oauth',
  builtin: false,
  kind: 'oauth',
  mode: 'subscription',
  hasApiKey: false,
  clientId: 'openai',
  createdAt: '',
  updatedAt: '',
  codex: {
    kind: 'managed',
    layoutVersion: 1,
    credentialHome: '/fixture/' + id,
    stateRoot: '/fixture/shared',
    sqliteHome: '/fixture/shared',
    prepared: true,
    status: 'ready',
    identity: { userId: id, workspaceId: 'fixture' },
  },
  quota: {
    owner: { accountRef: id, userId: id, workspaceId: 'fixture' },
    status: 'ok',
    source: 'codex_official_readonly',
    observedAt: Date.now(),
    items: [{ label: 'Week', usedPercent: 100 - left }],
  },
});
it('recommends the greatest usable minimum across windows and excludes unavailable or mismatched identities', () => {
  const used = fixture('used', 0),
    main = fixture('main', 90),
    partial = fixture('partial', 95),
    mismatch = fixture('mismatch', 100),
    unavailable = fixture('unavailable', 100);
  partial.quota = { ...partial.quota!, items: [...partial.quota!.items, { label: '5h', usedPercent: 60 }] };
  mismatch.quota = { ...mismatch.quota!, owner: { accountRef: 'mismatch', userId: 'other', workspaceId: 'other' } };
  unavailable.quota = { ...unavailable.quota!, status: 'unavailable' };
  expect(nextQuotaAccount(used, [used, partial, unavailable, mismatch, main])?.account.id).toBe('main');
  expect(nextQuotaAccount(fixture('healthy', 20), [main])).toBeUndefined();
  expect(nextQuotaAccount(used, [unavailable, mismatch, used])).toBeUndefined();
});
it('routes the in-use row switch action to the suggested account through the existing switch callback', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('en');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const used = fixture('used', 0),
    main = fixture('Main', 90),
    onSwitch = vi.fn();
  try {
    await act(async () =>
      root.render(
        <table>
          <tbody>
            <AccountDirectoryRow
              account={used}
              accounts={[used, main]}
              members={[]}
              used
              provider="Codex"
              refresh={async () => {}}
              update={vi.fn()}
              onSwitch={onSwitch}
              onEdit={vi.fn()}
            />
          </tbody>
        </table>,
      ),
    );
    expect(host.textContent).toContain('Used up · Switch to Main (90% left)');
    const button = [...host.querySelectorAll('button')].find((x) => x.textContent === 'Use account');
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(onSwitch).toHaveBeenCalledWith(main);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    writeShellLanguage('zh');
    vi.unstubAllGlobals();
  }
});
