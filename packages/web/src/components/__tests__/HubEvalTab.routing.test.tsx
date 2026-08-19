import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const mockChatStoreState = vi.hoisted(() => ({
  currentThreadId: 'thread-current',
  threads: [{ id: 'thread-current', projectPath: '/tmp/current-project' }],
}));
const pushMock = vi.hoisted(() => vi.fn());
const setCurrentThreadMock = vi.hoisted(() => vi.fn());
const setCurrentProjectMock = vi.hoisted(() => vi.fn());
const setWorkspaceOpenFileMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: {
      currentThreadId: string;
      setCurrentThread: typeof setCurrentThreadMock;
      threads: Array<{ id: string; projectPath?: string }>;
      setCurrentProject: typeof setCurrentProjectMock;
      setWorkspaceOpenFile: typeof setWorkspaceOpenFileMock;
    }) => unknown,
  ) =>
    selector({
      currentThreadId: mockChatStoreState.currentThreadId,
      setCurrentThread: setCurrentThreadMock,
      threads: mockChatStoreState.threads,
      setCurrentProject: setCurrentProjectMock,
      setWorkspaceOpenFile: setWorkspaceOpenFileMock,
    }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { HubEvalTab } from '../HubEvalTab';

Object.assign(globalThis as Record<string, unknown>, { React });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const populatedSummary = {
  repoProjectPath: '/tmp/current-project',
  repoWorktreeId: 'cat-cafe',
  counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0, registeredDomains: 2 },
  domains: [
    {
      domainId: 'eval:a2a',
      displayName: 'A2A Harness Eval',
      systemThreadId: 'thread_eval_a2a',
      frequency: 'daily',
      evalCatHandle: '@codex',
      hasVerdict: true,
      latestVerdictId: '2026-05-23-eval-a2a-live-verdict',
      latestVerdict: 'keep_observe',
    },
    {
      domainId: 'eval:memory',
      displayName: 'Memory Recall & Library Health Eval',
      systemThreadId: 'thread_eval_memory',
      frequency: 'daily',
      evalCatHandle: '@opus47',
      hasVerdict: false,
    },
  ],
  items: [
    {
      id: '2026-05-23-eval-a2a-live-verdict',
      domainId: 'eval:a2a',
      packetId: 'vhp_eval_a2a_2026_05_23',
      feedbackType: 'live-verdict',
      verdict: 'keep_observe',
      phenomenon: 'No actionable A2A findings',
      operatorNarrative: {
        headline: '这轮没有发现要处理的问题',
        summary: '这次检查的是「猫和猫协作顺不顺」。本轮数据可用，没有发现达到处理门槛的问题。',
        action: '现在不用处理；保持观察即可。',
        nextCheck: '按现有频率继续观察；下一轮确认同类信号是否再次出现。',
        evidenceQuality: 'usable',
      },
      ownerAsk: 'No action required; keep observing the next scheduled eval.',
      harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'hold_ball (MCP tool)' },
      reeval: { nextEvalAt: '2026-05-26T03:12:57.174Z', status: 'observing', summary: 'next eval remains clean' },
      lifecycle: {
        availability: 'not_required',
        ownerResponseStatus: 'not_required',
        closureStatus: 'observing',
        reevalStatus: 'not_required',
        stale: false,
      },
      evidence: {
        snapshotRefs: ['snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot'],
        attributionRefs: ['attribution:bundle/2026-05-23-eval-a2a-live-verdict/eval-F167-2026-05-23:no-finding'],
        metricRefs: ['metric:c1.zombie_hold_count'],
        otherRefs: [],
      },
      trend: {
        generatedAt: '2026-05-23T03:12:57.172Z',
        window: { durationHours: 21.45 },
        components: [
          {
            componentId: 'C1',
            componentName: 'hold_ball (MCP tool)',
            confidence: 'medium',
            activationCounts: { hold_ball_calls: 0 },
            frictionCounts: { 'c1.zombie_hold_count': 0 },
          },
        ],
      },
      systemWorkspace: {
        kind: 'eval_domain',
        id: 'eval:a2a',
        label: 'A2A Harness Eval',
        threadId: 'thread_eval_a2a',
        stateSot: 'registry',
      },
      source: {
        verdictPath: 'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
        bundleDir: 'docs/harness-feedback/bundles/2026-05-23-eval-a2a-live-verdict',
      },
    },
  ],
};

describe('HubEvalTab settings routing', () => {
  it('renders real verdict lifecycle data and opens source artifacts in the workspace panel', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(populatedSummary));
    mockChatStoreState.currentThreadId = 'thread-current';
    mockChatStoreState.threads = [{ id: 'thread-current', projectPath: '/tmp/current-project' }];
    pushMock.mockClear();
    setCurrentThreadMock.mockClear();
    setCurrentProjectMock.mockClear();
    setWorkspaceOpenFileMock.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sourceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('结论文件'),
    );
    expect(sourceButton).toBeTruthy();
    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(setCurrentProjectMock).toHaveBeenCalledWith('/tmp/current-project');
    expect(setWorkspaceOpenFileMock).toHaveBeenCalledWith(
      'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
      null,
      'cat-cafe',
    );
    expect(setCurrentThreadMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith('/thread/thread-current');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('routes settings-origin artifact opens to the root chat shell when the active thread belongs to a foreign project', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(populatedSummary));
    mockChatStoreState.currentThreadId = 'thread-foreign';
    mockChatStoreState.threads = [{ id: 'thread-foreign', projectPath: '/tmp/foreign-project' }];
    pushMock.mockClear();
    setCurrentThreadMock.mockClear();
    setCurrentProjectMock.mockClear();
    setWorkspaceOpenFileMock.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sourceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('结论文件'),
    );
    expect(sourceButton).toBeTruthy();
    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(setCurrentProjectMock).toHaveBeenCalledWith('/tmp/current-project');
    expect(setWorkspaceOpenFileMock).toHaveBeenCalledWith(
      'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
      null,
      'cat-cafe',
    );
    expect(setCurrentThreadMock).toHaveBeenCalledWith('default');
    expect(pushMock).toHaveBeenCalledWith('/');
    expect(setCurrentThreadMock.mock.invocationCallOrder[0]).toBeLessThan(
      setWorkspaceOpenFileMock.mock.invocationCallOrder[0],
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
