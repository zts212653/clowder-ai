import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RightStatusPanelProps } from '@/components/RightStatusPanel';
import { RevealWhispersButton, RuntimeLogsButton, ThinkingModeToggle } from '@/components/RightStatusPanel';
import { __resetSessionChainCacheForTest } from '@/components/SessionChainPanel';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { ConfirmProvider } from '@/components/useConfirm';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceStatusPanelV2 } from '../WorkspaceStatusPanelV2';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), copy: vi.fn() }));
vi.unmock('@/components/useConfirm');
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [{ id: 'cat-a', displayName: '原名 GPT-6.1', color: { primary: '#888888' } }],
    getCatById: (id: string) => ({ id, displayName: '原名 GPT-6.1', color: { primary: '#888888' } }),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span /> }));
vi.mock('@/hooks/useSendMessage', () => ({ useSendMessage: () => ({ handleSend: vi.fn() }) }));

const record = (id: string, catId = 'cat-a', status = 'active', seq = 0) => ({
  id,
  catId,
  status,
  seq,
  cliSessionId: `native-${id}`,
  createdAt: Date.now() - 120000,
  messageCount: 12,
  compressionCount: 0,
});
const records = [
  { ...record('current'), lastUsage: { inputTokens: 1200, outputTokens: 23, cacheReadTokens: 600 } },
  { ...record('old', 'cat-a', 'sealed', 1), sealedAt: Date.now() - 60000, sealReason: 'manual' },
  record('ambiguous-a', 'cat-b'),
  record('ambiguous-b', 'cat-b', 'active', 1),
  {
    ...record('running', 'cat-c'),
    contextHealth: { usedTokens: 8400, windowTokens: 10000, fillRatio: 0.84, source: 'approx' },
  },
];
const props: RightStatusPanelProps = {
  threadId: 'locale-thread',
  intentMode: 'execute',
  targetCats: ['cat-a', 'cat-b', 'cat-c'],
  catStatuses: { 'cat-a': 'done', 'cat-c': 'streaming' },
  catInvocations: {},
  activeInvocations: { 'real-parent': { catId: 'cat-c', mode: 'execute' } },
  messageSummary: { total: 12, assistant: 8, system: 2, evidence: 1, followup: 1 },
};
let host: HTMLDivElement, root: Root;
const render = async (next = props) =>
  act(async () =>
    root.render(
      <ConfirmProvider>
        <WorkspaceStatusPanelV2 {...next} />
      </ConfirmProvider>,
    ),
  );
const language = async (next: 'zh' | 'en') => act(async () => writeShellLanguage(next));
const reads = () => mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith('/sessions')).length;
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = async (text: string) => {
  expect(button(text), text).toBeDefined();
  await act(async () => button(text)?.click());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  writeShellLanguage('zh');
  __resetSessionChainCacheForTest();
  mocks.fetch.mockReset().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith('/sessions') ? { sessions: records } : {}),
  }));
  mocks.copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  useChatStore.setState({ currentThreadId: props.threadId, threads: [], messages: [], threadStates: {} });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

it('switches the already-open full page, preserves native identities, expansion and entered binding without reading again', async () => {
  await render();
  await click('› 已封存的会话 1');
  const current = host.querySelector('[data-session-id="current"]')!;
  await act(async () => [...current.querySelectorAll('button')].find((b) => b.textContent === '绑定会话 ID…')?.click());
  const input = current.querySelector('input')!;
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    nativeSetter.call(input, 'native-未修改-id');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const readCount = reads();
  await language('en');
  expect(host.textContent).toContain('Members 3');
  expect(host.textContent).toContain('Running 1');
  for (const text of [
    'Idle',
    'Session #1',
    'Started 2m ago',
    '12 messages',
    'No compactions',
    'Context usage unknown',
    'Archived sessions 1',
    'Manually archived',
    'Compact context',
    'Archive session',
    'View history',
    'Restore as current',
    'Stop the run before compacting, binding or archiving',
    '2 unarchived sessions',
    'Conversation info',
    'Visibility',
    'Open directory',
  ]) {
    expect(host.textContent, text).toContain(text);
  }
  expect(host.querySelector('[data-session-id="current"]')).toBe(current);
  expect(current.querySelector('input')).toBe(input);
  expect(input.value).toBe('native-未修改-id');
  expect(input.placeholder).toBe('CLI session ID');
  expect(host.textContent).toContain('原名 GPT-6.1');
  expect(host.textContent).toContain('native-old');
  expect(host.textContent?.replaceAll('原名 GPT-6.1', '')).not.toMatch(/[\u4e00-\u9fff]/);
  expect(reads()).toBe(readCount);
  expect(host.querySelector<HTMLButtonElement>('[data-testid="compact-native-session-running"]')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-testid="seal-session-running"]')!.disabled).toBe(true);
  await language('zh');
  expect(host.textContent).toContain('压缩前请确认当前使用的会话');
  expect(host.querySelector('[data-session-id="old"]')).not.toBeNull();
  expect(input.value).toBe('native-未修改-id');
  expect(reads()).toBe(readCount);
});

