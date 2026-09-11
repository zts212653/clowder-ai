import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import type { ChatMessage } from '@/stores/chat-types';
import { describeMessageInvocationTrajectory, InvocationTrajectoryAnchor } from '../InvocationTrajectoryAnchor';

function message(phase: 'succeeded' | 'failed' | 'canceled' | 'running', withTimeout = false): ChatMessage {
  return {
    id: `message-${phase}`,
    type: 'assistant',
    catId: 'codex-sol',
    content: 'reply',
    timestamp: 1,
    extra: {
      stream: { turnInvocationId: `inv-${phase}` },
      invocationReconciliation: {
        v: 1,
        invocationId: `parent-${phase}`,
        catIds: ['codex-sol'],
        turnInvocationIds: [`inv-${phase}`],
        phase,
        updatedAt: 2,
      },
      ...(withTimeout
        ? {
            timeoutDiagnostics: {
              silenceDurationMs: 30_000,
              processAlive: false,
            },
          }
        : {}),
    },
  };
}

describe('F299 message invocation anchor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
    window.history.replaceState({}, '', '/');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), hydrated: false });
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('derives done, error, cancelled and timeout from existing message evidence', () => {
    expect(describeMessageInvocationTrajectory(message('succeeded'))?.status).toBe('done');
    expect(describeMessageInvocationTrajectory(message('failed'))?.status).toBe('error');
    expect(describeMessageInvocationTrajectory(message('canceled'))?.status).toBe('cancelled');
    expect(describeMessageInvocationTrajectory(message('failed', true))?.status).toBe('timeout');
    expect(
      describeMessageInvocationTrajectory({
        id: 'system-error',
        type: 'system',
        variant: 'error',
        catId: 'codex-sol',
        content: 'Error: provider failed',
        timestamp: 1,
        extra: {
          cliDiagnostics: {
            publicSummary: 'Provider failed',
            publicHint: 'Retry',
            debugRef: { command: 'codex', signal: null, invocationId: 'inv-system-error' },
          },
        },
      })?.status,
    ).toBe('error');
  });

  it('uses the response lifecycle when an empty canceled response has no reconciliation text evidence', () => {
    const canceled: ChatMessage = {
      id: 'response-canceled',
      type: 'assistant',
      catId: 'codex-sol',
      content: '',
      timestamp: 1,
      extra: { stream: { turnInvocationId: 'turn-canceled' } },
      lifecycle: {
        kind: 'response',
        orderKey: '1:turn-canceled',
        invocationId: 'turn-canceled',
        targetId: 'codex-sol',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['source-1'],
        startedAt: 1,
        status: 'canceled',
        completedAt: 2,
        reason: 'user_cancel',
      },
    };

    expect(describeMessageInvocationTrajectory(canceled)).toEqual({
      invocationId: 'turn-canceled',
      status: 'cancelled',
    });
  });

  it('keeps done quiet but abnormal anchors persistent and both keyboard buttons', () => {
    const open = vi.fn();
    act(() => {
      root.render(
        <div className="group">
          <InvocationTrajectoryAnchor message={message('succeeded')} threadId="thread-a" onOpen={open} />
          <InvocationTrajectoryAnchor message={message('failed')} threadId="thread-a" onOpen={open} />
        </div>,
      );
    });
    const done = container.querySelector<HTMLElement>('[data-trajectory-status="done"]');
    const error = container.querySelector<HTMLElement>('[data-trajectory-status="error"]');
    expect(done?.className).toContain('opacity-0');
    expect(done?.className).toContain('group-focus-within:opacity-100');
    expect(done?.className).toContain('[@media(hover:none)_and_(pointer:coarse)]:opacity-100');
    expect(error?.className).not.toContain('opacity-0');
    expect(done?.tagName).toBe('BUTTON');
    expect(error?.tagName).toBe('BUTTON');
  });

  it('opens a real Agent Run descriptor in the default F307 Workbench', async () => {
    window.history.replaceState({}, '', '/thread/thread-a');
    await act(async () => {
      root.render(<InvocationTrajectoryAnchor message={message('running')} threadId="thread-a" />);
    });

    const button = container.querySelector<HTMLButtonElement>('[data-invocation-anchor="inv-running"]');
    await act(async () => button?.click());

    expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces).toEqual([
      expect.objectContaining({
        type: 'agent-run',
        objectRef: { kind: 'agent-run', id: 'inv-running' },
        ownerStateRef: { owner: 'f299-invocation-trajectory', key: 'thread-a:inv-running' },
        resultTargetRef: { owner: 'thread-message', key: 'thread-a:message-running' },
      }),
    ]);
  });
});
