import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EvalHubItem } from '../HubEvalTypes';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentThreadId: 'thread-current',
      threads: [{ id: 'thread-current', projectPath: '/repo/cat-cafe' }],
      setCurrentThread: vi.fn(),
      setCurrentProject: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    }),
}));

import { HubEvalVerdictCard } from '../HubEvalVerdictCard';

const item: EvalHubItem = {
  id: 'anchor-empty-window',
  domainId: 'eval:anchor-first',
  packetId: 'packet-anchor',
  feedbackType: 'live-verdict',
  verdict: 'keep_observe',
  phenomenon: 'The selected window produced no anchor preview events.',
  operatorNarrative: {
    headline: '这轮数据还不够，先别下结论',
    summary: '采样了 24 小时，但没有有效事件，所以现在还判断不了好坏。',
    action: '现在不用改代码；先补足样本。',
    nextCheck: '等下一轮积累到足够样本，再判断是否需要改动。',
    evidenceQuality: 'insufficient',
  },
  ownerAsk: 'No new code change from eval:anchor-first this cycle.',
  harnessUnderEval: { featureId: 'F236', componentId: 'anchor-rollup', name: 'anchor rollup' },
  reeval: {
    nextEvalAt: '2026-06-28T03:11:26.201Z',
    status: 'observing',
    summary: 're-evaluate after a full window',
  },
  lifecycle: {
    availability: 'not_required',
    ownerResponseStatus: 'not_required',
    closureStatus: 'observing',
    reevalStatus: 'not_required',
    stale: false,
  },
  evidence: { snapshotRefs: [], attributionRefs: [], metricRefs: [], otherRefs: [] },
  trend: {
    generatedAt: '2026-06-28T03:11:26.201Z',
    window: { durationHours: 24 },
    components: [],
  },
  systemWorkspace: {
    kind: 'eval_domain',
    id: 'eval:anchor-first',
    label: 'Anchor-First Context Entry Eval',
    threadId: 'thread-anchor',
    stateSot: 'registry',
  },
  source: { verdictPath: 'verdict.md', bundleDir: 'bundle' },
};

