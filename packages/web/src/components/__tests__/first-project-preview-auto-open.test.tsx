// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFirstProjectPreviewAutoOpen } from '../first-run-quest/useFirstProjectPreviewAutoOpen';

function Probe({
  phase,
  messageCount,
  hasActiveInvocation,
  worktreeId,
  threadId = 'thread-1',
}: {
  phase?: string;
  messageCount: number;
  hasActiveInvocation: boolean;
  worktreeId: string | null;
  threadId?: string;
}) {
  useFirstProjectPreviewAutoOpen({
    phase,
    messageCount,
    hasActiveInvocation,
    worktreeId,
    threadId,
  });

  return <div data-probe="ready" />;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useFirstProjectPreviewAutoOpen', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not auto-open merely because phase-4 already has history', async () => {
    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={false} worktreeId="wt-1" />);
    });
    await flushEffects();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-opens the latest reachable preview after new phase-4 output finishes', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { port: 4173, reachable: true, discoveredAt: 1, worktreeId: 'wt-1' },
          { port: 5173, reachable: true, discoveredAt: 2, worktreeId: 'wt-1' },
        ],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ allowed: true }),
      } as Response);

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={true} worktreeId="wt-1" />);
    });
    await flushEffects();

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={3} hasActiveInvocation={true} worktreeId="wt-1" />);
    });
    await flushEffects();

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={3} hasActiveInvocation={false} worktreeId="wt-1" />);
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/preview/discovered?worktreeId=wt-1');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/preview/auto-open');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      port: 5173,
      path: '/',
      threadId: 'thread-1',
      worktreeId: 'wt-1',
    });
  });

  it('refuses to guess a preview port from multiple global servers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { port: 4173, reachable: true, discoveredAt: 1, worktreeId: 'wt-a' },
        { port: 5173, reachable: true, discoveredAt: 2, worktreeId: 'wt-b' },
      ],
    } as Response);

    await act(async () => {
      root.render(
        <Probe phase="phase-7-dev" messageCount={1} hasActiveInvocation={true} worktreeId={null} threadId="thread-7" />,
      );
    });
    await flushEffects();

    await act(async () => {
      root.render(
        <Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={true} worktreeId={null} threadId="thread-7" />,
      );
    });
    await flushEffects();

    await act(async () => {
      root.render(
        <Probe
          phase="phase-7-dev"
          messageCount={2}
          hasActiveInvocation={false}
          worktreeId={null}
          threadId="thread-7"
        />,
      );
    });
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/preview/discovered');
  });
});
