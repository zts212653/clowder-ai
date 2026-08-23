import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import type { EvalHubItem, EvalHubSummary } from '../../HubEvalTypes';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

import { EvalWorkspacePanel } from '../EvalWorkspacePanel';

const baseItem: EvalHubItem = {
  id: 'verdict-a',
  domainId: 'eval:a2a',
  packetId: 'packet-a',
  feedbackType: 'live-verdict',
  verdict: 'fix',
  phenomenon: 'A2A handoff dropped after verdict',
  operatorNarrative: {
    headline: '发现 1 个需要修复的问题',
    summary: '这次检查的是「猫和猫协作顺不顺」。发现 1 个需要处理的线索。',
    action: '请负责 F167 的猫修复现有问题；修完后再复评。',
    nextCheck: '改动完成后，用同一组指标确认问题是否消失。',
    evidenceQuality: 'usable',
  },
  ownerAsk: 'Fix route exit handling.',
  harnessUnderEval: { featureId: 'F167', componentId: 'route-exit', name: 'Route exit guard' },
  reeval: {
    nextEvalAt: '2026-07-06T00:00:00.000Z',
    status: 'pending_owner',
    summary: 'next eval no longer reports dropped handoff',
  },
  lifecycle: {
    availability: 'available',
    ownerResponseStatus: 'not_started',
    closureStatus: 'open',
    reevalStatus: 'not_requested',
    stale: false,
  },
  evidence: { snapshotRefs: [], attributionRefs: [], metricRefs: [], otherRefs: [] },
  trend: { generatedAt: '2026-07-05T00:00:00.000Z', window: { durationHours: 24 }, components: [] },
  systemWorkspace: {
    kind: 'eval_domain',
    id: 'eval:a2a',
    label: 'A2A Harness Eval',
    threadId: 'thread-a2a',
    stateSot: 'registry',
  },
  source: { verdictPath: 'docs/harness-feedback/verdicts/a2a.md', bundleDir: 'docs/harness-feedback/bundles/a2a' },
};

function buildSummary(items: EvalHubItem[]): EvalHubSummary {
  return {
    generatedAt: '2026-07-05T01:00:00.000Z',
    repoProjectPath: '/repo/cat-cafe',
    repoWorktreeId: 'cat-cafe',
    counts: {
      total: items.length,
      actionable: items.filter((item) => item.verdict !== 'keep_observe').length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
      registeredDomains: 1,
    },
    domains: [
      {
        domainId: 'eval:a2a',
        displayName: 'A2A Harness Eval',
        descriptionForHuman: '猫和猫协作顺不顺',
        metricGlossary: {
          'c2.verdict_without_pass_count': {
            label: '有结论但没传球',
            means: '结论已经给出，却没有交给下一棒或合法持球的次数。',
            goodDirection: 'lower',
          },
        },
        systemThreadId: 'thread-a2a',
        frequency: 'daily',
        evalCatId: 'codex',
        evalCatHandle: '@codex',
        enabled: true,
        hasVerdict: items.length > 0,
        latestVerdictId: items[0]?.id,
        latestVerdict: items[0]?.verdict,
      },
    ],
    items,
  };
}

