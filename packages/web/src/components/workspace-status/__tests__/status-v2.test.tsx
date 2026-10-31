import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RightStatusPanelProps } from '@/components/RightStatusPanel';
import { __resetSessionChainCacheForTest } from '@/components/SessionChainPanel';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceStatusPanelV2 } from '../WorkspaceStatusPanelV2';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: ['codex61-sol', 'opus55', 'gemini'].map((id) => ({ id, displayName: id })),
    getCatById: (id: string) => ({ id, displayName: id }),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span /> }));
vi.mock('@/components/PlanBoardPanel', () => ({ PlanBoardPanel: () => null }));
vi.mock('@/components/CloudConversationLink', () => ({ CloudConversationLink: () => <div>ChatGPT 未绑定</div> }));
vi.mock('@/components/BindNewSessionSection', () => ({
  BindNewSessionSection: () => <button type="button">绑定命令行会话</button>,
}));

const health = (ratio: number, windowTokens = 100000) => ({
  usedTokens: ratio * windowTokens,
  windowTokens,
  fillRatio: ratio,
  source: 'exact' as const,
  measuredAt: 1,
});
const session = (id: string, catId: string, ratio?: number, status = 'active', seq = 0) => ({
  id,
  cliSessionId: `complete-cli-${id}-0123456789`,
  catId,
  seq,
  status,
  createdAt: 100,
  messageCount: 12,
  compressionCount: 0,
  ...(ratio === undefined ? {} : { contextHealth: health(ratio) }),
});
const records = [
  session('sol-current', 'codex61-sol', 0.18),
  session('opus-current', 'opus55', 0.2),
  session('gemini-a', 'gemini', 0.84),
  session('gemini-b', 'gemini', 0.09, 'active', 1),
  session('sol-old', 'codex61-sol', 0.08, 'sealed'),
];
const props: RightStatusPanelProps = {
  threadId: 'isolated-thread-a',
  intentMode: 'execute',
  targetCats: ['codex61-sol', 'opus55', 'gemini'],
  catStatuses: { opus55: 'streaming', 'codex61-sol': 'done', gemini: 'done' },
  catInvocations: {
    opus55: { invocationId: 'full-opus-invocation', contextHealth: health(0.62), startedAt: 100 },
    gemini: { invocationId: 'stale-gemini-invocation', contextHealth: health(0.95) },
  },
  activeInvocations: { 'full-opus-invocation': { catId: 'opus55', mode: 'execute', startedAt: 100 } },
  hasActiveInvocation: true,
  messageSummary: { total: 12, assistant: 8, system: 2, evidence: 1, followup: 1 },
};
let container: HTMLDivElement;
let root: Root;
async function render(next = props) {
  await act(async () => root.render(<WorkspaceStatusPanelV2 {...next} />));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetSessionChainCacheForTest();
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith('/sessions') ? { sessions: records } : {}),
  }));
  useChatStore.setState({ threads: [], currentThreadId: props.threadId });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('display of this conversation: the execution record (§1.16 合同四)', () => {
  const thread = (over: Record<string, unknown> = {}) => ({ id: props.threadId, title: 't', ...over });
  const setThread = (over: Record<string, unknown> = {}, bubbleDefault: 'collapsed' | 'expanded' = 'collapsed') =>
    useChatStore.setState({
      threads: [thread(over)] as never,
      currentThreadId: props.threadId,
      isLoadingThreads: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: bubbleDefault },
    });
  const row = () => container.querySelector('[data-testid="activity-record-toggle"]') as HTMLElement | null;

  it('says 执行记录 where it said 命令输出, and no longer offers 思考过程: the thinking lives inside the record', async () => {
    setThread();
    await render();
    expect(row()?.textContent).toContain('执行记录');
    expect(container.textContent).not.toContain('命令输出');
    expect(container.textContent).not.toContain('思考过程');
  });

  it('follows the default: reads 跟随默认 with what the default currently is, and offers the other state', async () => {
    setThread({}, 'collapsed');
    await render();
    expect(row()?.textContent).toContain('跟随默认（当前收起）');
    expect(row()?.querySelector('button')?.textContent).toBe('展开');
    await act(async () => setThread({}, 'expanded'));
    await render();
    expect(row()?.textContent).toContain('跟随默认（当前展开）');
    expect(row()?.querySelector('button')?.textContent).toBe('收起');
  });

  it("this conversation's own choice reads 展开 / 收起 and cycles on to the next, through the same PATCH", async () => {
    setThread({ bubbleCli: 'expanded' });
    await render();
    expect(row()?.textContent).toContain('执行记录: 展开');
    expect(row()?.querySelector('button')?.textContent).toBe('收起');
    await act(async () => row()?.querySelector('button')?.click());
    expect(useChatStore.getState().threads[0]?.bubbleCli).toBe('collapsed');
    const patch = fetchMock.mock.calls.find((call) => String(call[0]).endsWith(`/api/threads/${props.threadId}`));
    expect(JSON.parse((patch?.[1] as { body: string }).body)).toEqual({ bubbleCli: 'collapsed' });
    expect(row()?.querySelector('button')?.textContent).toBe('跟随默认');
  });

  it('speaks English when the shell does', async () => {
    window.localStorage.setItem('cat-cafe:shell-language', 'en');
    setThread({ bubbleCli: 'collapsed' });
    await render();
    expect(row()?.textContent).toContain('Activity: Collapsed');
    expect(row()?.querySelector('button')?.textContent).toBe('Use default');
    window.localStorage.removeItem('cat-cafe:shell-language');
  });

  it('keeps a named disabled action while the conversation preference is restoring', async () => {
    useChatStore.setState({
      threads: [],
      currentThreadId: props.threadId,
      isLoadingThreads: true,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
    });
    await render();
    const button = row()?.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('恢复中…');
  });
});

