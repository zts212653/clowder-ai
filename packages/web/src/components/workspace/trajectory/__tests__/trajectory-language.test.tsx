import type { InvocationTrajectorySummary } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionSearchTab } from '@/components/audit/SessionSearchTab';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { InvocationTrajectoryList } from '../InvocationTrajectoryList';
import { TrajectoryPanel } from '../TrajectoryPanel';

const mocks = vi.hoisted(() => ({ shell: 'v2', fetch: vi.fn(), copy: vi.fn() }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => mocks.shell }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], getCatById: () => undefined }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) =>
      select({ currentThreadId: 'thread-language', catInvocations: {}, activeInvocations: {} }),
    {
      getState: () => ({
        setWorkspaceMode: vi.fn(),
        setRightPanelOpen: vi.fn(),
        setCurrentThread: vi.fn(),
        currentThreadId: 'thread-language',
      }),
    },
  ),
}));

const summary: InvocationTrajectorySummary = {
  invocationId: 'inv-language',
  threadId: 'thread-language',
  sessionId: 'session-language',
  sessionSeq: 2,
  sessionStatus: 'sealed',
  catId: 'codex61-sol',
  status: 'running',
  startedAt: 1000,
  durationMs: 42000,
  eventCount: 2,
  statusEventCount: 0,
  toolUseCount: 1,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: ['Read'],
  keyMessages: [],
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.shell = 'v2';
  mocks.fetch.mockReset();
  mocks.copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', '/thread/thread-language');
  writeShellLanguage('en');
  mocks.fetch.mockImplementation(async (input: string) => {
    let body: unknown = {};
    if (input.endsWith('/invocations?limit=500')) body = { invocations: [summary] };
    else if (input.includes('/trajectory')) body = summary;
    else if (input.includes('/sessions/search')) body = { hits: [] };
    else if (input.endsWith('/sessions')) body = { sessions: [] };
    else if (input.includes('/request-generations')) body = { ...summary, generations: [] };
    else if (input.includes('/sessions/session-language/invocations/'))
      body = {
        ...summary,
        summary,
        total: 1,
        promptInput: {
          status: 'available',
          messages: [
            { status: 'available', messageId: 'message-native', author: 'user', excerpt: '请保留这条中文原消息。' },
          ],
        },
        events: [
          {
            eventNo: 1,
            threadId: summary.threadId,
            sessionId: summary.sessionId,
            invocationId: summary.invocationId,
            v: 1,
            t: 1001,
            catId: summary.catId,
            event: { type: 'text', text: '原始中文回答。' },
          },
        ],
      };
    return { ok: true, json: async () => body };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});
async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}
async function click(text: string) {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
  expect(button, `missing control: ${text}`).toBeTruthy();
  await act(async () => button?.click());
}

// The real audit failure: the English Host wraps a Chinese content page. Exercise
// the production readers, including a live language switch, rather than a copy table.
it('uses English for list status, counts, evidence boundaries and exact ID copy feedback', async () => {
  await render(<TrajectoryPanel threadId="thread-language" />);
  expect(container.textContent).toContain('Each run');
  expect(container.textContent).toContain('Running');
  expect(container.textContent).toContain('1 tool · 1 message · 0 status events');
  expect(container.textContent).toContain('No verifiable first output yet');
  const copy = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Copy invocation ID: ${summary.invocationId}"]`,
  );
  expect(copy).toBeTruthy();
  await act(async () => copy?.click());
  expect(mocks.copy).toHaveBeenCalledWith(summary.invocationId);
  expect(container.textContent).toContain('Copied');
  await act(async () => writeShellLanguage('zh'));
  expect(container.textContent).toContain('每一轮');
  expect(container.textContent).toContain('运行中');
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/invocations?'))).toHaveLength(1);
});

it('keeps raw user text while translating detail controls and model-input states', async () => {
  await render(<TrajectoryPanel threadId="thread-language" />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-invocation-id] button')?.click());
  expect(container.textContent).toContain('Trigger input');
  expect(container.textContent).toContain('请保留这条中文原消息。');
  expect(container.textContent).toContain('Return to original message');
  expect(container.textContent).toContain('Input actually sent to the model');
  expect(container.textContent).toContain('No submitted input is recorded for this run.');
  await click('Raw records');
  expect(container.textContent).toContain('原始中文回答。');
});

it('translates the real sessions and search tabs without changing search scope or thread identity', async () => {
  await render(<TrajectoryPanel threadId="thread-language" />);
  await click('Sessions');
  expect(container.textContent).toContain('Session records');
  await click('Search');
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  expect(input?.placeholder).toBe('Search session content…');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'needle');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(mocks.fetch).toHaveBeenCalledWith('/api/threads/thread-language/sessions/search?q=needle&scope=both');
  expect(container.textContent).toContain('No matching results');
});

it('translates empty states and preserves the classic list in English shell settings', async () => {
  const node = (
    <InvocationTrajectoryList invocations={[]} loading={false} error={null} onOpen={() => {}} onRetry={() => {}} />
  );
  await render(node);
  expect(container.textContent).toContain('No trajectory for this conversation yet');
  mocks.shell = 'classic';
  await render(
    <InvocationTrajectoryList
      invocations={[summary]}
      loading={false}
      error={null}
      onOpen={() => {}}
      onRetry={() => {}}
    />,
  );
  expect(container.textContent).toContain('运行中');
  expect(container.textContent).toContain('Session #3');
  expect(container.textContent).toContain('1 tools · 1 messages · 0 status');
});

it('keeps focus and the original search hit when the interface language changes', async () => {
  const onViewSession = vi.fn();
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      hits: [
        { score: 1, sessionId: summary.sessionId, kind: 'event', snippet: '原始中文命中。', pointer: { eventNo: 42 } },
      ],
    }),
  });
  await render(<SessionSearchTab threadId={summary.threadId} onViewSession={onViewSession} />);
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'needle');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  const hit = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === summary.sessionId,
  );
  expect(hit).toBeTruthy();
  hit?.focus();
  expect(document.activeElement).toBe(hit);
  await act(async () => writeShellLanguage('zh'));
  expect(document.activeElement).toBe(hit);
  expect(container.textContent).toContain('原始中文命中。');
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  await act(async () => hit?.click());
  expect(onViewSession).toHaveBeenCalledWith(summary.sessionId, summary.threadId);
});

it('localizes a denied source without fetching its detail, and keeps the denial after a language switch', async () => {
  const original = mocks.fetch.getMockImplementation();
  mocks.fetch.mockImplementation(async (input: string) => {
    if (input.includes('/trajectory')) {
      return { ok: false, status: 403, json: async () => ({ code: 'THREAD_ACCESS_DENIED' }) };
    }
    return original?.(input);
  });
  await render(<TrajectoryPanel threadId="thread-language" />);
  await act(async () => container.querySelector<HTMLButtonElement>('[data-invocation-id] button')?.click());
  expect(container.textContent).toContain('You do not have permission to view this run.');
  expect(container.textContent).toContain('Return to source');
  expect(container.querySelector('[data-testid="invocation-trajectory-detail"]')).toBeNull();
  expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/sessions/session-language/invocations/'))).toBe(
    false,
  );
  await act(async () => writeShellLanguage('zh'));
  expect(container.textContent).toContain('没有权限查看这轮 invocation。');
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/trajectory'))).toHaveLength(1);
});
