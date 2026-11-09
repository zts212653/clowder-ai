import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadWorksPanelV2 } from '@/components/artifacts/ThreadWorksPanelV2';
import { ThreadWorksButton } from '@/components/shell/HeaderCounts';
import { HomeWorksSummary } from '@/components/workspace-home/HomeWorksSummary';
import { useChatStore } from '@/stores/chatStore';
import { observeApiSessionOwner } from '@/utils/api-session-identity';

const calls = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://api.test', apiFetch: calls.fetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observeApiSessionOwner(`owner-${Math.random()}`);
  useChatStore.setState({ currentThreadId: 'shared', messages: [], threadStates: {}, hasActiveInvocation: false });
  calls.fetch.mockReset();
  calls.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [], view: 'works', complete: true, total: 0, workLineage: 'resolved' }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('three real consumers share one initial read and one read per material change', async () => {
  await act(async () =>
    root.render(
      <>
        <ThreadWorksButton threadId="shared" />
        <ThreadWorksPanelV2 threadId="shared" />
        <HomeWorksSummary threadId="shared" worktreeId={null} onSelectDestination={vi.fn()} />
      </>,
    ),
  );
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(1);
  await act(async () =>
    useChatStore.getState().addMessageToThread('shared', {
      id: 'material',
      type: 'assistant',
      catId: 'codex',
      content: '',
      timestamp: 1,
      extra: {
        rich: { v: 1, blocks: [{ id: 'image', kind: 'file', v: 1, fileName: 'image.png', url: '/uploads/image.png' }] },
      },
    }),
  );
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(2);
});

it('a complete text and tool invocation shares one terminal read without reading at each message end', async () => {
  await act(async () =>
    root.render(
      <>
        <ThreadWorksButton threadId="shared" />
        <ThreadWorksPanelV2 threadId="shared" />
        <HomeWorksSummary threadId="shared" worktreeId={null} onSelectDestination={vi.fn()} />
      </>,
    ),
  );
  const count = calls.fetch.mock.calls.length;
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation('shared', true));
  await act(async () =>
    useChatStore.getState().addMessageToThread('shared', {
      id: 'plain',
      type: 'assistant',
      catId: 'codex',
      content: 'plain text',
      isStreaming: true,
      timestamp: 1,
    }),
  );
  await act(async () =>
    useChatStore.getState().patchThreadMessage('shared', 'plain', {
      contentBlocks: [{ type: 'tool_result', toolId: 'read-file', result: 'no work published' }],
    }),
  );
  await act(async () => useChatStore.getState().setThreadMessageStreaming('shared', 'plain', false));
  expect(calls.fetch).toHaveBeenCalledTimes(count);
  await act(async () => useChatStore.getState().setThreadMessageStreaming('shared', 'plain', true));
  await act(async () => useChatStore.getState().patchThreadMessage('shared', 'plain', { content: 'continued text' }));
  await act(async () => useChatStore.getState().setThreadMessageStreaming('shared', 'plain', false));
  expect(calls.fetch).toHaveBeenCalledTimes(count);
  await act(async () => useChatStore.getState().setThreadHasActiveInvocation('shared', false));
  expect(calls.fetch).toHaveBeenCalledTimes(count + 1);
});

it('a review-only event does not invalidate the Works lists of mounted threads', async () => {
  await act(async () =>
    root.render(
      <>
        <ThreadWorksButton threadId="shared" />
        <ThreadWorksButton threadId="other" />
      </>,
    ),
  );
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:artifact-review-changed', {
        detail: { reviewId: 'a-review-with-no-work-publication' },
      }),
    ),
  );
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', {
        detail: { threadId: 'shared' },
      }),
    ),
  );
  expect(calls.fetch).toHaveBeenCalledTimes(3);
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/threads/other/'))).toHaveLength(1);
});

it('shows a missing PR ref immediately and shares one separate background title lookup', async () => {
  let finish!: (response: Response) => void;
  const title = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  calls.fetch.mockImplementation(async (url) =>
    String(url).includes('/api/plugins/')
      ? title
      : Response.json({
          artifacts: [
            {
              type: 'pr',
              ref: 'org/repo#12',
              name: 'org/repo#12',
              catId: 'codex',
              createdAt: 1,
              sourceMessageId: null,
            },
          ],
          view: 'works',
          complete: true,
          total: 1,
          workLineage: 'resolved',
        }),
  );
  await act(async () =>
    root.render(
      <>
        <ThreadWorksButton threadId="shared" />
        <ThreadWorksPanelV2 threadId="shared" />
        <HomeWorksSummary threadId="shared" worktreeId={null} onSelectDestination={vi.fn()} />
      </>,
    ),
  );
  expect(host.textContent).toContain('org/repo#12');
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(1);
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/api/plugins/'))).toHaveLength(1);
  await act(async () => finish(Response.json({ title: 'Observed PR title' })));
  expect(host.textContent).toContain('Observed PR title');
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(1);
});

it('scoped work events leave other threads settled and title failure has a short negative cache', async () => {
  calls.fetch.mockImplementation(async (url) =>
    String(url).includes('/api/plugins/')
      ? new Response('', { status: 503 })
      : Response.json({
          artifacts: [
            {
              type: 'pr',
              ref: 'org/repo#13',
              name: 'org/repo#13',
              catId: 'codex',
              createdAt: 1,
              sourceMessageId: null,
            },
          ],
          view: 'works',
          complete: true,
          total: 1,
          workLineage: 'resolved',
        }),
  );
  await act(async () => root.render(<ThreadWorksButton threadId="shared" />));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { threadId: 'other' } }),
    ),
  );
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(1);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('cat-cafe:entrusted-work-projection-invalidated', { detail: { threadId: 'shared' } }),
    ),
  );
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/artifacts'))).toHaveLength(2);
  expect(calls.fetch.mock.calls.filter(([url]) => String(url).includes('/api/plugins/'))).toHaveLength(1);
});

it('replacing a consumer preserves its shared in-flight read instead of scheduling a second one', async () => {
  let finish!: (response: Response) => void;
  calls.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<ThreadWorksButton key="first" threadId="shared" />));
  const signal = calls.fetch.mock.calls[0][1].signal as AbortSignal;
  await act(async () => root.render(<ThreadWorksButton key="replacement" threadId="shared" />));
  expect(signal.aborted).toBe(false);
  await act(async () =>
    finish(Response.json({ artifacts: [], view: 'works', complete: true, total: 0, workLineage: 'resolved' })),
  );
  expect(calls.fetch).toHaveBeenCalledTimes(1);
});

it('a changed session owner cannot see or adopt the previous owners late response', async () => {
  let finishOld!: (response: Response) => void;
  calls.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOld = resolve;
      }),
  );
  calls.fetch.mockResolvedValue(
    Response.json({ artifacts: [], view: 'works', complete: true, total: 7, workLineage: 'resolved' }),
  );
  await act(async () => root.render(<ThreadWorksButton threadId="shared" />));
  const oldSignal = calls.fetch.mock.calls[0][1].signal as AbortSignal;
  await act(async () => observeApiSessionOwner('replacement-owner'));
  expect(oldSignal.aborted).toBe(true);
  expect(calls.fetch).toHaveBeenCalledTimes(2);
  await act(async () =>
    finishOld(Response.json({ artifacts: [], view: 'works', complete: true, total: 99, workLineage: 'resolved' })),
  );
  expect(host.querySelector('[data-testid="header-works"]')?.textContent).toContain('7');
  expect(host.textContent).not.toContain('99');
});
