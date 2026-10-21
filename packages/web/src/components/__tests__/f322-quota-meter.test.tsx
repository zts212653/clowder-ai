import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountDirectoryRow } from '../accounts/AccountDirectoryRow';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import type { ProfileItem } from '../hub-accounts.types';
import { writeShellLanguage } from '../shell/shell-language';

const request = vi.hoisted(() => vi.fn());
vi.mock('../codex-accounts/account-request', () => ({ accountRequest: request }));
vi.mock('../useConfirm', () => ({ useConfirm: () => async () => true }));
const observation = {
  observedAt: Date.parse('2030-01-01T01:35:00Z'),
  source: 'codex_official_readonly' as const,
  status: 'ok' as const,
  items: [
    { label: '5小时使用限额', usedPercent: 18, resetsAt: '2030-01-01T04:35:00Z' },
    { label: '每周使用限额', usedPercent: 88, resetsAt: '2030-01-03T01:35:00Z' },
  ],
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T01:35:00Z'));
  writeShellLanguage('en');
  request.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  writeShellLanguage('zh');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) => {
  const node = [...host.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') ?? b.textContent)?.includes(name),
  );
  if (!node) throw Error(`Missing ${name}`);
  return node;
};
it('keeps both windows visible while refreshing and after an unavailable response, then retries', async () => {
  let finish: (value: unknown) => void = () => {};
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const reload = vi.fn(async () => {});
  await act(async () =>
    root.render(<CodexQuotaControl accountRef="codex" observation={observation} reload={reload} />),
  );
  expect(host.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(host.textContent).toContain('82% left');
  expect(host.textContent).toContain('12% left');
  expect(host.textContent).toContain('Near limit');
  expect(host.textContent).toContain('Resets in 2 days');
  await act(async () => button('Refresh quota').click());
  expect(button('Refresh quota').disabled).toBe(true);
  expect(host.querySelectorAll('[role="meter"]')).toHaveLength(2);
  await act(async () =>
    finish({ quota: { ...observation, status: 'unavailable', items: [], error: 'fixture offline' } }),
  );
  expect(host.textContent).toContain('Refresh failed');
  expect(host.textContent).toContain('82% left');
  request.mockResolvedValue({ quota: { ...observation, items: [{ label: '每周使用限额', usedPercent: 54 }] } });
  await act(async () => button('Retry').click());
  expect(host.textContent).toContain('46% left');
  expect(host.textContent).not.toContain('Refresh failed');
});
it('offers a first query and an honest retry without manufacturing a zero meter', async () => {
  request.mockRejectedValue(new Error('fixture offline'));
  await act(async () => root.render(<CodexQuotaControl accountRef="codex" reload={async () => {}} />));
  expect(host.querySelector('[role="meter"]')).toBeNull();
  await act(async () => button('Check quota').click());
  expect(host.textContent).toContain('Quota unavailable');
  expect(host.querySelector('[role="meter"]')).toBeNull();
  expect(button('Retry').disabled).toBe(false);
});
it.each([
  'openai',
  'anthropic',
] as const)('places quota in the closed %s row without duplicating it in details', async (clientId) => {
  const account = {
    id: clientId === 'openai' ? 'codex' : 'claude',
    name: 'Fixture',
    displayName: 'Fixture',
    clientId,
    builtin: true,
    authType: 'oauth',
    codexLoginStatus: 'ready',
    quota: observation,
    kind: 'builtin',
    mode: 'subscription',
    hasApiKey: false,
    createdAt: '',
    updatedAt: '',
  } satisfies ProfileItem;
  await act(async () =>
    root.render(
      <table>
        <tbody>
          <AccountDirectoryRow
            account={account}
            accounts={[account]}
            members={[]}
            used
            provider="Fixture"
            refresh={async () => {}}
            update={vi.fn()}
            onSwitch={vi.fn()}
            onEdit={vi.fn()}
          />
        </tbody>
      </table>,
    ),
  );
  expect(host.querySelector('tr')?.children).toHaveLength(6);
  expect(host.querySelector('.account-expanded')).toBeNull();
  if (clientId === 'openai') expect(host.querySelectorAll('[role="meter"]')).toHaveLength(2);
  else {
    expect(host.textContent).toContain('No quota API for this provider');
    expect(host.querySelector('[role="meter"]')).toBeNull();
  }
  await act(async () => button('Fixture').click());
  expect(host.querySelector('.account-expanded [role="meter"]')).toBeNull();
  expect(host.querySelector('.account-expanded')?.textContent).toContain('Members using this account');
});

it.each(['zh', 'en'] as const)('shows month/day and minute precision in the %s refresh tooltip', async (language) => {
  writeShellLanguage(language);
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) {
    return selector === ':focus-visible' || matches.call(this, selector);
  });
  const observedAt = new Date(2030, 9, 21, 2, 49, 17).getTime();
  await act(async () =>
    root.render(
      <CodexQuotaControl accountRef="codex" observation={{ ...observation, observedAt }} reload={async () => {}} />,
    ),
  );
  await act(async () => button(language === 'zh' ? '刷新额度' : 'Refresh quota').focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
    language === 'zh' ? '刷新额度 · 上次 10/21 02:49' : 'Refresh quota · Last checked 10/21 02:49',
  );
});
