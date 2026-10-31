import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ currentThreadId: 'thread-reopen', catInvocations: {}, activeInvocations: {} }),
    { getState: () => ({ setCurrentThread: vi.fn(), setWorkspaceMode: vi.fn(), setRightPanelOpen: vi.fn() }) },
  ),
}));
vi.mock('@/components/SessionChainPanel', () => ({ SessionChainPanel: () => <div /> }));
vi.mock('@/components/audit/SessionEventsViewer', () => ({ SessionEventsViewer: () => <div /> }));

import { TrajectoryPanel } from '../TrajectoryPanel';

const scope = { threadId: 'thread-reopen', invocationId: 'inv-reopen', sessionId: 'session-reopen' };
const summary = {
  ...scope,
  sessionSeq: 0,
  sessionStatus: 'sealed',
  catId: 'codex61-sol',
  status: 'done',
  startedAt: 1000,
  durationMs: 10,
  eventCount: 1,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: [],
  keyMessages: [],
  firstAssistantOutputEvidence: {
    role: 'assistant',
    complete: false,
    status: 'unknown_identity',
    byteLength: 8,
    source: {
      sessionId: scope.sessionId,
      invocationId: scope.invocationId,
      firstEventNo: 101,
      lastEventNo: 101,
      eventCount: 1,
    },
  },
};
const detail = {
  invocationId: scope.invocationId,
  summary,
  events: [{ ...scope, eventNo: 101, t: 1000, catId: 'codex61-sol', event: { type: 'text', content: 'You，' } }],
};
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body });
function deferred() {
  let resolve: (value: ReturnType<typeof response>) => void = () => {
    throw new Error('not initialized');
  };
  const promise = new Promise<ReturnType<typeof response>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let resolution: ReturnType<typeof deferred>;
let source: ReturnType<typeof deferred>;
let resolutionCount: number;
let detailCount: number;
const observations: string[] = [];
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', '/thread/thread-reopen');
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  resolution = deferred();
  source = deferred();
  resolutionCount = 0;
  detailCount = 0;
  observations.length = 0;
  api.mockReset();
  api.mockImplementation(async (url: string) => {
    observations.push(url);
    if (url.includes('/threads/') && url.endsWith('/invocations?limit=500'))
      return response({ invocations: [summary] });
    if (url.includes('/trajectory?')) return ++resolutionCount === 1 ? response(scope) : resolution.promise;
    if (url.includes('/request-generations?')) return response({ ...scope, generations: [] });
    if (url.includes('/events?view=raw')) return source.promise;
    if (url.includes('/sessions/') && url.endsWith('/invocations/inv-reopen')) {
      detailCount += 1;
      return response(detail);
    }
    throw new Error(`unexpected request ${url}`);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('cat-cafe:shell-presentation');
});
function button(text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text);
}
async function click(node: HTMLButtonElement | undefined) {
  expect(node).toBeDefined();
  await act(async () => node?.click());
}
async function open() {
  await click(container.querySelector<HTMLButtonElement>('[data-invocation-id="inv-reopen"] > button') ?? undefined);
}
async function startThenReturn() {
  await act(async () => root.render(<TrajectoryPanel threadId={scope.threadId} />));
  await open();
  expect(button('查看首条输出记录')).toBeDefined();
  expect(detailCount).toBe(1);
  await click(button('‹ 轨迹'));
}

it('reopening the same invocation waits for its current canonical resolution before exposing source actions', async () => {
  await startThenReturn();
  await open();
  expect(resolutionCount).toBe(2);
  expect(button('查看首条输出记录')).toBeUndefined();
  expect(detailCount).toBe(1);
  await act(async () => resolution.resolve(response(scope)));
  expect(button('查看首条输出记录')).toBeDefined();
  expect(detailCount).toBe(2);
});

it('does not silently discard a source read accepted on reopened visible details', async () => {
  await startThenReturn();
  await open();
  const early = button('查看首条输出记录');
  if (early) await click(early);
  await act(async () => resolution.resolve(response(scope)));
  if (!early) await click(button('查看首条输出记录'));
  expect(observations.filter((url) => url.includes('/events?view=raw'))).toHaveLength(1);
  await act(async () => source.resolve(response({ events: [detail.events[0]] })));
  expect(container.textContent).toContain('原始记录 #101');
  expect(container.querySelector('[data-testid="first-output-source"] pre')?.textContent).toContain('You，');
});

it('a denied revalidation never exposes the old resolved source or starts a detail read', async () => {
  await startThenReturn();
  await open();
  await act(async () => resolution.resolve(response({ code: 'FORBIDDEN' }, false)));
  expect(button('查看首条输出记录')).toBeUndefined();
  expect(detailCount).toBe(1);
  expect(observations.some((url) => url.includes('/events?view=raw'))).toBe(false);
});
