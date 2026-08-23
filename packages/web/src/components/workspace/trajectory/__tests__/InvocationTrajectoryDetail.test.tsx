import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type InvocationDetailResponse, InvocationTrajectoryDetail } from '../InvocationTrajectoryDetail';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

const summary = {
  invocationId: 'inv-b1',
  threadId: 'thread-f299',
  sessionId: 'session-f299',
  sessionSeq: 0,
  sessionStatus: 'active' as const,
  catId: 'codex-sol',
  status: 'running' as const,
  startedAt: 1_000,
  durationMs: 0,
  eventCount: 0,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 0,
  errorCount: 0,
  toolNames: [],
  keyMessages: [],
};

function event(eventNo: number, payload: Record<string, unknown>) {
  return {
    v: 1,
    t: 1_000 + eventNo,
    threadId: 'thread-f299',
    catId: 'codex-sol',
    sessionId: 'session-f299',
    invocationId: 'inv-b1',
    eventNo,
    event: payload,
  };
}

describe('F299 B.1 InvocationTrajectoryDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input.startsWith('/api/debug/prompt-captures?')) return { ok: true, json: async () => [] };
      if (input.startsWith('/api/telemetry/traces?')) {
        return { ok: true, json: async () => ({ spans: [], count: 0 }) };
      }
      if (input.startsWith('/api/recall/trajectories?')) {
        return { ok: true, json: async () => ({ trajectories: [] }) };
      }
      throw new Error(`Unexpected owner request: ${input}`);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('opens with canonical prompt input and renders semantic labels, icons, provenance, and monotonic counts', async () => {
    const onOpenPromptMessage = vi.fn();
    const detail: InvocationDetailResponse = {
      invocationId: 'inv-b1',
      total: 8,
      summary: {
        ...summary,
        durationMs: 20,
        eventCount: 8,
        toolUseCount: 1,
        toolResultCount: 1,
        messageCount: 2,
        toolNames: ['exec_command'],
      },
      promptInput: {
        status: 'available',
        messages: [
          {
            messageId: 'message-trigger',
            status: 'available',
            author: 'user',
            excerpt: '请检查这轮工具为什么失败',
          },
        ],
      },
      events: [
        event(0, { type: 'user', content: 'trigger' }),
        event(1, { type: 'text', content: 'working' }),
        event(2, { type: 'system', content: 'runtime policy' }),
        event(3, { type: 'context', content: 'thread context' }),
        event(4, {
          type: 'tool_use',
          toolName: 'exec_command',
          toolUseId: 'tool-1',
          toolSource: 'host_cli',
          toolChannel: 'commentary',
        }),
        event(5, {
          type: 'tool_result',
          toolUseId: 'tool-1',
          toolResultStatus: 'ok',
          content: 'done',
        }),
        event(6, { type: 'error', error: 'failed' }),
        event(7, { type: 'done' }),
      ],
    };

    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={detail}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={onOpenPromptMessage}
        />,
      );
    });

    expect(container.textContent).toContain('触发输入');
    expect(container.textContent).toContain('请检查这轮工具为什么失败');
    expect(container.textContent).toContain('1 / 2');
    expect(container.querySelector('[data-testid="trajectory-role-legend"]')).toBeNull();
    expect(container.textContent).not.toContain('Filter');
    const roleSurfaceTokens = {
      user: '--conn-blue-bubble-bg',
      assistant: '--conn-purple-bubble-bg',
      system: '--conn-gray-bubble-bg',
      context: '--conn-green-bubble-bg',
      tool: '--conn-amber-bubble-bg',
      error: '--conn-red-bubble-bg',
    } as const;
    for (const role of ['user', 'assistant', 'system', 'context', 'tool', 'error'] as const) {
      const row = container.querySelector(`[data-semantic-role="${role}"]`);
      expect(row, role).not.toBeNull();
      expect(row?.querySelector('svg[aria-hidden="true"]'), role).not.toBeNull();
      expect((row as HTMLElement).style.backgroundImage, role).toContain('linear-gradient');
      expect((row as HTMLElement).style.backgroundImage, role).toContain(roleSurfaceTokens[role]);
      expect((row as HTMLElement).style.backgroundImage, role).toContain('--cafe-surface-canvas');
    }
    const tool = container.querySelector('[data-semantic-role="tool"]');
    expect(tool?.textContent).toContain('exec_command');
    expect(tool?.textContent).toContain('HOST CLI');
    expect(tool?.textContent).toContain('commentary');
    expect(tool?.textContent).toContain('ok');

    const source = container.querySelector<HTMLButtonElement>('[data-message-id="message-trigger"]');
    expect(source?.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(source?.textContent).not.toContain('↗');
    await act(async () => source?.click());
    expect(onOpenPromptMessage).toHaveBeenCalledWith('message-trigger');

    const rawTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Raw');
    await act(async () => rawTab?.click());
    expect(container.querySelectorAll('pre[data-raw-event-no]')).toHaveLength(8);
  });

  it('shows only evidence links that their source owners resolve at read time', async () => {
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === '/api/debug/prompt-captures?invocationId=inv-b1') {
        return { ok: true, json: async () => [{ captureId: '00000000-0000-0000-0000-000000000017' }] };
      }
      if (input === '/api/telemetry/traces?invocationId=inv-b1&limit=1') {
        return { ok: true, json: async () => ({ spans: [{ traceId: 'trace-17' }], count: 1 }) };
      }
      if (input === '/api/recall/trajectories?invocationId=inv-b1&limit=1') {
        return { ok: true, json: async () => ({ trajectories: [{ trajectoryId: 'trajectory-17' }] }) };
      }
      throw new Error(`Unexpected owner request: ${input}`);
    });

    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={{ invocationId: 'inv-b1', total: 0, events: [], summary }}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={vi.fn()}
        />,
      );
    });
    await act(async () => {});

    const ownerLinks = container.querySelector('[data-testid="source-owned-evidence-links"]');
    const links = ownerLinks?.querySelectorAll('[data-testid="source-owned-evidence-link"]') ?? [];
    expect(links).toHaveLength(3);
    expect(container.textContent).toContain('Prompt X-Ray');
    expect(container.textContent).toContain('Trace');
    expect(container.textContent).toContain('Task trajectory');
    expect(ownerLinks?.textContent).not.toContain('不可用');
    expect(ownerLinks?.textContent).not.toContain('缺失');
  });

  it('omits owner sources that are absent or inaccessible without inventing an absent reason', async () => {
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });

    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={{ invocationId: 'inv-b1', total: 0, events: [], summary }}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={vi.fn()}
        />,
      );
    });
    await act(async () => {});

    expect(container.querySelector('[data-testid="source-owned-evidence-links"]')).toBeNull();
    expect(container.textContent).not.toContain('owner unavailable');
  });

  it('renders typed prompt absence without inventing an original message link', async () => {
    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={{
            invocationId: 'inv-b1',
            total: 0,
            events: [],
            summary,
            promptInput: {
              status: 'available',
              messages: [{ messageId: 'message-deleted', status: 'deleted' }],
            },
          }}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain('原消息已删除');
    expect(container.querySelector('[data-message-id="message-deleted"]')).toBeNull();
  });

  it('labels a cat-authored trigger with its canonical author role', async () => {
    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={{
            invocationId: 'inv-b1',
            total: 0,
            events: [],
            summary,
            promptInput: {
              status: 'available',
              messages: [
                {
                  messageId: 'message-assistant-trigger',
                  status: 'available',
                  author: 'assistant',
                  excerpt: '@codex-sol 请继续',
                },
              ],
            },
          }}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={vi.fn()}
        />,
      );
    });

    const prompt = Array.from(container.querySelectorAll('[data-semantic-role="assistant"]')).find((node) =>
      node.textContent?.includes('触发输入'),
    );
    expect(prompt?.textContent).toContain('ASSISTANT');
    expect(prompt?.textContent).toContain('@codex-sol 请继续');
  });

  it('keeps failed results typed as TOOL while giving the card error-priority styling', async () => {
    await act(async () => {
      root.render(
        <InvocationTrajectoryDetail
          summary={summary}
          detail={{
            invocationId: 'inv-b1',
            total: 1,
            summary,
            events: [event(0, { type: 'tool_result', toolName: 'command_execution', toolResultStatus: 'error' })],
          }}
          loading={false}
          error={false}
          onBack={vi.fn()}
          onRetry={vi.fn()}
          onOpenPromptMessage={vi.fn()}
        />,
      );
    });

    const failedTool = container.querySelector('[data-semantic-role="tool"]');
    expect(failedTool?.textContent).toContain('TOOL');
    expect(failedTool?.className).toContain('border-conn-red-ring');
    expect(container.querySelector('[data-semantic-role="error"]')).toBeNull();
  });
});
