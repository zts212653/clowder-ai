import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RightStatusPanelProps } from '@/components/RightStatusPanel';
import { __resetSessionChainCacheForTest, SessionChainPanel } from '@/components/SessionChainPanel';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import type { ChatMessage } from '@/stores/chat-types';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { WorkspaceStatusPanelV2 } from '../WorkspaceStatusPanelV2';

const fetchMock = vi.hoisted(() => vi.fn());
const openSurface = vi.hoisted(() => vi.fn());
const dispatchWorkbench = useF307ExperienceWorkbenchStore.getState().dispatch;
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: (id: string) => ({ id, displayName: id }) }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span /> }));
vi.mock('@/components/PlanBoardPanel', () => ({ PlanBoardPanel: () => null }));
vi.mock('@/components/CloudConversationLink', () => ({ CloudConversationLink: () => null }));
vi.mock('@/components/BindNewSessionSection', () => ({ BindNewSessionSection: () => null }));

const props: RightStatusPanelProps = {
  threadId: 'post-run-a',
  intentMode: 'execute',
  targetCats: ['codex-sol'],
  catStatuses: { 'codex-sol': 'done' },
  catInvocations: {},
  activeInvocations: {},
  hasActiveInvocation: false,
  messageSummary: { total: 1, assistant: 1, system: 0, evidence: 0, followup: 0 },
};
const record = {
  id: 'session-a',
  catId: 'codex-sol',
  cliSessionId: 'actual-native-session',
  seq: 0,
  status: 'active',
  createdAt: 1,
  messageCount: 0,
};
const running = { parent: { catId: 'codex-sol', mode: 'execute', startedAt: 100 } };
const message = (id: string, child: string, timestamp: number): ChatMessage => ({
  id,
  type: 'assistant',
  catId: 'codex-sol',
  content: 'OK',
  timestamp,
  metadata: { provider: 'openai', model: 'gpt-5.6-sol', sessionId: 'actual-native-session' },
  extra: { stream: { invocationId: 'same-parent', turnInvocationId: child } },
});
let container: HTMLDivElement;
let root: Root;
const render = async (next = props) => {
  await act(async () => root.render(<WorkspaceStatusPanelV2 {...next} />));
};
const sessionReads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions'));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fetchMock.mockReset();
  openSurface.mockReset();
  openSurface.mockImplementation(dispatchWorkbench);
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), dispatch: openSurface });
  __resetSessionChainCacheForTest();
  window.history.replaceState({}, '', window.location.pathname);
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith('/sessions') ? { sessions: [record] } : {}),
  }));
  useChatStore.setState({
    currentThreadId: props.threadId,
    messages: [],
    threadStates: {},
    rightPanelOpen: false,
    rightPanelMode: 'status',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  useF307ExperienceWorkbenchStore.setState({ dispatch: dispatchWorkbench });
});

