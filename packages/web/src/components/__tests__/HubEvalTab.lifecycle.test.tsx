import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentThreadId: 'thread-current',
      threads: [],
      setCurrentThread: vi.fn(),
      setCurrentProject: vi.fn(),
      setWorkspaceOpenFile: vi.fn(),
    }),
}));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { HubEvalTab } from '../HubEvalTab';

function summaryWithUnavailableLifecycle() {
  return {
    counts: { total: 1, actionable: 1, keepObserve: 0, stale: 0 },
    domains: [],
    items: [
      {
        id: 'actionable-without-redis',
        domainId: 'eval:capability-tips',
        packetId: 'packet-1',
        feedbackType: 'live-verdict',
        verdict: 'fix',
        phenomenon: 'Capability tip did not wake up.',
        operatorNarrative: {
          headline: '发现需要修复的问题',
          summary: '能力提示没有在需要时出现。',
          action: '请负责人修复后复评。',
          nextCheck: '修复后用同一场景复评。',
          evidenceQuality: 'usable',
        },
        ownerAsk: 'Fix the capability tip.',
        harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'Capability Tips' },
        reeval: { status: 'pending_owner', summary: 're-evaluate after repair' },
        lifecycle: {
          availability: 'unavailable',
          ownerResponseStatus: 'unavailable',
          closureStatus: 'unavailable',
          reevalStatus: 'unavailable',
          stale: false,
          unavailableReason: 'canonical lifecycle event log unavailable',
        },
        evidence: { snapshotRefs: [], attributionRefs: [], metricRefs: [], otherRefs: [] },
        trend: { generatedAt: '2026-07-18T00:00:00.000Z', window: { durationHours: 24 }, components: [] },
        systemWorkspace: {
          kind: 'eval_domain',
          id: 'eval:capability-tips',
          label: 'Capability Tips Eval',
          threadId: 'thread_eval_capability_tips',
          stateSot: 'registry',
        },
        source: { verdictPath: 'docs/verdict.md', bundleDir: 'docs/bundle' },
      },
    ],
  };
}

describe('HubEvalTab lifecycle states', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  afterEach(() => vi.clearAllMocks());

  it('shows an honest partial state when canonical lifecycle storage is unavailable', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify(summaryWithUnavailableLifecycle()), { status: 200 }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<HubEvalTab />));
    await act(async () => {});

    expect(container.textContent).toContain('处置记录暂不可用');
    expect(container.textContent).toContain('结论和证据仍可查看');
    expect(container.textContent).not.toContain('not_started');

    await act(async () => root.unmount());
    container.remove();
  });

  it('shows repair debt separately from cadence and re-evaluation debt', async () => {
    const summary = summaryWithUnavailableLifecycle();
    Object.assign(summary.items[0].lifecycle, {
      availability: 'available',
      ownerResponseStatus: 'not_required',
      closureStatus: 'monitoring',
      reevalStatus: 'not_requested',
      repairDebtStatus: 'not_required',
      reevalDebtStatus: 'due',
      stale: true,
      targetOwnerCatId: 'opus',
      caseId: `eval-case-v1-${'a'.repeat(64)}`,
      activeVerdictId: 'actionable-without-redis',
      observedVerdictIds: ['actionable-without-redis'],
    });
    apiFetch.mockResolvedValue(new Response(JSON.stringify(summary), { status: 200 }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<HubEvalTab />));
    await act(async () => {});

    expect(container.textContent).toContain('修复债务');
    expect(container.textContent).toContain('无需修复');
    expect(container.textContent).toContain('节奏 / 复评债务');
    expect(container.textContent).toContain('复评已到期');

    await act(async () => root.unmount());
    container.remove();
  });
});
