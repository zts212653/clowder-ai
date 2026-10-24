import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { recallEventDisplayTitle } from '../recall-feed-model';
import { useThreadRecall } from '../useRecallEvents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
function Probe() {
  const read = useThreadRecall();
  return (
    <div data-retained-history={read.retainedHistory}>
      {read.historyStatus}|{read.events.map((event) => recallEventDisplayTitle(event)).join(',')}|
      {read.cuesFailed ? 'cue-error' : 'cue-ok'}
    </div>
  );
}
describe('F321 scoped recall reads', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    api.mockReset();
    useChatStore.setState({ currentThreadId: 'thread-one', messages: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it('keeps history failure observable while retaining message-bound live recalls', async () => {
    api.mockRejectedValue(new Error('unavailable'));
    useChatStore.setState({
      messages: [
        {
          id: 'one',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 1,
          extra: { stream: { turnInvocationId: 'inv' } },
          toolEvents: [
            {
              id: 'tool',
              type: 'tool_use',
              label: 'sonnet → search_evidence',
              detail: '{"query":"sentinel"}',
              timestamp: 2,
            },
          ],
        },
      ],
    });
    await act(async () => {
      root.render(<Probe />);
    });
    expect(container.textContent).toBe('error|sentinel|cue-error');
  });
  it('never reuses a late response from another thread', async () => {
    let finish: (value: Response) => void = () => {};
    api.mockImplementation((path) =>
      path.includes('thread-one')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(new Response('{"events":[]}')),
    );
    await act(async () => root.render(<Probe />));
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-two', messages: [] }));
    await act(async () => finish(new Response('{"events":[{"id":"old","query":"private-one","timestamp":1}]}')));
    expect(container.textContent).toBe('ready||cue-ok');
  });
  it.each([
    200, 503,
  ])('does not read cross-post producers as local cue invocations (local status %s)', async (status) => {
    useChatStore.setState({
      messages: [
        {
          id: 'cross-post',
          type: 'assistant',
          catId: 'codex61-sol',
          content: 'Shared result',
          timestamp: 1,
          lifecycle: { kind: 'input', orderKey: '1:cross-post', producerInvocationId: 'foreign-turn' },
          extra: {
            crossPost: { sourceThreadId: 'source-thread', sourceInvocationId: 'foreign-turn' },
            stream: { turnInvocationId: 'foreign-turn' },
          },
        },
        {
          id: 'reply',
          type: 'assistant',
          catId: 'sonnet',
          content: 'Local reply',
          timestamp: 2,
          extra: { stream: { turnInvocationId: 'local-turn' } },
        },
      ],
    });
    api.mockImplementation(async (path) => {
      if (path.includes('foreign-turn'))
        return new Response('{"error":"Invocation not found in thread"}', { status: 404 });
      if (path.includes('memory-cues')) return new Response('{"cues":[]}', { status });
      return new Response('{"events":[],"cueInvocationIds":[]}');
    });
    await act(async () => root.render(<Probe />));
    expect(api.mock.calls.some(([path]) => path.includes('foreign-turn'))).toBe(false);
    expect(api.mock.calls.some(([path]) => path.includes('/local-turn/memory-cues'))).toBe(true);
    expect(container.textContent).toBe(`ready||${status === 200 ? 'cue-ok' : 'cue-error'}`);
  });
  it('excludes legacy cross-posts and canonical inputs without dropping a local historical cue', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'legacy-cross-post',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 1,
          extra: { crossPost: { sourceThreadId: 'source-thread' }, stream: { invocationId: 'foreign' } },
        },
        {
          id: 'input',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 2,
          lifecycle: { kind: 'input', orderKey: '2:input', producerInvocationId: 'producer' },
          extra: { stream: { turnInvocationId: 'producer' } },
        },
      ],
    });
    api.mockImplementation(
      async (path) =>
        new Response(
          path.includes('memory-cues') ? '{"cues":[]}' : '{"events":[],"cueInvocationIds":["historical-local"]}',
        ),
    );
    await act(async () => root.render(<Probe />));
    const cueReads = api.mock.calls.map(([path]) => path).filter((path) => path.includes('memory-cues'));
    expect(cueReads).toEqual(['/api/threads/thread-one/invocations/historical-local/memory-cues']);
    expect(container.textContent).toBe('ready||cue-ok');
  });
  it('reads a new streaming cue title once without waiting for the reply to finish', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'streaming',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 1,
          isStreaming: true,
          extra: { stream: { turnInvocationId: 'inv-live' } },
        },
      ],
    });
    let historyReads = 0;
    let finishView: (response: Response) => void = () => {};
    api.mockImplementation(async (path) => {
      if (path.includes('memory-cues'))
        return new Response(
          JSON.stringify({
            cues: [
              {
                cueId: 'live-cue',
                consumerCatId: 'sonnet',
                sourceAnchor: 'F321',
                sourceRevision: 'r1',
                resolverFamily: 'project_knowledge',
                status: 'presented_unreported',
                presentedAt: 1,
              },
            ],
          }),
        );
      historyReads++;
      if (historyReads === 1)
        return new Response(JSON.stringify({ events: [], cueInvocationIds: [], sourceViews: [] }));
      return new Promise((resolve) => {
        finishView = resolve;
      });
    });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).not.toContain('标题没有记录下来');
    expect(container.textContent).toContain('正在读取标题');
    expect(historyReads).toBe(2);
    await act(async () =>
      finishView(
        new Response(
          JSON.stringify({
            events: [],
            cueInvocationIds: ['inv-live'],
            sourceViews: [
              {
                anchor: 'F321',
                invocationId: 'inv-live',
                cueId: 'live-cue',
                sourceRevision: 'r1',
                kind: 'feature',
                title: 'F321 记忆界面',
                href: '/memory/search?q=F321',
              },
            ],
          }),
        ),
      ),
    );
    expect(container.textContent).toContain('F321 记忆界面');
    expect(container.textContent).not.toContain('正在读取标题');
    await act(async () => root.render(<Probe />));
    expect(historyReads).toBe(2);
    expect(useChatStore.getState().messages[0]?.isStreaming).toBe(true);
  });

  it.each([200, 503])('does not loop on a missing streaming cue view (response %s)', async (status) => {
    useChatStore.setState({
      messages: [
        {
          id: 'streaming',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 1,
          isStreaming: true,
          extra: { stream: { turnInvocationId: 'inv-live' } },
        },
      ],
    });
    let historyReads = 0;
    api.mockImplementation(async (path) => {
      if (path.includes('memory-cues'))
        return new Response(
          JSON.stringify({
            cues: [
              {
                cueId: 'cue',
                consumerCatId: 'sonnet',
                sourceAnchor: 'F321',
                sourceRevision: 'r1',
                resolverFamily: 'project_knowledge',
                status: 'presented_unreported',
                presentedAt: 1,
              },
            ],
          }),
        );
      historyReads++;
      if (historyReads > 1 && status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify({ events: [], cueInvocationIds: [], sourceViews: [] }));
    });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toContain('暂时读不到标题');
    expect(container.textContent).not.toContain('标题没有记录下来');
    expect(historyReads).toBe(2);
    await act(async () => root.render(<Probe />));
    expect(historyReads).toBe(2);
  });
  it('discards a supplemental title response after changing threads', async () => {
    useChatStore.setState({
      messages: [
        {
          id: 'streaming',
          type: 'assistant',
          catId: 'sonnet',
          content: '',
          timestamp: 1,
          isStreaming: true,
          extra: { stream: { turnInvocationId: 'inv-live' } },
        },
      ],
    });
    let historyReads = 0;
    let finishView: (response: Response) => void = () => {};
    api.mockImplementation(async (path) => {
      if (path.includes('memory-cues'))
        return new Response(
          JSON.stringify({
            cues: [
              {
                cueId: 'cue',
                consumerCatId: 'sonnet',
                sourceAnchor: 'F321',
                sourceRevision: 'r1',
                resolverFamily: 'project_knowledge',
                status: 'presented_unreported',
                presentedAt: 1,
              },
            ],
          }),
        );
      if (path.includes('thread-one') && ++historyReads > 1)
        return new Promise((resolve) => {
          finishView = resolve;
        });
      return new Response(JSON.stringify({ events: [], sourceViews: [], cueInvocationIds: [] }));
    });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toContain('正在读取标题');
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-two', messages: [] }));
    await act(async () =>
      finishView(
        new Response(
          JSON.stringify({
            events: [],
            cueInvocationIds: ['inv-live'],
            sourceViews: [
              {
                anchor: 'F321',
                invocationId: 'inv-live',
                cueId: 'cue',
                sourceRevision: 'r1',
                title: '其他对话标题',
                href: null,
              },
            ],
          }),
        ),
      ),
    );
    expect(container.textContent).toBe('ready||cue-ok');
  });
  it('retains cue-only history when the supplemental read fails', async () => {
    let reads = 0;
    api.mockImplementation(async (path) => {
      if (path.includes('memory-cues'))
        return new Response(
          JSON.stringify({
            cues: [
              {
                cueId: 'cue',
                consumerCatId: 'sonnet',
                sourceAnchor: 'F321',
                sourceRevision: 'r1',
                resolverFamily: 'project_knowledge',
                status: 'presented_unreported',
                presentedAt: 1,
              },
            ],
          }),
        );
      if (++reads > 1) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ events: [], cueInvocationIds: ['inv-old'], sourceViews: [] }));
    });
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toContain('暂时读不到标题');
    expect(container.firstElementChild?.getAttribute('data-retained-history')).toBe('true');
    expect(reads).toBe(2);
  });
  it('uses the A1 invocation cue producer and keeps presented-only status', async () => {
    api.mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            path.includes('memory-cues')
              ? {
                  cues: [
                    {
                      cueId: 'cue',
                      consumerCatId: 'sonnet',
                      sourceAnchor: 'taste-one',
                      sourceRevision: 'r1',
                      resolverFamily: 'taste',
                      status: 'presented_unreported',
                      presentedAt: 3,
                    },
                  ],
                }
              : {
                  cueInvocationIds: ['inv'],
                  sourceViews: [
                    {
                      anchor: 'taste-one',
                      invocationId: 'inv',
                      cueId: 'cue',
                      sourceRevision: 'r1',
                      title: '提到 ELI5 时先讲直觉',
                      kind: 'taste',
                      href: null,
                    },
                  ],
                  events: [{ id: 'search', invocationId: 'inv', catId: 'sonnet', query: 'F321', timestamp: 1 }],
                },
          ),
        ),
    );
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toContain('ready|F321,提到 ELI5 时先讲直觉|cue-ok');
    expect(api.mock.calls.some(([path]) => path === '/api/threads/thread-one/invocations/inv/memory-cues')).toBe(true);
  });
  it('does not substitute a different cue revision or invocation with the same anchor', async () => {
    api.mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            path.includes('memory-cues')
              ? {
                  cues: [
                    {
                      cueId: 'first',
                      consumerCatId: 'sonnet',
                      sourceAnchor: 'same',
                      sourceRevision: 'r1',
                      resolverFamily: 'taste',
                      status: 'presented_unreported',
                      presentedAt: 1,
                    },
                    {
                      cueId: 'second',
                      consumerCatId: 'sonnet',
                      sourceAnchor: 'same',
                      sourceRevision: 'r2',
                      resolverFamily: 'taste',
                      status: 'presented_unreported',
                      presentedAt: 2,
                    },
                  ],
                }
              : {
                  events: [],
                  cueInvocationIds: ['inv'],
                  sourceViews: [
                    {
                      anchor: 'same',
                      invocationId: 'inv',
                      cueId: 'first',
                      sourceRevision: 'r1',
                      title: '递送时的品味',
                      href: null,
                    },
                    {
                      anchor: 'same',
                      invocationId: 'inv',
                      cueId: 'second',
                      sourceRevision: 'r2',
                      titleStatus: 'unavailable',
                      href: null,
                    },
                    {
                      anchor: 'same',
                      invocationId: 'other',
                      cueId: 'second',
                      sourceRevision: 'r2',
                      title: '其他调用的标题',
                      href: null,
                    },
                    { anchor: 'same', title: '当前索引的标题', href: '/wrong' },
                  ],
                },
          ),
        ),
    );
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe('ready|递送时的品味,品味 · 暂时读不到标题|cue-ok');
  });
});
