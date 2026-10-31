import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { SHELL_LANGUAGE_STORAGE_KEY } from '../shell/shell-language';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  tool,
  toolResult,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('F322 B §1.16 — reply status (layer 2)', () => {
  let harness: ReplyLayersHarness;

  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);

  beforeEach(() => {
    harness = new ReplyLayersHarness();
    harness.enableV2();
  });

  afterEach(() => harness.dispose());

  const render = (message: Parameters<ReplyLayersHarness['render']>[0]) => harness.render(message);
  const q = (testId: string) => harness.q(testId);

  it('writing: a streaming reply with no tool call yet', () => {
    render(streamReply({ isStreaming: true, toolEvents: undefined, content: '先看一下现状' }));

    expect(q('reply-status')?.textContent).toBe('正在写回复');
    expect(q('reply-status')?.getAttribute('data-status')).toBe('working');
    expect(q('reply-record')).toBeNull();
  });

  it('working: a proven short executable is visible, full arguments stay in the tooltip and record', () => {
    render(
      streamReply({
        isStreaming: true,
        toolEvents: [tool('t1', 'Bash', JSON.stringify({ command: 'pnpm test' }))],
      }),
    );

    expect(q('reply-status')?.textContent).toBe('正在运行命令 pnpm');
    expect(q('reply-status-param')).toBeNull();
    expect(q('reply-last-line')?.textContent).not.toContain('pnpm test');
    harness.click('reply-record-toggle');
    expect(q('reply-record')?.textContent).toContain('pnpm test');
    harness.click('reply-record-toggle');
    expect(q('reply-activity-cat')?.getAttribute('data-tone')).toBe('info');
    expect(q('reply-last-line')?.textContent).toContain('1 次工具调用');
    expect(q('reply-last-line')?.textContent).not.toContain('6 分 42 秒');
    expect(q('reply-record')).toBeNull();
  });

  it('a running reply does not publish terminal duration or error totals before the turn ends', () => {
    render(
      streamReply({
        isStreaming: true,
        toolEvents: [tool('t1', 'Bash'), toolResult('t1', 'boom', 'error'), tool('t2', 'Read')],
      }),
    );

    expect(q('reply-last-line')?.textContent).toContain('2 次工具调用');
    expect(q('reply-last-line')?.textContent).not.toContain('6 分 42 秒');
    expect(q('reply-last-line')?.textContent).not.toContain('其中 1 次出错');
  });

  it('uses a running reconciliation phase for both the last line and unresolved record rows', () => {
    render(
      streamReply({
        isStreaming: false,
        toolEvents: [tool('t1', 'Read')],
        lifecycle: {
          kind: 'response',
          orderKey: '1',
          invocationId: 'turn-1',
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'processing',
          startedAt: 1,
        },
        extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
      }),
    );

    expect(q('reply-status')?.getAttribute('data-status')).toBe('working');
    harness.click('reply-record-toggle');
    expect(q('reply-record-tool-t1')?.getAttribute('data-state')).toBe('running');
  });

  it('lets a terminal phase stop both the last line and unresolved record rows despite stale streaming', () => {
    render(
      streamReply({
        isStreaming: true,
        toolEvents: [tool('t1', 'Read')],
        lifecycle: {
          kind: 'response',
          orderKey: '1',
          invocationId: 'turn-1',
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'canceled',
          startedAt: 1,
        },
        extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
      }),
    );

    expect(q('reply-status')?.getAttribute('data-status')).toBe('stopped');
    harness.click('reply-record-toggle');
    expect(q('reply-record-tool-t1')?.getAttribute('data-state')).toBe('unconfirmed');
  });

  it('English wording follows the shell language', () => {
    window.localStorage.setItem(SHELL_LANGUAGE_STORAGE_KEY, 'en');
    render(
      streamReply({ isStreaming: true, toolEvents: [tool('t1', 'Edit', JSON.stringify({ file_path: '/a.ts' }))] }),
    );

    expect(q('reply-status')?.textContent).toBe('Editing files a.ts');
    expect(q('reply-last-line')?.textContent).toContain('1 tool call');
    expect(q('reply-last-line')?.textContent).toContain('Trajectory');
  });

  it("quiet: only when the cat's liveness belongs to THIS reply's turn", () => {
    useChatStore.setState({
      catStatuses: { opus: 'alive_but_silent' },
      catInvocations: { opus: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
    });
    render(streamReply({ isStreaming: true }));

    expect(q('reply-status')?.getAttribute('data-status')).toBe('quiet');
    expect(q('reply-status')?.textContent).toBe('没有动静');
    expect(q('reply-status-dot')?.getAttribute('data-tone')).toBe('warning');
  });

  it('the cat already on its next run is not borrowed: this reply keeps saying what it was doing', () => {
    useChatStore.setState({
      catStatuses: { opus: 'alive_but_silent' },
      catInvocations: { opus: { invocationId: 'parent-1', turnInvocationId: 'turn-2' } },
    });
    render(streamReply({ isStreaming: true }));

    expect(q('reply-status')?.getAttribute('data-status')).toBe('working');
  });

  it('a legacy reply without a turn id never borrows silence from a newer turn under the same parent', () => {
    useChatStore.setState({
      catStatuses: { opus: 'alive_but_silent' },
      catInvocations: { opus: { invocationId: 'parent-1', turnInvocationId: 'turn-2' } },
    });
    render(
      streamReply({
        isStreaming: true,
        extra: { stream: { invocationId: 'parent-1' } },
      }),
    );

    expect(q('reply-status')?.getAttribute('data-status')).toBe('working');
  });

  it('unknown_running: "状态暂不可核对" with the hollow dot', () => {
    render(
      streamReply({
        isStreaming: true,
        lifecycle: {
          kind: 'response',
          orderKey: '1',
          invocationId: 'turn-1',
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'interrupted',
          startedAt: 1,
        },
        extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
      }),
    );

    expect(q('reply-status')?.textContent).toBe('已停止');
    expect(q('reply-status-dot')?.getAttribute('data-tone')).toBe('neutral');
  });

  it.each([
    ['failed', '没有完成', 'critical'],
    ['canceled', '已停止', 'neutral'],
  ] as const)('a reply that ended as %s says "%s"', (phase, words, tone) => {
    render(
      streamReply({
        lifecycle: {
          kind: 'response',
          orderKey: '1',
          invocationId: 'turn-1',
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: phase,
          startedAt: 1,
        },
        extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
      }),
    );

    expect(q('reply-status')?.textContent).toBe(words);
    expect(q('reply-status-dot')?.getAttribute('data-tone')).toBe(tone);
  });

  it('a normal finish says nothing: no "已完成"', () => {
    render(streamReply());
    expect(q('reply-status')).toBeNull();
    expect(harness.container.textContent).not.toContain('已完成');
  });
});
