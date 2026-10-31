import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvocationTrajectoryDetail } from '../InvocationTrajectoryDetail';
import { InvocationTrajectoryList } from '../InvocationTrajectoryList';
import { SemanticTimelineRow } from '../trajectory-semantic-cards';

const mocks = vi.hoisted(() => ({ shell: 'v2', copy: vi.fn() }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => mocks.shell }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) =>
      id === 'codex61-sol'
        ? { displayName: '小太阳', avatar: '/registry/sol.png', color: { primary: '#123456' } }
        : undefined,
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) }));

const summary = {
  invocationId: 'invocation-with-a-very-long-exact-value',
  threadId: 'thread-1',
  sessionId: 'session-exact',
  sessionSeq: 2,
  sessionStatus: 'sealed' as const,
  catId: 'codex61-sol',
  status: 'done' as const,
  startedAt: 1000,
  durationMs: 2000,
  eventCount: 3,
  statusEventCount: 0,
  toolUseCount: 1,
  toolResultCount: 0,
  messageCount: 2,
  errorCount: 0,
  toolNames: ['Read'],
  keyMessages: ['You，'],
};

describe('F322 v2 trajectory clarity', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    mocks.shell = 'v2';
    mocks.copy.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy } });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(node: React.ReactNode) {
    await act(async () => root.render(node));
  }

  it('uses the registry identity, Chinese counts, and independently focusable exact ID copies', async () => {
    const open = vi.fn();
    await render(
      <InvocationTrajectoryList
        invocations={[summary]}
        loading={false}
        error={null}
        onOpen={open}
        onRetry={() => {}}
      />,
    );
    expect(container.textContent).toContain('小太阳');
    expect(container.textContent).toContain('1 个工具 · 2 条消息 · 0 条状态');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/registry/sol.png');
    for (const [label, value] of [
      ['调用', summary.invocationId],
      ['会话', summary.sessionId],
    ]) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="复制${label} ID：${value}"]`);
      expect(button).not.toBeNull();
      expect(button?.tabIndex).toBe(0);
      await act(async () => button?.click());
      expect(mocks.copy).toHaveBeenLastCalledWith(value);
      expect(open).not.toHaveBeenCalled();
      expect(container.textContent).toContain('已复制');
    }
  });

  it('reports a rejected clipboard write accurately', async () => {
    mocks.copy.mockRejectedValue(new Error('denied'));
    await render(
      <InvocationTrajectoryList
        invocations={[summary]}
        loading={false}
        error={null}
        onOpen={() => {}}
        onRetry={() => {}}
      />,
    );
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="复制调用 ID"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(container.textContent).toContain('复制失败');
    expect(container.textContent).not.toContain('已复制');
  });

  it('renders the proven full first sentence without clipping or borrowing later output, and preserves classic preview', async () => {
    const sentence = `You，${'这是同一条原生输出的完整首句'.repeat(20)}。`;
    const proven = {
      ...summary,
      firstAssistantOutputEvidence: {
        role: 'assistant' as const,
        complete: true,
        status: 'available' as const,
        channel: 'commentary' as const,
        identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'a' },
        content: `${sentence}后句不补位。`,
        byteLength: 3000,
        source: {
          sessionId: summary.sessionId,
          invocationId: summary.invocationId,
          firstEventNo: 0,
          lastEventNo: 1,
          eventCount: 2,
        },
      },
    };
    const props = { loading: false, error: null, onOpen: () => {}, onRetry: () => {} };
    await render(<InvocationTrajectoryList {...props} invocations={[proven]} />);
    expect(container.querySelector('[data-testid="first-assistant-preview"]')?.textContent).toBe(sentence);
    expect(container.textContent).not.toContain('后句不补位');
    await render(
      <InvocationTrajectoryList
        {...props}
        invocations={[
          { ...proven, firstAssistantOutputEvidence: { ...proven.firstAssistantOutputEvidence, content: 'You，' } },
        ]}
      />,
    );
    expect(container.querySelector('[data-testid="first-assistant-preview-label"]')?.textContent).toBe(
      '首句边界未确认',
    );
    expect(container.querySelector('[data-testid="first-assistant-preview-content"]')?.textContent).toBe('You，');
    expect(container.querySelector('[data-testid="first-assistant-preview"]')?.getAttribute('data-preview-kind')).toBe(
      'boundary_unconfirmed',
    );
    expect(container.textContent).not.toContain('完整首句');
    mocks.shell = 'classic';
    await render(<InvocationTrajectoryList {...props} invocations={[proven]} />);
    expect(container.textContent).toContain('You，');
    expect(container.textContent).not.toContain(sentence);
  });

  it('shows one unknown provenance and keeps actual tool names and role colour frames', async () => {
    await render(
      <SemanticTimelineRow
        row={{ id: 't', kind: 'tool', timestamp: 1, toolName: 'exec_command', source: 'unknown', channel: 'unknown' }}
      />,
    );
    expect(container.textContent?.match(/来源未知/g)).toHaveLength(1);
    expect(container.textContent).toContain('运行中');
    expect(container.textContent).toContain('exec_command');
    expect(container.querySelector('[data-semantic-role="tool"]')?.className).toContain('border-conn-amber-ring');
  });

  it('keeps model input after the timeline and preserves the raw records tab', async () => {
    await render(
      <InvocationTrajectoryDetail
        summary={summary}
        loading={false}
        error={false}
        onBack={() => {}}
        onRetry={() => {}}
        onOpenPromptMessage={() => {}}
        detail={{
          invocationId: summary.invocationId,
          total: 1,
          summary,
          events: [
            {
              v: 1,
              t: 1,
              eventNo: 0,
              threadId: summary.threadId,
              sessionId: summary.sessionId,
              catId: summary.catId,
              invocationId: summary.invocationId,
              event: { type: 'text', content: '实际回答。' },
            },
          ],
        }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('实际回答。')).toBeLessThan(text.indexOf('这一轮实际发给模型的输入'));
    expect(text).toContain('原始记录');
    expect(text).toContain('‹ 轨迹');
    expect(container.querySelectorAll('[data-semantic-role="assistant"]')).toHaveLength(1);
  });

  it('preserves classic labels and the legacy list preview', async () => {
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
    expect(container.textContent).toContain('codex61-sol');
    expect(container.textContent).toContain('Session #3');
    expect(container.textContent).toContain('1 tools · 2 messages · 0 status');
    expect(container.textContent).toContain('You，');
    expect(container.querySelector('button[aria-label^="复制调用 ID"]')).toBeNull();
    await render(
      <SemanticTimelineRow
        row={{ id: 't', kind: 'tool', timestamp: 1, toolName: 'Read', source: 'unknown', channel: 'unknown' }}
      />,
    );
    expect(container.textContent).toContain('TOOL');
    expect(container.textContent?.match(/unknown/g)).toHaveLength(2);
    expect(container.textContent).toContain('running');
  });

  it('localizes the synthesized completion marker without rewriting message content or classic', async () => {
    const marker = { id: 'done', kind: 'terminal' as const, timestamp: 1, content: 'done' };
    await render(<SemanticTimelineRow row={marker} />);
    expect(container.textContent).toBe('系统完成');
    await render(<SemanticTimelineRow row={{ ...marker, kind: 'message', role: 'assistant' }} />);
    expect(container.textContent).toBe('猫done');
    mocks.shell = 'classic';
    await render(<SemanticTimelineRow row={marker} />);
    expect(container.textContent).toBe('SYSTEMdone');
  });
});
