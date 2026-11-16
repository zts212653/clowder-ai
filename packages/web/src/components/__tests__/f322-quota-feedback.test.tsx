import type { AccountQuotaObservation } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodexQuotaControl } from '../codex-accounts/CodexQuotaControl';
import { quotaQueryTime } from '../codex-accounts/QuotaQueryFeedback';
import { writeShellLanguage } from '../shell/shell-language';

const request = vi.hoisted(() => vi.fn());
vi.mock('../codex-accounts/account-request', () => ({ accountRequest: request }));
const failed = {
  observedAt: Date.now(),
  source: 'codex_official_readonly' as const,
  status: 'unavailable' as const,
  items: [],
  credentialVersion: 'old',
  failure: { kind: 'renewal_required' as const, officialDetail: 'HTTP 401: expired token' },
  error: '登录凭据已过期，请让官方 Codex 完成续期后再查询',
};
const good = {
  ...failed,
  status: 'ok' as const,
  failure: undefined,
  error: undefined,
  items: [{ label: '每周使用限额', usedPercent: 100 }],
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  vi.unstubAllGlobals();
});
const render = async (observation: AccountQuotaObservation = failed, extra = {}) => {
  await act(async () =>
    root.render(
      <CodexQuotaControl accountRef="feedback-test" observation={observation} reload={async () => {}} {...extra} />,
    ),
  );
};
const click = async (name: string) => {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(name));
  if (!b) throw Error(`Missing ${name}`);
  await act(async () => b.click());
};
const nativeIdentity = (userId: string) => ({ userId, workspaceId: `workspace-${userId}` });
const nativeQuota = (userId: string, usedPercent: number): AccountQuotaObservation => ({
  ...good,
  observedAt: good.observedAt + usedPercent,
  owner: { accountRef: 'codex', ...nativeIdentity(userId) },
  items: [{ label: '每周使用限额', usedPercent }],
});
const refresh = async () => {
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh quota"]');
  expect(button).not.toBeNull();
  await act(async () => button?.click());
};
it('clears the old native reading and reloads identity when a same-page query returns another owner', async () => {
  const reload = vi.fn(async () => {});
  const next = nativeQuota('B', 80);
  request.mockResolvedValueOnce({ quota: next });
  await render(nativeQuota('A', 30), { accountRef: 'codex', identity: nativeIdentity('A'), reload });
  expect(host.textContent).toContain('70% left');
  await refresh();
  expect(reload).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(host.textContent).not.toContain('70% left');
  expect(host.textContent).not.toContain('20% left');
  expect(host.textContent).toContain('The account sign-in changed. Check again.');
  await render(next, { accountRef: 'codex', identity: nativeIdentity('B'), reload });
  expect(host.textContent).toContain('20% left');
  expect(host.textContent).not.toContain('The account sign-in changed. Check again.');
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([
  'success',
  'conflict',
] as const)('ignores a late %s from the previous identity after a newer query', async (outcome) => {
  let finish: (value: { quota: AccountQuotaObservation }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  request.mockReturnValueOnce(
    new Promise<{ quota: AccountQuotaObservation }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }),
  );
  const reload = vi.fn(async () => {});
  await render(nativeQuota('A', 30), { accountRef: 'codex', identity: nativeIdentity('A'), reload });
  await refresh();
  const next = nativeQuota('B', 80);
  request.mockResolvedValueOnce({ quota: next });
  await render(next, { accountRef: 'codex', identity: nativeIdentity('B'), reload });
  await refresh();
  await act(async () => {
    if (outcome === 'success') finish({ quota: nativeQuota('A', 90) });
    else fail(Object.assign(new Error('old account changed'), { status: 409 }));
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('20% left');
  expect(host.textContent).not.toContain('70% left');
  expect(host.textContent).not.toContain('The account sign-in changed. Check again.');
});
it('shows a quota conflict, reloads once, and clears the message after an explicit successful retry', async () => {
  const reload = vi.fn(async () => {});
  request.mockRejectedValueOnce(Object.assign(new Error('account changed'), { status: 409 }));
  await render(good, { reload });
  const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh quota"]')!;
  expect(refresh).not.toBeNull();
  await act(async () => refresh.click());
  expect(host.textContent).toContain('The account sign-in changed. Check again.');
  expect(host.textContent).not.toContain('0% left');
  expect(reload).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce({ quota: good });
  await click('Check quota');
  expect(host.textContent).not.toContain('The account sign-in changed. Check again.');
  expect(request).toHaveBeenCalledTimes(2);
});
it('shows a storage failure as unavailable instead of saying the account changed', async () => {
  const reload = vi.fn(async () => {});
  request.mockRejectedValueOnce(Object.assign(new Error('无法读取账号，请核对账号配置'), { status: 500 }));
  await render(good, { reload });
  const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh quota"]')!;
  await act(async () => refresh.click());
  expect(host.querySelector('.account-quota-failure')?.getAttribute('data-kind')).toBe('service_unreachable');
  expect(host.textContent).not.toContain('The account sign-in changed. Check again.');
  expect(request).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});
it('shows historical renewal and the next step visibly, with official details available by click', async () => {
  await render();
  expect(host.textContent).toContain('Sign-in needs renewal');
  expect(host.textContent).toContain('without calling a model');
  expect(host.querySelector('.sr-only')?.textContent ?? '').not.toContain('expired');
  await click('Sign-in needs renewal');
  expect(document.body.textContent).toContain('HTTP 401: expired token');
  expect(request).not.toHaveBeenCalled();
});
it('automatically retries a rotated credential once and clears the old failure on success', async () => {
  request.mockResolvedValue({ quota: good });
  await render({ ...failed, renewedCredentialVersion: 'rotated-success' });
  expect(request).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('0% left');
  expect(host.textContent).not.toContain('Sign-in needs renewal');
  await render({ ...failed, renewedCredentialVersion: 'rotated-success' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('does not loop after auto retry fails, but allows a later credential rotation', async () => {
  request.mockResolvedValue({ quota: { ...failed, credentialVersion: 'rotated-fail' } });
  await render({ ...failed, renewedCredentialVersion: 'rotated-fail' });
  await render({ ...failed, renewedCredentialVersion: 'rotated-fail' });
  expect(request).toHaveBeenCalledTimes(1);
  await render({ ...failed, renewedCredentialVersion: 'rotated-again' });
  expect(request).toHaveBeenCalledTimes(2);
});
it('keeps a persisted successful reading across reload and shows the failed refresh reason', async () => {
  await render({ ...failed, lastSuccess: { observedAt: failed.observedAt - 60000, items: good.items } });
  expect(host.textContent).toContain('0% left');
  expect(host.textContent).toContain('Refresh failed');
  expect(host.textContent).toContain('Sign-in needs renewal');
});
it('network failures state that the sign-in is not the problem', async () => {
  await render({ ...failed, failure: { kind: 'service_unreachable' }, error: 'offline' });
  expect(host.textContent).toContain("Couldn't reach the quota service");
  expect(host.textContent).toContain('not a problem with this sign-in');
  expect(host.textContent).not.toContain('renewal');
});
it('uses the existing relogin action for managed accounts and an App instruction for the default', async () => {
  const onRelogin = vi.fn();
  await render({ ...failed, failure: { kind: 'signin_required' } }, { onRelogin });
  await click('Sign in again ›');
  expect(onRelogin).toHaveBeenCalledTimes(1);
  await render({ ...failed, failure: { kind: 'signin_required' } });
  expect(host.textContent).toContain('Sign in again in Codex App');
});

it('does not repeat a successful manual query when an old rotation notice arrives while it is pending', async () => {
  let finish: (value: unknown) => void = () => {};
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await click('Check again');
  await render({ ...failed, renewedCredentialVersion: 'manual-rotated' });
  await act(async () =>
    finish({ quota: { ...good, observedAt: failed.observedAt + 1, credentialVersion: 'manual-rotated' } }),
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('0% left');
});

it('distinguishes today from a previous day without adding seconds or using hour 24', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2030, 9, 22, 0, 2).getTime());
  try {
    expect(quotaQueryTime(new Date(2030, 9, 21, 23, 17).getTime(), 'en')).toBe('10/21 23:17');
    expect(quotaQueryTime(new Date(2030, 9, 22, 0, 1).getTime(), 'zh')).toBe('00:01');
  } finally {
    clock.mockRestore();
  }
});