describe('HubEvalVerdictCard operator narrative', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps machine wording in a closed drill-down instead of the verdict headline', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<HubEvalVerdictCard item={item} />));

    expect(container.querySelector('h3')?.textContent).toBe('这轮数据还不够，先别下结论');
    const machineDetails = container.querySelector('details');
    expect(machineDetails).not.toBeNull();
    expect(machineDetails?.open).toBe(false);
    expect(machineDetails?.textContent).toContain('机器原文与证据');
    expect(machineDetails?.textContent).toContain('The selected window produced no anchor preview events');
    expect(machineDetails?.textContent).toContain('No new code change from eval:anchor-first');
    expect(machineDetails?.textContent).toContain('2026年');

    await act(async () => root.unmount());
    container.remove();
  });

  it('shows a verified fix and re-evaluation chain with human labels and evidence links', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const resolved: EvalHubItem = {
      ...item,
      verdict: 'fix',
      lifecycle: {
        availability: 'available',
        ownerResponseStatus: 'acknowledged',
        closureStatus: 'resolved',
        stale: false,
        targetOwnerCatId: 'codex-sol',
        lifecycleOwnerCatId: 'codex-sol',
        ownerResponseRefs: [{ kind: 'message', availability: 'available', value: 'thread:owner-response' }],
        planRefs: [{ kind: 'plan', availability: 'available', value: 'docs/plans/F268.md' }],
        actionRefs: [
          {
            kind: 'commit',
            availability: 'available',
            value: 'https://github.com/example/cat-cafe/commit/deadbeef',
          },
        ],
        reevalRefs: [{ kind: 'reeval', availability: 'available', value: 'eval:capability-tips:pass' }],
        unavailableRefs: [],
        reevalStatus: 'passed',
        closureReason: '修复后的能力唤醒行为已通过复评。',
        diagnosisTarget: {
          featureId: 'F268',
          componentId: 'tips',
          name: 'Capability Tips',
          attributionRefs: ['attribution:bundle/verdict/finding-1'],
          metricRefs: ['metric:tips.missed'],
        },
      },
    };

    await act(async () => root.render(<HubEvalVerdictCard item={resolved} />));

    expect(container.textContent).toContain('处置进度');
    expect(container.textContent).toContain('已验证闭环');
    expect(container.textContent).toContain('问题指向');
    expect(container.textContent).toContain('F268 / Capability Tips');
    expect(container.textContent).toContain('@codex-sol');
    expect(container.textContent).toContain('复评通过');
    expect(container.textContent).toContain('修复后的能力唤醒行为已通过复评');
    expect(container.querySelector('a[href="https://github.com/example/cat-cafe/commit/deadbeef"]')).not.toBeNull();
    expect(container.textContent).not.toContain('resolved');

    await act(async () => root.unmount());
    container.remove();
  });

  it('uses the active canonical cycle due date in the operator next-check field', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const activeDue = '2026-07-25T00:00:00.000Z';
    const legacyDue = item.reeval.nextEvalAt as string;

    await act(async () =>
      root.render(
        <HubEvalVerdictCard
          item={{
            ...item,
            verdict: 'fix',
            lifecycle: {
              availability: 'available',
              ownerResponseStatus: 'acknowledged',
              closureStatus: 'reeval_pending',
              reevalStatus: 'pending',
              reevalDueAt: activeDue,
              stale: false,
            },
          }}
        />,
      ),
    );

    const nextCheckLabel = [...container.querySelectorAll('div')].find((node) => node.textContent === '下次看什么');
    const nextCheckText = nextCheckLabel?.parentElement?.textContent;
    const formatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
    expect(nextCheckText).toContain(formatter.format(new Date(activeDue)));
    expect(nextCheckText).not.toContain(formatter.format(new Date(legacyDue)));

    await act(async () => root.unmount());
    container.remove();
  });

  it('distinguishes reasoned suppression, SLA escalation, and unavailable historical evidence', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const suppressed: EvalHubItem = {
      ...item,
      verdict: 'fix',
      lifecycle: {
        availability: 'available',
        ownerResponseStatus: 'not_started',
        closureStatus: 'suppressed_with_reason',
        stale: false,
        targetOwnerCatId: 'opus-47',
        ownerResponseRefs: [],
        planRefs: [],
        actionRefs: [],
        reevalRefs: [],
        unavailableRefs: [{ kind: 'reeval', availability: 'unavailable', unavailableReason: '历史复评结果未留存' }],
        reevalStatus: 'not_requested',
        closureReason: 'operator 确认该信号属于已知取舍，本轮不处理。',
        diagnosisTarget: {
          featureId: 'F203',
          componentId: 'workspace-navigator',
          name: 'Workspace Navigator',
          attributionRefs: [],
          metricRefs: [],
        },
      },
    };

    await act(async () => root.render(<HubEvalVerdictCard item={suppressed} />));
    expect(container.textContent).toContain('已说明不处理');
    expect(container.textContent).toContain('operator 确认该信号属于已知取舍');
    expect(container.textContent).toContain('历史证据缺失 1 段');
    expect(container.textContent).not.toContain('suppressed_with_reason');

    await act(async () =>
      root.render(
        <HubEvalVerdictCard
          item={{
            ...suppressed,
            lifecycle: {
              ...suppressed.lifecycle,
              closureStatus: 'escalated',
              stale: true,
              escalation: {
                eventId: 'sla-1',
                stage: 'acknowledgement',
                dueAt: '2026-07-20T00:00:00.000Z',
              },
              closureReason: undefined,
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('已超时升级');
    expect(container.textContent).toContain('负责人接单已超时');
    expect(container.textContent).not.toContain('escalated');

    await act(async () => root.unmount());
    container.remove();
  });
});