describe('approved v2 status presentation', () => {
  it('groups all current sessions once per cat and tints only actual running cats', async () => {
    await render();
    expect(container.querySelectorAll('[data-testid="status-cat-group"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="cat-nameplate"]')).toHaveLength(3);
    expect(container.querySelector('[data-cat-id="opus55"][data-running="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-running="true"]')).toHaveLength(1);
    expect(container.textContent).toContain('成员 3');
    expect(container.textContent).toContain('运行中 1');
    expect(container.textContent).toContain('对话信息');
    expect(container.textContent).toContain('可见性');
  });
  it('uses live health only for the unique running session, retaining per-record values', async () => {
    await render();
    for (const [id, percent] of [
      ['opus-current', '62%'],
      ['sol-current', '18%'],
      ['gemini-a', '84%'],
      ['gemini-b', '9%'],
    ]) {
      expect(container.querySelector(`[data-session-id="${id}"]`)?.textContent).toContain(percent);
    }
    expect(container.textContent).not.toContain('95%');
    const warning = container.querySelector('[data-session-id="gemini-a"]');
    expect(warning?.textContent).toContain('接近上限');
    expect(warning?.querySelector('[role="progressbar"]')?.getAttribute('data-near-limit')).toBe('true');
  });
  it('does not manufacture percentages when the window or measurement is unknown', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [
          session('unknown', 'codex61-sol'),
          { ...session('no-window', 'codex61-sol', 0.5), contextHealth: health(0.5, 0) },
        ],
      }),
    });
    await render({ ...props, activeInvocations: {}, catInvocations: {} });
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(container.querySelector('[data-session-id="unknown"]')?.textContent).toContain('上下文用量未知');
    expect(container.querySelector('[data-session-id="no-window"]')?.textContent).toContain('上限未知');
  });
  it('retains running/multiple-session action protections and keeps idle sealing available', async () => {
    await render();
    expect(
      (container.querySelector('[data-testid="compact-native-session-opus-current"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((container.querySelector('[data-testid="seal-session-opus-current"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (container.querySelector('[data-testid="compact-native-session-gemini-a"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((container.querySelector('[data-testid="seal-session-gemini-a"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(container.textContent).toContain('有 2 个未封存的会话');
  });
  it('places archived sessions under their cat and restores using the existing confirmation/CAS', async () => {
    await render();
    const toggle = container.querySelector('[data-testid="sealed-toggle-codex61-sol"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => toggle.click());
    expect(container.querySelector('[data-session-id="sol-old"]')?.textContent).toContain('8%');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const restore = container.querySelector('[data-testid="restore-session-sol-old"]') as HTMLButtonElement;
    await act(async () => restore.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/unseal'))).toBe(false);
    confirm.mockReturnValue(true);
    await act(async () => restore.click());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/sol-old/unseal',
      expect.objectContaining({ body: JSON.stringify({ expectedActiveSessionId: 'sol-current' }) }),
    );
  });
  it('does not expose synthesized hydration keys as runtime IDs', async () => {
    await render({
      ...props,
      catInvocations: {},
      activeInvocations: { 'hydrated-isolated-thread-a-opus55': { catId: 'opus55', mode: 'execute' } },
    });
    expect(container.textContent).not.toContain('hydrated-isolated-thread-a-opus55');
  });
  it.each(['runtime', 'legacy'] as const)('retains owner folding for %s zero-message retry fragments', async (kind) => {
    const fragments = Array.from({ length: kind === 'runtime' ? 8 : 2 }, (_, seq) => ({
      ...session(`retry-${seq}`, 'codex61-sol', undefined, 'sealed', seq),
      messageCount: 0,
      sealReason: kind === 'runtime' ? 'runtime_disconnected' : 'tool_conflict',
      ...(kind === 'runtime'
        ? {
            runtimeSession: {
              runtime: 'agy',
              runtimeSessionId: `native-retry-${seq}`,
              lifecycleState: 'sealed',
              retryFragment: { kind: 'retry' },
            },
          }
        : {}),
    }));
    const kept = [
      session('current', 'codex61-sol'),
      { ...session('content', 'codex61-sol', undefined, 'sealed'), sealReason: 'tool_conflict' },
      {
        ...session('sealing-retry', 'codex61-sol', undefined, 'sealing'),
        messageCount: 0,
        sealReason: 'tool_conflict',
      },
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [...kept, ...fragments] }) });
    await render({ ...props, targetCats: ['codex61-sol'], activeInvocations: {}, catInvocations: {} });
    const toggle = container.querySelector('[data-testid="sealed-toggle-codex61-sol"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.textContent).toContain(`${fragments.length} 次重试片段（已折叠`);
    expect(container.querySelectorAll('[data-session-id^="retry-"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid^="restore-session-retry-"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="restore-session-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="view-session-sealing-retry"]')).not.toBeNull();
  });
  it('shows one current-session ambiguity warning and the distinct archived restore reason', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [...records, session('gemini-old', 'gemini', 0.1, 'sealed')] }),
    });
    await render();
    const toggle = container.querySelector('[data-testid="sealed-toggle-gemini"]') as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(container.textContent?.match(/压缩前请确认当前使用的会话/g)).toHaveLength(1);
    const archived = container.querySelector('[data-session-id="gemini-old"]');
    expect(archived?.textContent).not.toContain('压缩前');
    expect(archived?.textContent).toContain('多个未封存会话，暂不能恢复');
  });
  it('discards an old thread read after changing thread', async () => {
    let completeOld: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeOld = resolve;
        }),
    );
    await render();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [] }) });
    await render({
      ...props,
      threadId: 'isolated-thread-b',
      targetCats: [],
      catInvocations: {},
      activeInvocations: {},
    });
    await act(async () => completeOld({ ok: true, json: async () => ({ sessions: records }) }));
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(0);
    expect(container.textContent).not.toContain('complete-cli-sol-current');
  });
  it('fails closed after a denied read, with retry and no binding actions', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: 'THREAD_ACCESS_DENIED' }) });
    await render();
    expect(container.querySelectorAll('[data-session-id]')).toHaveLength(0);
    expect(container.textContent).toContain('无权查看');
    expect(container.textContent).not.toContain('绑定命令行会话');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '重试')).toBe(true);
  });
  it('does not apply a late reveal response to another thread while decoding its body', async () => {
    let finishBody: (value: unknown) => void = () => {};
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/reveal')
        ? {
            ok: true,
            json: () =>
              new Promise((resolve) => {
                finishBody = resolve;
              }),
          }
        : { ok: true, json: async () => ({ sessions: records }) },
    );
    await render();
    const reveal = [...container.querySelectorAll('button')].find((button) => button.textContent === '全部揭晓');
    expect(reveal).toBeDefined();
    await act(async () => reveal?.click());
    useChatStore.setState({
      currentThreadId: 'isolated-thread-b',
      messages: [
        {
          id: 'b-whisper',
          type: 'assistant',
          catId: 'opus55',
          content: 'B private',
          visibility: 'whisper',
          timestamp: 1,
        },
      ],
    });
    await render({ ...props, threadId: 'isolated-thread-b' });
    await act(async () => finishBody({ revealed: 1 }));
    expect(useChatStore.getState().messages[0]?.revealedAt).toBeUndefined();
  });
});