describe('EvalWorkspacePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
    useChatStore.setState({
      currentProjectPath: undefined,
      rightPanelMode: 'status',
      workspaceMode: 'dev',
      workspaceOpenFilePath: null,
      workspaceWorktreeId: null,
      workspaceOpenTabs: [],
      currentThreadId: 'thread-eval-origin',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders actionable eval events from the Eval Hub summary', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => buildSummary([baseItem]),
    });

    await act(async () => {
      root.render(<EvalWorkspacePanel />);
    });

    await act(async () => {});

    expect(container.querySelector('[data-testid="eval-workspace-panel"]')).not.toBeNull();
    expect(container.textContent).toContain('评估');
    expect(container.textContent).toContain('A2A Harness Eval');
    expect(container.textContent).toContain('发现 1 个需要修复的问题');
    expect(container.textContent).toContain('请负责 F167 的猫修复现有问题');
    expect(container.textContent).toContain('指标说明 (1)');
    expect(container.textContent).toContain('有结论但没传球');
    expect(container.textContent).toContain('结论已经给出，却没有交给下一棒');
    expect(container.textContent).toContain('越低越好');
    expect(container.textContent).toContain('查看台账');
    expect(container.querySelector('.font-mono')?.classList.contains('break-all')).toBe(true);
  });

  it('renders quiet checking evidence when only keep-observe events exist', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        buildSummary([
          {
            ...baseItem,
            verdict: 'keep_observe',
            operatorNarrative: {
              headline: '这轮没有发现要处理的问题',
              summary: 'A2A 最近没有可处理问题。',
              action: '现在不用处理；保持观察即可。',
              nextCheck: '按现有频率继续观察。',
              evidenceQuality: 'usable',
            },
            ownerAsk: 'No action required; keep observing.',
            reeval: { ...baseItem.reeval, status: 'observing' },
            lifecycle: {
              availability: 'not_required',
              ownerResponseStatus: 'not_required',
              closureStatus: 'observing',
              reevalStatus: 'not_required',
              stale: false,
            },
          },
        ]),
    });

    await act(async () => {
      root.render(<EvalWorkspacePanel />);
    });

    await act(async () => {});

    expect(container.textContent).toContain('暂无需要处理的评估事件');
    expect(container.textContent).toContain('最近保持观察');
    expect(container.textContent).toContain('A2A 最近没有可处理问题');
    expect(container.textContent).toContain('指标说明 (1)');
    expect(container.textContent).toContain('有结论但没传球');
    expect(container.textContent).toContain('越低越好');
  });

  it('routes external lifecycle references through the guarded popup path', async () => {
    const href = 'https://example.com/f273/workspace-evidence';
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        buildSummary([
          {
            ...baseItem,
            lifecycle: {
              ...baseItem.lifecycle,
              actionRefs: [{ kind: 'other', availability: 'available', value: href }],
            },
          },
        ]),
    });

    await act(async () => {
      root.render(<EvalWorkspacePanel />);
    });
    await act(async () => {});

    const link = container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
  });

  it('opens inv evidence as a typed Eval-origin trajectory chip', async () => {
    const item: EvalHubItem = {
      ...baseItem,
      lifecycle: {
        ...baseItem.lifecycle,
        actionRefs: [{ kind: 'other', availability: 'available', value: 'inv:inv-eval-17' }],
      },
    };
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildSummary([item]) });
    window.history.replaceState({}, '', '/thread/thread-eval-origin');

    await act(async () => root.render(<EvalWorkspacePanel />));
    await act(async () => {});
    const chip = container.querySelector<HTMLElement>('[data-testid="trajectory-evidence-chip"]');
    expect(chip?.dataset.invocationId).toBe('inv-eval-17');
    await act(async () => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const url = new URL(window.location.href);
    expect(url.searchParams.get('inv')).toBe('inv-eval-17');
    expect(url.searchParams.get('trajectoryThread')).toBeNull();
    expect(url.searchParams.get('origin')).toContain('eval:');
    expect(useChatStore.getState().workspaceMode).toBe('trajectory');
  });

  it('does not reinterpret native non-invocation evidence refs as trajectory anchors', async () => {
    const item: EvalHubItem = {
      ...baseItem,
      lifecycle: {
        ...baseItem.lifecycle,
        actionRefs: [
          {
            kind: 'other',
            availability: 'available',
            value: 'session:session-a/invocation:inv-legacy',
          },
          { kind: 'other', availability: 'available', value: 'trace:trace-native' },
        ],
      },
    };
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildSummary([item]) });

    await act(async () => root.render(<EvalWorkspacePanel />));
    await act(async () => {});

    expect(container.querySelector('[data-testid="trajectory-evidence-chip"]')).toBeNull();
    expect(container.textContent).toContain('session:session-a/invocation:inv-legacy');
    expect(container.textContent).toContain('trace:trace-native');
  });

  it('renders operator language instead of machine fields for an insufficient window', async () => {
    const insufficientItem = {
      ...baseItem,
      verdict: 'keep_observe' as const,
      ownerAsk: 'No new code change from eval:anchor-first this cycle.',
      lifecycle: {
        availability: 'not_required' as const,
        ownerResponseStatus: 'not_required' as const,
        closureStatus: 'observing' as const,
        reevalStatus: 'not_required' as const,
        stale: true,
      },
      operatorNarrative: {
        headline: '这轮数据还不够，先别下结论',
        summary: '采样了 24 小时，但没有有效事件，所以现在还判断不了好坏。',
        action: '现在不用改代码；先补足样本。',
        nextCheck: '已经超过原定复评时间，需要补跑一次评估。',
        evidenceQuality: 'insufficient' as const,
      },
    };
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildSummary([insufficientItem]) });

    await act(async () => {
      root.render(<EvalWorkspacePanel />);
    });
    await act(async () => {});

    expect(container.textContent).toContain('这轮数据还不够，先别下结论');
    expect(container.textContent).toContain('现在不用改代码');
    expect(container.textContent).toContain('已经超过原定复评时间');
    expect(container.textContent).toContain('不需要响应');
    expect(container.textContent).toContain('持续观察');
    expect(container.textContent).not.toContain('The selected window');
    expect(container.textContent).not.toContain('No new code change');
    expect(container.textContent).not.toContain('not_required');
    expect(container.textContent).not.toContain('observing');
  });

  it('switches back to dev mode when an evidence file is opened', async () => {
    useChatStore.setState({ workspaceMode: 'eval', rightPanelMode: 'workspace' });
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => buildSummary([baseItem]),
    });

    await act(async () => {
      root.render(<EvalWorkspacePanel />);
    });

    await act(async () => {});

    const verdictButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '结论文件',
    );
    expect(verdictButton).toBeDefined();

    await act(async () => {
      verdictButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useChatStore.getState().workspaceMode).toBe('dev');
    expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/harness-feedback/verdicts/a2a.md');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('cat-cafe');
  });

  it('surfaces lifecycle escalation and terminal closure in operator language', async () => {
    const escalated: EvalHubItem = {
      ...baseItem,
      lifecycle: {
        availability: 'available',
        ownerResponseStatus: 'not_started',
        closureStatus: 'escalated',
        stale: true,
        targetOwnerCatId: 'codex-sol',
        ownerResponseRefs: [],
        planRefs: [],
        actionRefs: [],
        reevalRefs: [],
        unavailableRefs: [],
        reevalStatus: 'not_requested',
        escalation: {
          eventId: 'sla-ack',
          stage: 'acknowledgement',
          dueAt: '2026-07-07T00:00:00.000Z',
        },
        diagnosisTarget: {
          featureId: 'F167',
          componentId: 'route-exit',
          name: 'Route exit guard',
          attributionRefs: ['attribution:a2a'],
          metricRefs: ['metric:c2.verdict_without_pass_count'],
        },
      },
    };
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildSummary([escalated]) });

    await act(async () => root.render(<EvalWorkspacePanel />));
    await act(async () => {});

    expect(container.textContent).toContain('已超时升级');
    expect(container.textContent).toContain('负责人接单已超时');
    expect(container.textContent).toContain('问题指向');
    expect(container.textContent).toContain('F167 / Route exit guard');
    expect(container.textContent).toContain('@codex-sol');
    expect(container.textContent).not.toContain('escalated');

    const resolved: EvalHubItem = {
      ...baseItem,
      lifecycle: {
        ...escalated.lifecycle,
        ownerResponseStatus: 'acknowledged',
        closureStatus: 'resolved',
        stale: false,
        reevalStatus: 'passed',
        actionRefs: [{ kind: 'commit', availability: 'available', value: 'deadbeef' }],
        closureReason: '同一组指标复评通过，问题已消失。',
        escalation: undefined,
      },
    };
    await act(async () => root.render(<div />));
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildSummary([resolved]) });
    await act(async () => root.render(<EvalWorkspacePanel />));
    await act(async () => {});

    expect(container.textContent).toContain('已验证闭环');
    expect(container.textContent).toContain('同一组指标复评通过，问题已消失');
    expect(container.textContent).toContain('deadbeef');
    expect(container.textContent).not.toContain('resolved');
  });
});
