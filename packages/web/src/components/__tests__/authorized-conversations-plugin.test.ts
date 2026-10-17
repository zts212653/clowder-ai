import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { authorizedCandidates, fetchAuthorizedConversations } from '../authorized-conversations';
import { projectPersonalChromeRecoveryStatus } from '../cloud-binding-recovery-status';

const fetch = vi.mocked(apiFetch);
const base = '/api/plugins/official.companion.personal-chrome/actions/personalChromeAuthorizations/';
const json = (data: unknown, render = 'status') => new Response(JSON.stringify({ ok: true, render, data }));
afterEach(() => vi.resetAllMocks());

it('uses package row keys, preserves order and accepts missing dates without inventing them', () => {
  expect(
    authorizedCandidates([
      { key: 'b', label: 'Readable title', detail: 'https://evil.test' },
      { key: 'a', label: 'a' },
      { key: 'b', label: 'duplicate' },
      { key: '../unsafe', label: 'bad' },
      { key: 'c', label: '\u202eunsafe' },
    ]),
  ).toEqual([
    { conversationId: 'b', chatUrl: 'https://chatgpt.com/c/b', displayTitle: 'Readable title' },
    { conversationId: 'a', chatUrl: 'https://chatgpt.com/c/a' },
    { conversationId: 'c', chatUrl: 'https://chatgpt.com/c/c' },
  ]);
});

it('refreshes titles before listing, and successful refresh does not clear reloadRequired', async () => {
  fetch.mockImplementation(async (path) => {
    if (path === `${base}refresh-titles`)
      return json({ titleSync: { status: 'synced', updatedCount: 1, requestedCount: 1 } });
    if (path === `${base}list`) return json({ rows: [{ key: 'a', label: 'New title' }] }, 'rows');
    if (path === `${base}status`)
      return json({ status: 'ready', helper: { state: 'connected' }, delivery: { reloadRequired: true } });
    throw new Error(path);
  });
  const result = await fetchAuthorizedConversations(new AbortController().signal, { syncTitles: true });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([`${base}refresh-titles`, `${base}list`, `${base}status`]);
  expect(fetch.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
  expect(result.candidates[0].displayTitle).toBe('New title');
  expect(projectPersonalChromeRecoveryStatus(result.body)).toEqual({
    connectionIssue: expect.stringContaining('重载'),
    titleSyncMessage: expect.stringContaining('已同步 1'),
  });
});

it('status read failure keeps authorizations and never claims a connection problem', async () => {
  fetch.mockImplementation(async (path) => {
    if (path === `${base}list`) return json({ rows: [{ key: 'a', label: 'a' }] }, 'rows');
    throw new TypeError('offline');
  });
  const result = await fetchAuthorizedConversations(new AbortController().signal);
  expect(result.candidates).toHaveLength(1);
  expect(projectPersonalChromeRecoveryStatus(result.body)).toEqual({});
});

it.each([
  { ok: false, render: 'status', label: 'Unavailable' },
  { ok: true, render: 'rows', data: {} },
  null,
])('does not turn an unreadable successful HTTP response into an empty authorization list: %j', async (body) => {
  fetch.mockResolvedValue(new Response(JSON.stringify(body)));
  await expect(fetchAuthorizedConversations(new AbortController().signal)).rejects.toThrow('authorization list');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('lost refresh response still reads authorization and reports unknown refresh outcome', async () => {
  fetch.mockImplementation(async (path) => {
    if (path === `${base}refresh-titles`) throw new TypeError('response lost');
    if (path === `${base}list`) return json({ rows: [{ key: 'a', label: 'a' }] }, 'rows');
    return new Response('', { status: 503 });
  });
  const result = await fetchAuthorizedConversations(new AbortController().signal, { syncTitles: true });
  expect(result.candidates).toHaveLength(1);
  expect(result.body.titleSync).toEqual({ status: 'unavailable', errorCode: 'AMBIGUOUS_EFFECT' });
  expect(result.body.status).toBeUndefined();
});

it.each([
  [{ helper: { state: 'not_installed' }, delivery: { reloadRequired: true } }, '尚未就绪'],
  [{ helper: { state: 'invalid_installation' } }, '需要更新'],
  [{ helper: { state: 'connected' }, delivery: { failure: 'PERMISSION_DENIED' } }, '需要更新'],
  [{ helper: { state: 'unreachable' }, delivery: { reloadRequired: true } }, '重载'],
  [{ helper: { state: 'unreachable' } }, '无法连接'],
  [{ status: 'ready', helper: { state: 'unknown' } }, undefined],
  [{ status: 'ready', helper: { state: 'connected' }, delivery: { failure: 'INSTALLATION_BUSY' } }, undefined],
])('maps package status without treating ready as connected: %j', (status, text) => {
  const issue = projectPersonalChromeRecoveryStatus({ status }).connectionIssue;
  if (text) expect(issue).toContain(text);
  else expect(issue).toBeUndefined();
});
