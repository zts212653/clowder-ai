import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import { MATTER_MEMORY_CHANGED } from '../matter-memory-events';
import { useThreadRecall } from '../useRecallEvents';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const api = vi.mocked(apiFetch);
const statuses = ['presented_unreported', 'drilled', 'applied', 'dismissed'];
const ids = Array.from({ length: 146 }, (_, i) => `inv-${i}`);
const messages = (invocations = ids): ChatMessage[] =>
  invocations.map((id, i) => ({
    id: `reply-${id}`,
    type: 'assistant',
    catId: 'sonnet',
    content: 'Reply',
    timestamp: i + 1,
    extra: { stream: { turnInvocationId: id } },
  }));
const state = new Map<string, string>();
let matterChanged = false;
function cue(id: string) {
  const matter = id === 'inv-matter';
  return {
    cueId: `cue-${id}`,
    consumerCatId: 'sonnet',
    sourceAnchor: matter ? 'matter:one' : `person:${id}`,
    sourceRevision: 'r1',
    resolverFamily: matter ? 'matter' : 'person_entity',
    status: state.get(id) ?? statuses[Number(id.split('-').at(-1)) % 4] ?? 'drilled',
    presentedAt: 1,
    ...(matter
      ? {
          source: 'pull',
          matterRead: matterChanged
            ? { status: 'changed', matterId: 'one' }
            : { status: 'current', matterId: 'one', title: 'Current matter', messageCount: 2 },
        }
      : {}),
  };
}
function response(path: string) {
  const url = new URL(path, 'http://fixture');
  if (url.pathname === '/api/recall/events') {
    return new Response(
      JSON.stringify({
        events: [],
        cueInvocationIds: ids,
        sourceViews: [...ids, 'inv-matter'].map((id) => ({
          invocationId: id,
          cueId: `cue-${id}`,
          sourceRevision: 'r1',
          anchor: `person:${id}`,
          kind: 'person_entity',
          title: `Source ${id}`,
          href: null,
        })),
      }),
    );
  }
  const legacy = /\/invocations\/([^/]+)\/memory-cues$/.exec(url.pathname);
  if (legacy) return new Response(JSON.stringify({ cues: [cue(decodeURIComponent(legacy[1]))] }));
  if (url.pathname.endsWith('/memory-cues')) {
    const requested = JSON.parse(url.searchParams.get('invocationIds') ?? '[]') as string[];
    return new Response(
      JSON.stringify({
        invocations: requested.map((invocationId) => ({
          invocationId,
          status: 200,
          cues: [cue(invocationId)],
        })),
      }),
    );
  }
  throw new Error(`Unexpected read ${path}`);
}
function Probe({ name }: { name: string }) {
  const read = useThreadRecall();
  return (
    <pre data-probe={name} data-events={JSON.stringify(read.events)} data-history={read.retainedHistory}>
      {read.cuesLoading ? 'loading' : read.cuesFailed ? 'unavailable' : 'ready'}
    </pre>
  );
}
function batchCalls() {
  return api.mock.calls.filter(([path]) => /\/threads\/[^/]+\/memory-cues\?/.test(path));
}
function individualCalls() {
  return api.mock.calls.filter(([path]) => /\/invocations\/[^/]+\/memory-cues/.test(path));
}

