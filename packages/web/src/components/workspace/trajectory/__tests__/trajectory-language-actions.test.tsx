import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetSessionChainCacheForTest, SessionChainPanel } from '@/components/SessionChainPanel';
import { writeShellLanguage } from '@/components/shell/shell-language';

const mocks = vi.hoisted(() => ({ shell: 'v2', fetch: vi.fn() }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => mocks.shell }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], getCatById: () => undefined }) }));
vi.mock('@/components/CloudConversationLink', () => ({ CloudConversationLink: () => null }));

const sessions = [
  { id: 'live', cliSessionId: 'cli-live', catId: 'codex', seq: 1, status: 'active', messageCount: 3, createdAt: 1000 },
  {
    id: 'history',
    cliSessionId: 'cli-history',
    catId: 'codex',
    seq: 0,
    status: 'sealed',
    messageCount: 2,
    createdAt: 500,
  },
];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.shell = 'v2';
  mocks.fetch.mockReset();
  __resetSessionChainCacheForTest();
  writeShellLanguage('en');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});

const cases = [
  [
    'seal',
    'SESSION_ACTIVE_INVOCATION',
    409,
    '请先停止该 Agent，再封存会话',
    'Stop this Agent before archiving the session.',
  ],
  ['seal', 'SESSION_SEAL_RACE', 409, '会话状态已变化，请刷新后重试', 'The session changed; refresh and try again.'],
  [
    'restore',
    'active_session_changed',
    409,
    '后端原始恢复错误',
    'The active session changed; refresh before restoring.',
  ],
  [
    'compact',
    'NATIVE_SESSION_BUSY',
    409,
    '后端原始压缩错误',
    'Wait for this Agent’s work to finish before compacting.',
  ],
  [
    'compact',
    'NATIVE_COMPACTION_UNSUPPORTED',
    400,
    '原生压缩不受支持',
    'This session does not support native compaction.',
  ],
  ['seal', 'UNRECOGNIZED_CODE', 403, '后端原始权限错误', 'You do not have permission to modify this session.'],
  ['restore', 'UNRECOGNIZED_CODE', 503, '未分类中文错误', 'Could not restore session (503)'],
  ['compact', 'UNRECOGNIZED_CODE', 503, '未分类中文压缩错误', 'Native compaction failed (503)'],
] as const;

it.each(
  cases,
)('localizes a %s failure from %s without changing the guarded operation', async (operation, code, status, raw, expected) => {
  mocks.fetch.mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? { ok: false, status, json: async () => ({ error: raw, code }) }
      : { ok: true, json: async () => ({ sessions }) },
  );
  await act(async () => root.render(<SessionChainPanel threadId="thread-language" catInvocations={{}} />));
  if (operation === 'restore')
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="sealed-toggle"]')?.click());
  const id =
    operation === 'restore'
      ? 'restore-session-history'
      : operation === 'seal'
        ? 'seal-session-live'
        : 'compact-native-session-live';
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  expect(button).toBeTruthy();
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(container.textContent).toContain(expected);
  expect(container.textContent).not.toContain(raw);
  const posts = mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(1);
  if (operation === 'restore') expect(JSON.parse(posts[0][1].body)).toEqual({ expectedActiveSessionId: 'live' });
  if (operation === 'seal') {
    expect(mocks.fetch.mock.calls.filter(([, options]) => options?.method !== 'POST').length).toBeGreaterThan(1);
    expect(container.querySelector('[data-testid="session-card-active"]')).toBeTruthy();
  }
  const reads = mocks.fetch.mock.calls.length;
  await act(async () => writeShellLanguage('zh'));
  expect(container.textContent).not.toContain(expected);
  expect(mocks.fetch.mock.calls).toHaveLength(reads);
});

it('keeps the original backend diagnostic in Classic', async () => {
  mocks.shell = 'classic';
  mocks.fetch.mockImplementation(async (_url: string, options?: RequestInit) =>
    options?.method === 'POST'
      ? {
          ok: false,
          status: 409,
          json: async () => ({ error: '会话状态已变化，请刷新后重试', code: 'SESSION_SEAL_RACE' }),
        }
      : { ok: true, json: async () => ({ sessions }) },
  );
  await act(async () => root.render(<SessionChainPanel threadId="thread-language" catInvocations={{}} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="seal-session-live"]')?.click());
  expect(container.textContent).toContain('会话状态已变化，请刷新后重试');
});
