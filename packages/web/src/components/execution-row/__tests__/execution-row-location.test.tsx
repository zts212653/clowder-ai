import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import {
  buildMessageDisclosureKey,
  resetMessageDisclosureStateForTest,
  useMessageDisclosureState,
} from '../../message-disclosure-state';
import { writeShellLanguage } from '../../shell/shell-language';
import { MessageNavigationProvider } from '../../thread-chat/MessageNavigationContext';
import { ExecutionRow } from '../ExecutionRow';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [],
    getCatById: (id: string) => ({
      id,
      displayName: '砚砚',
      variantLabel: 'GPT-6.1 Sol',
      color: { primary: 'var(--color-codex-primary)' },
    }),
  }),
}));

const THREAD = 'thread-location';
const message: ChatMessage = {
  id: 'original-writing-message',
  type: 'assistant',
  catId: 'codex61-sol',
  content: '正在修复执行行',
  timestamp: Date.now(),
  isStreaming: true,
  extra: { stream: { turnInvocationId: 'child-exact', invocationId: 'parent' } },
};
function execution(over: Partial<ActiveExecutionProjection> = {}): ActiveExecutionProjection {
  return {
    kind: 'live_invocation',
    executionId: 'parent',
    turnInvocationId: 'child-exact',
    threadId: THREAD,
    threadTitle: '位置验证',
    catId: 'codex61-sol',
    startedAt: Date.now() - 10_000,
    cancelability: {
      state: 'cancelable',
      target: { kind: 'live_invocation', threadId: THREAD, catId: 'codex61-sol', executionId: 'parent' },
    },
    ...over,
  };
}
function RecordOwner() {
  const { expanded } = useMessageDisclosureState(buildMessageDisclosureKey(THREAD, message, 'cli'), false);
  return (
    <article data-message-id={message.id}>
      <output data-testid="original-record" data-expanded={expanded} />
    </article>
  );
}

describe('execution row location through the original owner', () => {
  let root: Root;
  let container: HTMLDivElement;
  const scroll = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetMessageDisclosureStateForTest();
    writeShellLanguage('zh');
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ entries: [], paused: false }) });
    useActiveExecutionStore.getState().reset();
    useToastStore.setState({ toasts: [] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    scroll.mockClear();
    HTMLElement.prototype.scrollIntoView = scroll;
    useChatStore.setState({
      currentThreadId: THREAD,
      messages: [message],
      threadStates: {},
      queue: [],
      activeInvocations: {},
      catInvocations: {},
      catStatuses: {},
      hasActiveInvocation: false,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellLanguage('zh');
    vi.unstubAllGlobals();
  });
  async function render(run: ActiveExecutionProjection, navigate?: (messageId: string) => boolean) {
    const store = useActiveExecutionStore.getState();
    store.applySnapshot(THREAD, store.beginHydration(THREAD, '/project'), {
      projectPath: '/project',
      executions: [run],
    });
    const content = (
      <>
        <RecordOwner />
        <ExecutionRow threadId={THREAD} />
      </>
    );
    await act(async () =>
      root.render(
        navigate ? <MessageNavigationProvider value={navigate}>{content}</MessageNavigationProvider> : content,
      ),
    );
  }
  const text = () => container.querySelector('[data-testid="execution-row-text"]')?.textContent;
  const locate = () => container.querySelector<HTMLButtonElement>('[data-testid="execution-row-locate"]');

  it('names a live reply, scrolls to its exact child bubble and opens its original record', async () => {
    await render(execution());
    expect(text()).toContain('砚砚 · GPT-6.1 Sol 处理中');
    expect(locate()).not.toBeNull();
    await act(async () => locate()?.click());
    expect(scroll.mock.instances).toContain(container.querySelector('[data-message-id="original-writing-message"]'));
    expect(container.querySelector('[data-testid="original-record"]')?.getAttribute('data-expanded')).toBe('true');
  });

  it('hands the exact live message to this chat reading owner so streaming cannot reclaim bottom follow', async () => {
    const navigate = vi.fn(() => true);
    await render(execution(), navigate);
    await act(async () => locate()?.click());
    expect(navigate).toHaveBeenCalledWith(message.id);
    expect(container.querySelector('[data-testid="original-record"]')?.getAttribute('data-expanded')).toBe('true');
  });

  it.each([
    'full_gate',
    'test',
    'build',
  ] as const)('names managed %s distinctly and exposes its location', async (activity) => {
    await render(
      execution({
        kind: 'managed_command',
        executionId: 'hold-exact',
        turnInvocationId: undefined,
        activity,
        cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'hold-exact' } },
      }),
    );
    expect(text()).toContain('砚砚 · GPT-6.1 Sol 在跑');
    expect(locate()).not.toBeNull();
  });

  it('keeps the type distinction when language changes', async () => {
    await render(execution());
    act(() => writeShellLanguage('en'));
    expect(text()).toContain('working');
  });
  it('keeps running words in the narrow managed row, in both languages', async () => {
    await render(execution({ kind: 'managed_command', activity: 'full_gate' }));
    expect(container.querySelector('[data-testid="execution-row-text-compact"]')?.textContent).toContain(
      '在跑全量门禁',
    );
    act(() => writeShellLanguage('en'));
    expect(container.querySelector('[data-testid="execution-row-text-compact"]')?.textContent).toContain(
      'running full gate',
    );
  });

  it.each([
    { turnInvocationId: undefined },
    { turnInvocationId: 'missing-child' },
    { turnInvocationId: 'parent' },
  ])('does not substitute a parent or newer message for an unavailable target %j', async (over) => {
    await render(execution(over));
    expect(locate()).not.toBeNull();
    await act(async () => locate()?.click());
    expect(scroll).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('读不到这次执行的位置');
  });

  it('refuses a target removed after the row rendered', async () => {
    const run = execution();
    await render(run);
    act(() => useActiveExecutionStore.getState().reset());
    // An event queued by the browser may still hold the original button: it must recheck canonical truth.
    await act(async () => locate()?.click());
    expect(scroll).not.toHaveBeenCalled();
  });
  it('reports an exact cached reply whose original DOM is unreadable instead of leaving a pending jump', async () => {
    await render(execution());
    container.querySelector('[data-message-id]')?.removeAttribute('data-message-id');
    await act(async () => locate()?.click());
    expect(scroll).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('读不到这次执行的位置');
  });
});
