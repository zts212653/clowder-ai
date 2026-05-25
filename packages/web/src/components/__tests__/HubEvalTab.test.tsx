import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const setWorkspaceOpenFileMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceOpenFile: typeof setWorkspaceOpenFileMock }) => unknown) =>
    selector({ setWorkspaceOpenFile: setWorkspaceOpenFileMock }),
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
  counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0 },
  items: [
    {
      id: '2026-05-23-eval-a2a-live-verdict',
      domainId: 'eval:a2a',
      packetId: 'vhp_eval_a2a_2026_05_23',
      feedbackType: 'live-verdict',
      verdict: 'keep_observe',
      phenomenon: 'No actionable A2A findings',
      ownerAsk: 'No action required; keep observing the next scheduled eval.',
      harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'hold_ball (MCP tool)' },
      reeval: { nextEvalAt: '2026-05-26T03:12:57.174Z', status: 'observing', summary: 'next eval remains clean' },
      lifecycle: { ownerResponseStatus: 'not_required', closureStatus: 'observing', stale: false },
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

describe('HubEvalTab', () => {
  it('renders real verdict lifecycle data and opens source artifacts in the workspace panel', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(populatedSummary));
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

    expect(container.textContent).toContain('2026-05-23-eval-a2a-live-verdict');
    expect(container.textContent).toContain('eval:a2a');
    expect(container.textContent).toContain('持续观察');
    expect(container.textContent).toContain('No actionable A2A findings');
    expect(container.textContent).toContain('No action required');
    expect(container.textContent).toContain('A2A Harness Eval 工作线程');
    expect(container.textContent).toContain('snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot');

    const sourceButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('结论文件'),
    );
    expect(sourceButton).toBeTruthy();
    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(setWorkspaceOpenFileMock).toHaveBeenCalledWith(
      'docs/harness-feedback/verdicts/2026-05-23-eval-a2a-live-verdict.md',
      null,
      null,
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders domain-specific jump links for eval:memory verdict cards', async () => {
    const memorySummary = {
      counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0 },
      items: [
        {
          id: '2026-05-24-eval-memory-test',
          domainId: 'eval:memory',
          packetId: 'vhp_eval_memory_test',
          feedbackType: 'live-verdict',
          verdict: 'keep_observe',
          phenomenon: 'No actionable memory findings',
          ownerAsk: 'No action required; keep observing.',
          harnessUnderEval: { featureId: 'F200', componentId: 'memory-recall', name: 'Memory Recall & Library Health' },
          reeval: { nextEvalAt: '2026-05-31T00:00:00.000Z', status: 'observing', summary: 'next eval remains clean' },
          lifecycle: { ownerResponseStatus: 'not_required', closureStatus: 'observing', stale: false },
          evidence: {
            snapshotRefs: ['snapshot:memory-eval/7d'],
            attributionRefs: ['attribution:no-finding'],
            metricRefs: ['mrr'],
            otherRefs: [],
          },
          trend: {
            generatedAt: '2026-05-24T14:00:00.000Z',
            window: { durationHours: 168 },
            components: [
              {
                componentId: 'memory-recall',
                componentName: 'Memory Recall & Library Health',
                confidence: 'medium',
                activationCounts: { recall_events: 142 },
                frictionCounts: { abandonment_rate: 0 },
              },
            ],
          },
          systemWorkspace: {
            kind: 'eval_domain',
            id: 'eval:memory',
            label: 'Memory Recall & Library Health Eval',
            threadId: 'thread_eval_memory',
            stateSot: 'registry',
          },
          source: {
            verdictPath: 'docs/harness-feedback/verdicts/2026-05-24-eval-memory-test.md',
            bundleDir: 'docs/harness-feedback/bundles/2026-05-24-eval-memory-test',
          },
        },
      ],
    };

    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(memorySummary));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Memory domain card should show domain-specific jump links
    const links = Array.from(container.querySelectorAll('a'));
    const healthLink = links.find((a) => a.textContent?.includes('记忆健康'));
    expect(healthLink).toBeTruthy();
    expect(healthLink?.getAttribute('href')).toBe('/memory/health');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders an honest empty state without claiming completion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse({ counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0 }, items: [] }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('还没有 live verdict');
    expect(container.textContent).not.toContain('已完成');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