describe('thread recall bounds cue reads across real hook consumers', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const events = (name = 'one') =>
    JSON.parse(host.querySelector(`[data-probe="${name}"]`)?.getAttribute('data-events') ?? '[]');
  beforeEach(() => {
    state.clear();
    matterChanged = false;
    api.mockReset();
    observeApiSessionOwner('owner-one');
    useChatStore.setState({ currentThreadId: 'thread-one', messages: messages() });
    api.mockImplementation(async (path) => response(path));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    observeApiSessionOwner(null);
  });

  it('loads every historical cue on first entry with bounded requests instead of one GET per invocation', async () => {
    await act(async () => root.render(<Probe name="one" />));
    expect(events()).toHaveLength(146);
    expect(new Set(events().map((entry: { cueStatus: string }) => entry.cueStatus))).toEqual(new Set(statuses));
    expect(individualCalls()).toHaveLength(0);
    expect(batchCalls().length).toBeGreaterThan(0);
    expect(batchCalls().length).toBeLessThanOrEqual(3);
    console.info(
      JSON.stringify({
        case: 'first-146',
        batchRequests: batchCalls().length,
        individualRequests: individualCalls().length,
        visible: events().length,
      }),
    );
  });

  it('shares the same in-flight bounded read between reply indicators and Workspace', async () => {
    await act(async () =>
      root.render(
        <>
          <Probe name="one" />
          <Probe name="workspace" />
        </>,
      ),
    );
    expect(events()).toHaveLength(146);
    expect(events('workspace')).toHaveLength(146);
    expect(individualCalls()).toHaveLength(0);
    expect(batchCalls().length).toBeLessThanOrEqual(3);
    console.info(
      JSON.stringify({
        case: 'dual-146',
        batchRequests: batchCalls().length,
        individualRequests: individualCalls().length,
        visibleEach: events().length,
      }),
    );
  });

  it('preserves old cues on remount and thread return without rebuilding an invocation HTTP fanout', async () => {
    await act(async () => root.render(<Probe name="one" />));
    await act(async () => root.render(null));
    await act(async () => root.render(<Probe name="one" />));
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-two', messages: [] }));
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-one', messages: messages() }));
    expect(events()).toHaveLength(146);
    expect(individualCalls()).toHaveLength(0);
    expect(batchCalls().length).toBeLessThanOrEqual(12);
    console.info(
      JSON.stringify({
        case: 'remount-and-return',
        batchRequests: batchCalls().length,
        individualRequests: individualCalls().length,
        visible: events().length,
      }),
    );
  });

  it('refreshes on focus and reads only the changed invocation after one live cue update', async () => {
    await act(async () =>
      root.render(
        <>
          <Probe name="one" />
          <Probe name="workspace" />
        </>,
      ),
    );
    const initial = batchCalls().length;
    state.set('inv-8', 'applied');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(events().find((entry: { invocationId: string }) => entry.invocationId === 'inv-8').cueStatus).toBe(
      'applied',
    );
    expect(batchCalls().length - initial).toBeLessThanOrEqual(3);
    const beforeIncrement = batchCalls().length;
    state.set('inv-8', 'dismissed');
    await act(async () =>
      useChatStore.setState({
        messages: messages().map((message) =>
          message.id === 'reply-inv-8'
            ? { ...message, toolEvents: [{ id: 'new-tool', type: 'tool_use', label: 'not recall', timestamp: 1 }] }
            : message,
        ),
      }),
    );
    expect(events().find((entry: { invocationId: string }) => entry.invocationId === 'inv-8').cueStatus).toBe(
      'dismissed',
    );
    const incrementIds = batchCalls()
      .slice(beforeIncrement)
      .flatMap(([path]) => JSON.parse(new URL(path, 'http://fixture').searchParams.get('invocationIds') ?? '[]'));
    expect(incrementIds).toEqual(['inv-8']);
    expect(individualCalls()).toHaveLength(0);
    console.info(
      JSON.stringify({
        case: 'focus-and-one-change',
        focusRequests: beforeIncrement - initial,
        changedInvocationRequests: batchCalls().length - beforeIncrement,
        changedIds: incrementIds,
      }),
    );
  });

  it('revalidates a current Matter summary after correction without treating the history as empty', async () => {
    useChatStore.setState({ messages: messages(['inv-matter']) });
    await act(async () => root.render(<Probe name="one" />));
    const previous = events().find((entry: { invocationId: string }) => entry.invocationId === 'inv-matter');
    expect(previous.matterRead.title).toBe('Current matter');
    matterChanged = true;
    await act(async () => window.dispatchEvent(new Event(MATTER_MEMORY_CHANGED)));
    const updated = events().find((entry: { invocationId: string }) => entry.invocationId === 'inv-matter');
    expect(updated.matterRead.status).toBe('changed');
    expect(updated.results[0]).toMatchObject({ title: '', href: null, sourceUnavailableReason: 'source_corrected' });
    expect(events().length).toBeGreaterThan(1);
    expect(individualCalls()).toHaveLength(0);
  });

  it('discards a late owner-one response after the observed session changes', async () => {
    useChatStore.setState({ messages: messages(['inv-private']) });
    const pending: Array<() => void> = [];
    api.mockImplementation((path) => {
      const owner = apiSessionIdentity.getSnapshot().ownerUserId;
      if (owner !== 'owner-one') return Promise.resolve(new Response('{"error":"Forbidden"}', { status: 403 }));
      if (path.includes('memory-cues')) return new Promise((resolve) => pending.push(() => resolve(response(path))));
      return Promise.resolve(new Response('{"events":[],"cueInvocationIds":[],"sourceViews":[]}'));
    });
    await act(async () => root.render(<Probe name="one" />));
    await act(async () => observeApiSessionOwner('owner-two'));
    await act(async () => {
      for (const finish of pending) finish();
    });
    expect(events()).toEqual([]);
    expect(host.textContent).toContain('unavailable');
  });

  it('keeps successful cue history and reports one unavailable invocation instead of treating it as empty', async () => {
    api.mockImplementation(async (path) => {
      const original = response(path);
      const url = new URL(path, 'http://fixture');
      if (!/^\/api\/threads\/[^/]+\/memory-cues$/.test(url.pathname)) return original;
      const body = await original.json();
      body.invocations = body.invocations.map((row: { invocationId: string }) =>
        row.invocationId === 'inv-8' ? { invocationId: row.invocationId, status: 503, error: 'unavailable' } : row,
      );
      return new Response(JSON.stringify(body));
    });
    await act(async () => root.render(<Probe name="one" />));
    expect(events()).toHaveLength(145);
    expect(events().some((entry: { invocationId: string }) => entry.invocationId === 'inv-8')).toBe(false);
    expect(host.textContent).toContain('unavailable');
    expect(host.querySelector('[data-probe="one"]')?.getAttribute('data-history')).toBe('true');
    expect(individualCalls()).toHaveLength(0);
  });
});