describe('Alpha post-run data shape', () => {
  it('re-reads the canonical chain once after a run ends, without needing a page reload', async () => {
    const before = { sessionId: record.cliSessionId, startedAt: 100 };
    const after = { ...before, durationMs: 200 };
    await render({ ...props, activeInvocations: running, catInvocations: { 'codex-sol': before } });
    expect(sessionReads()).toHaveLength(1);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/sessions')
          ? {
              sessions: [
                {
                  ...record,
                  messageCount: 1,
                  contextHealth: {
                    usedTokens: 33855,
                    windowTokens: 486400,
                    fillRatio: 33855 / 486400,
                    source: 'exact',
                  },
                  lastUsage: { inputTokens: 33855, outputTokens: 5 },
                },
              ],
            }
          : {},
    }));
    await render({ ...props, catInvocations: { 'codex-sol': after } });
    expect(sessionReads()).toHaveLength(2);
    expect(container.querySelector('[data-session-id="session-a"]')?.textContent).toContain('1 条消息');
    expect(container.querySelector('[data-session-id="session-a"]')?.textContent).toContain('7%');
    await render({ ...props, catInvocations: { 'codex-sol': after }, catStatuses: { 'codex-sol': 'done' } });
    expect(sessionReads()).toHaveLength(2);
  });
  it('re-reads when an A2A parent slot changes actor, even though its key stays the same', async () => {
    await render({ ...props, activeInvocations: running });
    await render({ ...props, activeInvocations: { parent: { catId: 'opus55', mode: 'execute' } } });
    expect(sessionReads()).toHaveLength(2);
  });
  it('keeps classic fetch behavior unchanged when a run ends', async () => {
    await act(async () =>
      root.render(<SessionChainPanel threadId={props.threadId} catInvocations={{}} activeInvocations={running} />),
    );
    await act(async () =>
      root.render(<SessionChainPanel threadId={props.threadId} catInvocations={{}} activeInvocations={{}} />),
    );
    expect(sessionReads()).toHaveLength(1);
  });
  it('reads the last real message child ID after reload, when telemetry has no IDs', async () => {
    const latest = message('latest', 'real-child-last', 1791060800000);
    useChatStore.setState({ messages: [message('older', 'real-child-older', 1791060700000), latest] });
    await render();
    expect(container.textContent).toContain('上次运行 ID');
    expect(container.textContent).toContain('real-child-last');
    expect(container.textContent).not.toContain('same-parent');
    expect(container.textContent).toContain('上次运行 ');
    const link = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('查看上次运行'));
    expect(link).toBeDefined();
    const beforeUrl = window.location.href;
    const beforeHistory = window.history.length;
    await act(async () => link?.click());
    expect(window.location.href).toBe(beforeUrl);
    expect(window.history.length).toBe(beforeHistory);
    expect(useChatStore.getState().rightPanelOpen).toBe(true);
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
    let layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.activeSurfaceId).toBe('agent-run:real-child-last');
    expect(layout.surfaces.filter((surface) => surface.type === 'agent-run')).toHaveLength(1);
    await act(async () => link?.click());
    layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.activeSurfaceId).toBe('agent-run:real-child-last');
    expect(layout.surfaces).toHaveLength(1);
    expect(openSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'open-surface',
        surface: expect.objectContaining({
          renderer: 'agent-run',
          ownerStateRef: { owner: 'f299-invocation-trajectory', key: `${props.threadId}:real-child-last` },
        }),
      }),
    );
  });
  it('does not pass the provider CLI session as a canonical trajectory hint while running', async () => {
    await render({
      ...props,
      activeInvocations: running,
      catInvocations: {
        'codex-sol': { invocationId: 'parent', turnInvocationId: 'live-child', sessionId: record.cliSessionId },
      },
    });
    const link = [...container.querySelectorAll('button')].find((b) => b.textContent === '查看运行 ›');
    expect(link).toBeDefined();
    const beforeUrl = window.location.href;
    await act(async () => link?.click());
    expect(window.location.href).toBe(beforeUrl);
    const layout = useF307ExperienceWorkbenchStore.getState().layout;
    expect(layout.activeSurfaceId).toBe('agent-run:live-child');
    expect(layout.surfaces.filter((surface) => surface.type === 'agent-run')).toHaveLength(1);
    expect(openSurface).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'open-surface',
        surface: expect.objectContaining({
          renderer: 'agent-run',
          ownerStateRef: { owner: 'f299-invocation-trajectory', key: `${props.threadId}:live-child` },
        }),
      }),
    );
  });
  it('retains observed parent facts but hides trajectory links until its matching child arrives', async () => {
    await render({ ...props, activeInvocations: running, catInvocations: { 'codex-sol': { invocationId: 'parent' } } });
    expect(container.textContent).toContain('运行 IDparent');
    expect(container.textContent).not.toContain('查看运行');
    await render({
      ...props,
      activeInvocations: running,
      catInvocations: { 'codex-sol': { invocationId: 'parent', turnInvocationId: 'created-child' } },
    });
    expect(container.textContent).toContain('查看运行');
    expect(container.textContent).toContain('created-child');
  });
  it('does not link to a stale child belonging to another parent', async () => {
    await render({
      ...props,
      activeInvocations: running,
      catInvocations: { 'codex-sol': { invocationId: 'previous-parent', turnInvocationId: 'previous-child' } },
    });
    expect(container.textContent).not.toContain('查看运行');
    expect(container.textContent).not.toContain('previous-child');
  });
  it('does not link an idle parent-only invocation while retaining its observed ID', async () => {
    await render({
      ...props,
      catInvocations: { 'codex-sol': { invocationId: 'parent', startedAt: 100, durationMs: 10 } },
    });
    expect(container.textContent).toContain('上次运行 IDparent');
    expect(container.textContent).not.toContain('查看上次运行');
  });
  it('keeps the last observed durable run when a newer failed attempt has no durable identity', async () => {
    const oldTime = 1791060700000;
    const startedAt = oldTime + 60000;
    useChatStore.setState({ messages: [message('older-success', 'older-child', oldTime)] });
    await render({
      ...props,
      catStatuses: { 'codex-sol': 'error' },
      catInvocations: { 'codex-sol': { startedAt, durationMs: 1000, sessionId: record.cliSessionId } },
    });
    expect(container.textContent).toContain('异常');
    expect(container.textContent).toContain(
      new Date(oldTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    );
    expect(container.textContent).toContain('older-child');
    expect(container.textContent).toContain('查看上次运行');
  });
  it('keeps the durable child when the same successful run finishes after its final message', async () => {
    const observedAt = 1791060800000;
    useChatStore.setState({ messages: [message('complete', 'real-child', observedAt)] });
    await render({
      ...props,
      catInvocations: {
        'codex-sol': { startedAt: observedAt - 1000, durationMs: 2000, sessionId: record.cliSessionId },
      },
    });
    expect(container.textContent).toContain('real-child');
    expect(container.textContent).toContain('查看上次运行');
  });
  it('keeps the completed child when the server message precedes the client start event by 1373ms', async () => {
    const timestamp = 1791060769801;
    const startedAt = 1791060771174;
    const completed = message('0001791060769801-000004', 'completed-child', timestamp);
    const telemetry = { startedAt, sessionId: record.cliSessionId };
    useChatStore.setState({ messages: [{ ...completed, isStreaming: true }] });
    await render({ ...props, activeInvocations: running, catInvocations: { 'codex-sol': telemetry } });
    await act(async () => useChatStore.setState({ messages: [completed] }));
    await render({ ...props, catInvocations: { 'codex-sol': { ...telemetry, durationMs: 2000 } } });
    expect(container.textContent).toContain('completed-child');
    const link = [...container.querySelectorAll('button')].find((b) => b.textContent === '查看上次运行 ›');
    expect(link).toBeDefined();
    const beforeUrl = window.location.href;
    const beforeHistory = window.history.length;
    await act(async () => link?.click());
    expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe('agent-run:completed-child');
    expect(window.location.href).toBe(beforeUrl);
    expect(window.history.length).toBe(beforeHistory);
  });
  it('does not borrow the active thread last run for a panel owned by another thread', async () => {
    useChatStore.setState({
      currentThreadId: 'other',
      messages: [message('wrong', 'wrong-child', 300)],
      threadStates: { [props.threadId]: { ...DEFAULT_THREAD_STATE, messages: [message('right', 'right-child', 200)] } },
    });
    await render();
    expect(container.textContent).toContain('right-child');
    expect(container.textContent).not.toContain('wrong-child');
  });
  it('never labels a currently running cat with the previous run time when start time is unknown', async () => {
    useChatStore.setState({ messages: [message('previous', 'previous-child', 100)] });
    await render({ ...props, activeInvocations: { parent: { catId: 'codex-sol', mode: 'execute' } } });
    expect(container.querySelector('[data-testid="status-cat-group"]')?.textContent).not.toContain('上次运行');
  });
  it('skips a newer live draft and explicit cross-post when choosing the last completed run', async () => {
    useChatStore.setState({
      messages: [
        message('complete', 'completed-child', 100),
        { ...message('draft-live', 'live-child', 300), isStreaming: true },
        {
          ...message('foreign', 'foreign-child', 400),
          extra: {
            stream: { turnInvocationId: 'foreign-child' },
            crossPost: { sourceThreadId: 'other' },
          },
        },
      ],
    });
    await render();
    expect(container.textContent).toContain('completed-child');
    expect(container.textContent).not.toContain('live-child');
    expect(container.textContent).not.toContain('foreign-child');
  });
});
