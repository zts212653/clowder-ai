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

const frictionSummary = {
  counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0, registeredDomains: 1 },
  domains: [
    {
      domainId: 'eval:friction',
      displayName: 'Friction Signal Eval',
      systemThreadId: 'thread_eval_friction',
      frequency: 'every-3d',
      evalCatId: 'gpt52',
      evalCatHandle: '@gpt52',
      enabled: true,
      hasVerdict: true,
      latestVerdictId: '2026-06-22-eval-friction-test',
      latestVerdict: 'keep_observe',
      nextCronFireAt: '2026-06-23T03:00:00.000Z',
    },
  ],
  items: [
    {
      id: '2026-06-22-eval-friction-test',
      domainId: 'eval:friction',
      packetId: 'vhp_eval_friction_test',
      feedbackType: 'live-verdict',
      verdict: 'keep_observe',
      phenomenon: 'Friction rollup surfaced repeated workspace confusion',
      ownerAsk: 'keep observing the next eval after reviewing the draft suggestions',
      harnessUnderEval: { featureId: 'F245', componentId: 'friction-rollup', name: 'friction rollup' },
      reeval: {
        nextEvalAt: '2026-06-29T00:00:00.000Z',
        status: 'observing',
        summary: 'next eval at 2026-06-29T00:00:00.000Z',
      },
      lifecycle: { ownerResponseStatus: 'not_required', closureStatus: 'observing', stale: false },
      evidence: {
        snapshotRefs: ['snapshot:bundle/2026-06-22-eval-friction-test/snapshot'],
        attributionRefs: ['attribution:bundle/2026-06-22-eval-friction-test/eval-F245-2026-06-22:no-finding'],
        metricRefs: ['metric:friction.cluster_count'],
        otherRefs: [],
      },
      trend: {
        generatedAt: '2026-06-22T12:00:00.000Z',
        window: { durationHours: 72 },
        components: [
          {
            componentId: 'friction-rollup',
            componentName: 'friction rollup (Top-N + sensorForm)',
            confidence: 'medium',
            activationCounts: {},
            frictionCounts: { cluster_count: 2, top_cluster_count: 2 },
          },
        ],
      },
      systemWorkspace: {
        kind: 'eval_domain',
        id: 'eval:friction',
        label: 'Friction Signal Eval',
        threadId: 'thread_eval_friction',
        stateSot: 'registry',
      },
      source: {
        verdictPath: 'docs/harness-feedback/verdicts/2026-06-22-eval-friction-test.md',
        bundleDir: 'docs/harness-feedback/bundles/2026-06-22-eval-friction-test',
      },
      friction: {
        projectionStatus: 'available',
        actionableCandidates: [
          {
            clusterId: 'feedback-c',
            representative: 'workspace navigator path keeps being hidden',
            channels: ['user-feedback', 'paw-feel'],
            count: 3,
            members: [],
            method: 'rule',
            sensorForms: ['reason'],
            severity: 'high',
            actionability: 'actionable_candidate',
            followupDraft: {
              clusterId: 'feedback-c',
              title: 'Investigate friction cluster: workspace navigator path keeps being hidden',
              summary: 'workspace navigator path keeps being hidden',
              evidenceRefs: ['issue-1', 'msg-1#0'],
              reportingMode: 'final-only',
            },
            referenceOnlyEvidenceRefs: ['eval-verdict-7#component'],
          },
        ],
        referenceOnly: [
          {
            clusterId: 'eval-only',
            representative: 'eval-domain already tracks the same slow drift',
            channels: ['eval-domain'],
            count: 2,
            members: [],
            method: 'rule',
            sensorForms: ['aggregate_proxy'],
            severity: 'low',
            actionability: 'reference_only',
            evidenceRefs: ['eval-verdict-7#component'],
          },
        ],
        source: {
          rawReportPath: 'docs/harness-feedback/bundles/2026-06-22-eval-friction-test/raw/rollup-report.json',
        },
      },
    },
  ],
};

describe('HubEvalTab friction view', () => {
  it('renders actionable draft suggestions and reference-only friction clusters from the shared Phase D contract', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(frictionSummary));
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

    expect(container.textContent).toContain('建议修复');
    expect(container.textContent).toContain('workspace navigator path keeps being hidden');
    expect(container.textContent).toContain('仅是 proposal draft，不会自动开 thread');
    expect(container.textContent).toContain('仅引用');
    expect(container.textContent).toContain('eval-domain already tracks the same slow drift');
    expect(container.textContent).toContain('原始报告');

    const rawReportButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('原始报告'),
    );
    expect(rawReportButton).toBeTruthy();
    await act(async () => {
      rawReportButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(setWorkspaceOpenFileMock).toHaveBeenCalledWith(
      'docs/harness-feedback/bundles/2026-06-22-eval-friction-test/raw/rollup-report.json',
      null,
      null,
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('shows an honest empty state when friction is registered but no live verdict bundle exists yet', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse({
        counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0, registeredDomains: 1 },
        domains: [
          {
            domainId: 'eval:friction',
            displayName: 'Friction Signal Eval',
            systemThreadId: 'thread_eval_friction',
            frequency: 'every-3d',
            evalCatId: 'gpt52',
            evalCatHandle: '@gpt52',
            enabled: true,
            hasVerdict: false,
            nextCronFireAt: '2026-06-23T03:00:00.000Z',
          },
        ],
        items: [],
      }),
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

    expect(container.textContent).toContain('Friction Signal Eval');
    expect(container.textContent).toContain('待首次评估');
    expect(container.textContent).toContain('还没有 live verdict');
    expect(container.textContent).not.toContain('建议修复');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