it('translates plan status and resume confirmation but preserves the actual task text', async () => {
  await render({
    ...props,
    catInvocations: {
      'cat-a': {
        taskProgress: {
          snapshotStatus: 'interrupted',
          lastUpdate: 1,
          tasks: [{ id: 'task-raw', subject: '用户原始任务中文', status: 'pending' }],
        },
      },
    },
  });
  await language('en');
  expect(host.textContent).toContain('Plans');
  expect(host.textContent).toContain('Interrupted');
  expect(host.textContent).toContain('Pending');
  expect(host.textContent).toContain('用户原始任务中文');
  await click('Continue');
  expect(document.body.textContent).toContain('Resume task');
  expect(document.body.textContent).toContain('Resume the previous task?');
});

it.each([
  ['spawning', 'Starting'],
  ['alive_but_silent', 'Waiting silently'],
  ['suspected_stall', 'Possibly stalled'],
  ['error', 'Error'],
] as const)('translates %s and running protections without substituting a new run identity', async (status, expected) => {
  await render({ ...props, catStatuses: { 'cat-c': status } });
  await language('en');
  const cat = host.querySelector('[data-cat-id="cat-c"]')!;
  expect(cat.textContent).toContain(expected);
  expect(cat.textContent).toContain('real-parent');
  expect(cat.textContent).toContain('Stop the run before');
  expect(button('View run ›')).toBeUndefined(); // no child has arrived
});

it('translates a denied read while keeping records and binding unavailable; changing language does not retry', async () => {
  mocks.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/sessions')
      ? { ok: false, status: 403, json: async () => ({ code: 'THREAD_ACCESS_DENIED' }) }
      : { ok: true, json: async () => ({}) },
  );
  await render();
  await language('en');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('You do not have permission');
  expect(host.querySelectorAll('[data-session-id]')).toHaveLength(0);
  expect(host.textContent).not.toContain('Bind CLI session');
  expect(reads()).toBe(1);
  await language('zh');
  expect(host.textContent).toContain('无权查看');
  expect(reads()).toBe(1);
});

it('uses the owner error code, not a server diagnostic, for a failed action and live language changes', async () => {
  mocks.fetch.mockImplementation(async (url: string) =>
    url.endsWith('/seal')
      ? { ok: false, status: 409, json: async () => ({ code: 'SESSION_ACTIVE_INVOCATION', error: '服务端原始诊断' }) }
      : { ok: true, json: async () => (url.endsWith('/sessions') ? { sessions: records } : {}) },
  );
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="seal-session-current"]')!.click());
  await language('en');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stop this Agent');
  expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('服务端原始诊断');
  await language('zh');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('请先停止');
});

it('leaves the shared controls in classic wording even when the v2 language preference is English', async () => {
  await language('en');
  await act(async () =>
    root.render(
      <>
        <ThinkingModeToggle threadId={props.threadId} />
        <RevealWhispersButton threadId={props.threadId} />
        <RuntimeLogsButton threadId={props.threadId} />
      </>,
    ),
  );
  expect(host.textContent).toContain('心里话: 调试');
  expect(host.textContent).toContain('揭秘全部');
  expect(host.textContent).toContain('查看日志');
  expect(host.textContent).not.toMatch(/Switch to|Reveal all|Open directory/);
});
