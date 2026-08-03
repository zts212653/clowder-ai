import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

const setWorkspaceOpenFileMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: {
      currentThreadId: string;
      setCurrentThread: () => void;
      threads: Array<{ id: string; projectPath?: string }>;
      setCurrentProject: () => void;
      setWorkspaceOpenFile: typeof setWorkspaceOpenFileMock;
    }) => unknown,
  ) =>
    selector({
      currentThreadId: 'thread-current',
      setCurrentThread: vi.fn(),
      threads: [{ id: 'thread-current', projectPath: '/tmp/current-project' }],
      setCurrentProject: vi.fn(),
      setWorkspaceOpenFile: setWorkspaceOpenFileMock,
    }),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { HubEvalTab } from '../HubEvalTab';
import type { EvalHubItem, EvalMetricGlossary } from '../HubEvalTypes';
import { HubEvalVerdictCard } from '../HubEvalVerdictCard';

Object.assign(globalThis as Record<string, unknown>, { React });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function observingLifecycle() {
  return {
    availability: 'not_required',
    ownerResponseStatus: 'not_required',
    closureStatus: 'observing',
    reevalStatus: 'not_required',
    stale: false,
  } as const;
}

const a2aMetricGlossary: EvalMetricGlossary = {
  'c1.zombie_hold_count': {
    label: '旧版卡住持球计数',
    means: '历史 verdict 使用的旧指标，对应真正卡住的持球。',
    goodDirection: 'lower',
    category: 'friction',
    component: 'C1',
  },
  'c2.verdict_without_pass_count': {
    label: '有结论但没传球',
    means: '已经产出 verdict，但没有把下一步球权交出去。',
    goodDirection: 'lower',
    category: 'friction',
    component: 'C2',
  },
  'hold_lifecycle.expired_after_satisfied_total': {
    label: '已满足后仍过期',
    means: '外部条件已满足，但持球仍走到过期路径的次数。',
    goodDirection: 'lower',
    category: 'friction',
    component: 'hold_lifecycle',
  },
};

const a2aVerdictItem: EvalHubItem = {
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
  lifecycle: observingLifecycle(),
  evidence: {
    snapshotRefs: ['snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot'],
    attributionRefs: ['attribution:bundle/2026-05-23-eval-a2a-live-verdict/eval-F167-2026-05-23:no-finding'],
    metricRefs: [
      'metric:c1.zombie_hold_count',
      'metric:cat_cafe_a2a_c2_verdict_without_pass_count_total=6',
      'metric:cat_cafe.a2a.hold_expired_after_satisfied_total',
    ],
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
};

const populatedSummary = {
  counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0, registeredDomains: 2 },
  domains: [
    {
      domainId: 'eval:a2a',
      displayName: 'A2A Harness Eval',
      descriptionForHuman: '猫和猫协作顺不顺——传球掉地上没、@ 被忽略没、跨 thread 断没',
      systemThreadId: 'thread_eval_a2a',
      frequency: 'daily',
      evalCatHandle: '@codex',
      hasVerdict: true,
      latestVerdictId: '2026-05-23-eval-a2a-live-verdict',
      latestVerdict: 'keep_observe',
      metricGlossary: a2aMetricGlossary,
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
  items: [a2aVerdictItem],
};

describe('HubEvalTab', () => {
  it('renders domain-specific jump links for eval:memory verdict cards', async () => {
    const memorySummary = {
      counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0 },
      domains: [],
      items: [
        {
          id: '2026-05-24-eval-memory-test',
          domainId: 'eval:memory',
          packetId: 'vhp_eval_memory_test',
          feedbackType: 'live-verdict',
          verdict: 'keep_observe',
          phenomenon: 'No actionable memory findings',
          operatorNarrative: {
            headline: '这轮没有发现要处理的问题',
            summary: '这次检查的是「记忆系统好不好使」。本轮数据可用，没有发现达到处理门槛的问题。',
            action: '现在不用处理；保持观察即可。',
            nextCheck: '按现有频率继续观察。',
            evidenceQuality: 'usable',
          },
          ownerAsk: 'No action required; keep observing.',
          harnessUnderEval: { featureId: 'F200', componentId: 'memory-recall', name: 'Memory Recall & Library Health' },
          reeval: { nextEvalAt: '2026-05-31T00:00:00.000Z', status: 'observing', summary: 'next eval remains clean' },
          lifecycle: observingLifecycle(),
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

  // F192 livefix OQ-16: domain overview shows all domains including those without verdicts
  it('renders domain overview showing eval:memory with "待首次评估" placeholder', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(populatedSummary));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Domain overview section should exist
    expect(container.textContent).toContain('评估域总览');
    // eval:memory should show with placeholder status
    expect(container.textContent).toContain('Memory Recall & Library Health Eval');
    expect(container.textContent).toContain('待首次评估');
    // eval:a2a should show with its verdict label
    expect(container.textContent).toContain('A2A Harness Eval');
    // Both domains show their eval cats
    expect(container.textContent).toContain('@codex');
    expect(container.textContent).toContain('@opus47');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders registry-driven metric explanations and verdict summaries', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(populatedSummary));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalTab />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('这轮没有发现要处理的问题');
    expect(container.textContent).toContain('现在不用处理');
    expect(container.textContent).toContain('指标说明');
    expect(container.textContent).toContain('旧版卡住持球计数');
    expect(container.textContent).toContain('历史 verdict 使用的旧指标');
    expect(container.textContent).toContain('有结论但没传球');
    expect(container.textContent).toContain('已经产出 verdict，但没有把下一步球权交出去。');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('resolves Prometheus-style metric refs in verdict evidence against registry glossary keys', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<HubEvalVerdictCard item={a2aVerdictItem} metricGlossary={a2aMetricGlossary} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('有结论但没传球');
    expect(container.textContent).toContain('已经产出 verdict，但没有把下一步球权交出去。');
    // Cloud P2: dotted OTel ref must also resolve via prefix mapping
    expect(container.textContent).toContain('已满足后仍过期');
    expect(container.textContent).toContain('外部条件已满足，但持球仍走到过期路径的次数。');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders an honest empty state without claiming completion', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      jsonResponse({ counts: { total: 0, actionable: 0, keepObserve: 0, stale: 0 }, domains: [], items: [] }),
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
