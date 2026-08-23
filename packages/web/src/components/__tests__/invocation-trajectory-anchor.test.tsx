import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
