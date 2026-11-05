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
