/**
 * F229 AC-B2: CardBlock investigate intent → extract investigationJobId → render InvestigationProgress
 *
 * TDD RED: Tests written before implementation.
 * After triage confirm with intent='investigate', backend returns { investigationJobId }.
 * CardBlock must poll job status and render report when done.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBlock } from '@/components/rich/CardBlock';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

// --- mocks ---
const mockOnNavigationAction = vi.fn();
vi.mock('@/stores/conciergeStore', () => ({
  useConciergeStore: { getState: () => ({ onNavigationAction: mockOnNavigationAction }) },
}));

const chatState = { currentThreadId: 'thread_A' as string | null, updateRichBlock: vi.fn() };
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => chatState },
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

// P1-2: mock scrollToMessage + teleport utils (CSS.escape unavailable in jsdom)
const mockScrollToMessage = vi.fn();
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: (...args: unknown[]) => mockScrollToMessage(...args) }));

const mockKickTeleportResolve = vi.fn();
vi.mock('@/utils/teleport', () => ({
  planTeleport: ({
    threadId,
    messageId,
    currentThreadId,
  }: {
    threadId: string;
    messageId?: string;
    currentThreadId: string | null;
  }) => {
    // Same-thread with messageId → scroll; cross-thread → navigate
    if (threadId === currentThreadId && messageId) {
      return { scrollNow: messageId, navigateTo: null };
    }
    return { scrollNow: null, navigateTo: threadId };
  },
  kickTeleportResolve: () => mockKickTeleportResolve(),
}));

// --- helpers ---
function makeTriageConfirmBlock(planId: string): RichCardBlock {
  return {
    id: 'card-inv-1',
    kind: 'card',
    v: 1,
    title: '帮你查一下',
    bodyMarkdown: '我来查查相关信息',
    actions: [
      {
        action: 'concierge_triage_confirm',
        label: '确认',
        payload: { planId, intent: 'investigate', summary: '查一下 F229 进展' },
      },
      {
        action: 'concierge_triage_cancel',
        label: '取消',
        payload: { planId },
      },
    ],
  };
}

describe('CardBlock investigate intent (AC-B2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    mockScrollToMessage.mockClear();
    mockKickTeleportResolve.mockClear();
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  /** Mock apiFetch for confirm + poll pattern. Returns the inner mock for composition. */
  function mockConfirmAndPoll(
    planId: string,
    jobId: string,
    jobStatus: string,
    report?: Record<string, unknown>,
  ): (url: string) => Promise<Response> {
    const handler = async (url: string): Promise<Response> => {
      if (typeof url === 'string' && url.includes('/confirm')) {
        return {
          ok: true,
          json: async () => ({ planId, status: 'dispatched', investigationJobId: jobId }),
        } as Response;
      }
      if (typeof url === 'string' && url.includes(`/investigation/${jobId}`)) {
        return {
          ok: true,
          json: async () => ({
            job: {
              id: jobId,
              status: jobStatus,
              query: 'test',
              ...(report ? { report } : {}),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              ...(jobStatus === 'done' ? { completedAt: Date.now() } : {}),
              deadline: Date.now() + 60_000,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    };
    vi.mocked(apiFetch).mockImplementation(handler);
    return handler;
  }

  async function renderCard(block: RichCardBlock): Promise<void> {
    await act(async () => {
      root.render(createElement(CardBlock, { block, messageId: 'msg-inv-1' }));
    });
  }

  async function clickButton(label: string): Promise<void> {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    expect(btn, `button containing "${label}" should render`).toBeTruthy();
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('after investigate confirm, shows investigation progress with spinner', async () => {
    const block = makeTriageConfirmBlock('plan-inv-1');
    mockConfirmAndPoll('plan-inv-1', 'inv_abc123', 'running');

    vi.useFakeTimers();

    await renderCard(block);
    await clickButton('确认');

    // Advance timer to trigger first poll
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Should show investigation progress indicator
    const progressEl = container.querySelector('[data-testid="investigation-progress"]');
    expect(progressEl, 'investigation progress section should render after confirm').toBeTruthy();

    // Should NOT navigate away (investigate stays in panel, unlike go/propose_thread)
    expect(mockOnNavigationAction).not.toHaveBeenCalled();
  });

  it('renders investigation report with anchors when job is done', async () => {
    const block = makeTriageConfirmBlock('plan-inv-2');

    const doneReport = {
      summary: '找到了 3 条相关信息，主要集中在 F229 讨论和代码变更。',
      anchors: [
        {
          handle: 'R1',
          kind: 'thread' as const,
          threadId: 'thread_xyz',
          title: 'F229 Phase B 讨论',
          relevance: '直接相关：讨论了总机能力设计',
        },
        {
          handle: 'R2',
          kind: 'doc' as const,
          path: 'docs/features/F229-cat-ball-concierge.md',
          title: 'F229 Feature Doc',
          relevance: '功能规格文档',
        },
        {
          handle: 'R3',
          kind: 'github' as const,
          path: 'https://github.com/example/repo/pull/2307',
          title: 'PR #2307: Investigation backend',
          relevance: '后端实现 PR',
        },
      ],
    };

    mockConfirmAndPoll('plan-inv-2', 'inv_done456', 'done', doneReport);

    vi.useFakeTimers();

    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Report card should render
    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl, 'investigation report should render when job is done').toBeTruthy();

    // Summary text should be visible
    expect(container.textContent).toContain('找到了 3 条相关信息');

    // Anchors should render with their handles
    expect(container.textContent).toContain('R1');
    expect(container.textContent).toContain('F229 Phase B 讨论');
    expect(container.textContent).toContain('R2');
    expect(container.textContent).toContain('F229 Feature Doc');
    expect(container.textContent).toContain('R3');
    expect(container.textContent).toContain('PR #2307');
  });

  it('shows error state when investigation job fails', async () => {
    const block = makeTriageConfirmBlock('plan-inv-3');
    mockConfirmAndPoll('plan-inv-3', 'inv_fail789', 'failed');

    vi.useFakeTimers();

    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Should show error/failed state
    const errorEl = container.querySelector('[data-testid="investigation-failed"]');
    expect(errorEl, 'investigation failed state should render').toBeTruthy();
  });

  it('thread anchor is clickable and navigates via pathname', async () => {
    const block = makeTriageConfirmBlock('plan-inv-4');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    mockConfirmAndPoll('plan-inv-4', 'inv_nav', 'done', {
      summary: '找到了相关讨论',
      anchors: [
        { handle: 'R1', kind: 'thread', threadId: 'thread_target_abc', title: '目标讨论', relevance: '直接相关' },
      ],
    });

    vi.useFakeTimers();

    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Find and click the thread anchor link
    const anchorLink = [...container.querySelectorAll('[data-testid="anchor-link-thread"]')].find((el) =>
      el.textContent?.includes('目标讨论'),
    );
    expect(anchorLink, 'thread anchor should be a clickable link').toBeTruthy();

    await act(async () => {
      (anchorLink as HTMLElement)?.click();
    });

    // Should navigate via pathname (Bug1 fix pattern)
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread_target_abc');
    // Should collapse concierge surface
    expect(mockOnNavigationAction).toHaveBeenCalled();

    pushStateSpy.mockRestore();
  });

  it('cancel button cancels running investigation', async () => {
    const block = makeTriageConfirmBlock('plan-inv-5');

    const confirmMock = mockConfirmAndPoll('plan-inv-5', 'inv_cancel', 'running');
    // Also handle cancel endpoint
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/cancel') && init?.method === 'POST') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      return confirmMock(url);
    });

    vi.useFakeTimers();

    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Cancel button should be visible during running state
    const cancelBtn = container.querySelector('[data-testid="investigation-cancel"]') as HTMLButtonElement | null;
    expect(cancelBtn, 'cancel button should render during running state').toBeTruthy();

    // Click cancel
    await act(async () => {
      cancelBtn?.click();
    });

    // Verify cancel API was called
    const cancelCall = vi
      .mocked(apiFetch)
      .mock.calls.find(
        ([url, init]) => typeof url === 'string' && url.includes('/cancel') && (init as RequestInit)?.method === 'POST',
      );
    expect(cancelCall, 'cancel API should be called').toBeTruthy();
  });

  // --- P1-3 RED: cancel on 409 should re-poll, not hide report ---
  it('cancel on 409 re-polls to reveal completed report instead of showing cancelled', async () => {
    const block = makeTriageConfirmBlock('plan-inv-p13');
    let pollCount = 0;

    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/confirm')) {
        return {
          ok: true,
          json: async () => ({ planId: 'plan-inv-p13', status: 'dispatched', investigationJobId: 'inv_race' }),
        } as Response;
      }
      // Cancel endpoint returns 409 (job already completed)
      if (typeof url === 'string' && url.includes('/cancel') && init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: 'Job already terminal' }) } as Response;
      }
      // Poll: first two polls = running, after cancel re-poll = done
      if (typeof url === 'string' && url.includes('/investigation/inv_race')) {
        pollCount++;
        if (pollCount <= 2) {
          return {
            ok: true,
            json: async () => ({
              job: { id: 'inv_race', status: 'running', query: 'test', createdAt: 1, updatedAt: 1, deadline: 99999 },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'inv_race',
              status: 'done',
              query: 'test',
              report: { summary: '调查完成', anchors: [] },
              createdAt: 1,
              updatedAt: 1,
              completedAt: 2,
              deadline: 99999,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    // First poll → running
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const cancelBtn = container.querySelector('[data-testid="investigation-cancel"]') as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();

    // Click cancel → 409
    await act(async () => {
      cancelBtn?.click();
    });

    // After 409 cancel, should NOT show cancelled state — should re-poll and show report
    // Give time for the re-poll to resolve
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    const cancelledEl = container.querySelector('[data-testid="investigation-cancelled"]');
    expect(cancelledEl, 'should NOT show cancelled when cancel returns 409').toBeFalsy();

    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl, 'should show completed report after 409 re-poll').toBeTruthy();
  });

  // --- P1-2 RED: thread anchor with messageId should do message-level navigation ---
  it('thread anchor with messageId uses planTeleport for message-level navigation', async () => {
    const block = makeTriageConfirmBlock('plan-inv-p12');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    mockConfirmAndPoll('plan-inv-p12', 'inv_msg_nav', 'done', {
      summary: '找到了相关消息',
      anchors: [
        {
          handle: 'R1',
          kind: 'thread',
          threadId: 'thread_same',
          messageId: 'msg_target_123',
          title: '目标消息',
          relevance: '直接相关',
        },
      ],
    });

    // Set current thread to match anchor threadId (same-thread case → scroll, not navigate)
    chatState.currentThreadId = 'thread_same';

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const anchorLink = container.querySelector('[data-testid="anchor-link-thread"]') as HTMLElement | null;
    expect(anchorLink).toBeTruthy();

    await act(async () => {
      anchorLink?.click();
    });

    // Same-thread + messageId → should scroll (planTeleport returns scrollNow),
    // NOT pushState navigate. pushState should NOT be called for same-thread scroll.
    expect(pushStateSpy).not.toHaveBeenCalled();

    // Should have called scrollToMessage with the messageId
    expect(mockScrollToMessage).toHaveBeenCalledWith('msg_target_123');

    // Collapse concierge surface should still happen
    expect(mockOnNavigationAction).toHaveBeenCalled();

    pushStateSpy.mockRestore();
    chatState.currentThreadId = 'thread_A'; // restore
  });

  // --- P1-1 RED: investigation report should restore from confirmation on mount ---
  it('restores investigation report from confirmation on remount', async () => {
    // Simulate: card with restored confirmation for intent=investigate
    const block = makeTriageConfirmBlock('plan-inv-p11');

    // Mock: the investigation job is already done (persisted in backend)
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/investigation/inv_restored')) {
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'inv_restored',
              status: 'done',
              query: 'test',
              report: { summary: '之前调查的结果', anchors: [] },
              createdAt: 1,
              updatedAt: 1,
              completedAt: 2,
              deadline: 99999,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    vi.useFakeTimers();

    // Render with restored confirmation that includes investigationJobId
    const restoredConfirmations: Array<{
      id: string;
      messageId: string;
      status: 'confirmed';
      action: { kind: string; planId: string; intent: string; investigationJobId: string };
    }> = [
      {
        id: 'triage:plan-inv-p11:confirm',
        messageId: 'msg-inv-1',
        status: 'confirmed',
        action: {
          kind: 'concierge_triage_confirm',
          planId: 'plan-inv-p11',
          intent: 'investigate',
          investigationJobId: 'inv_restored',
        },
      },
    ];

    await act(async () => {
      root.render(createElement(CardBlock, { block, messageId: 'msg-inv-1', confirmations: restoredConfirmations }));
    });

    // Give time for the restoration effect to run + poll
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });

    // Should show the persisted investigation report
    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl, 'should restore and display persisted investigation report on remount').toBeTruthy();
    expect(container.textContent).toContain('之前调查的结果');
  });

  // --- Cloud P2-2: cancel 500 with running re-poll should not freeze UI ---
  it('continues polling after cancel 500 when re-polled job is still running', async () => {
    const block = makeTriageConfirmBlock('plan-inv-cancel500');
    let pollCount = 0;

    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/confirm')) {
        return {
          ok: true,
          json: async () => ({ planId: 'plan-inv-cancel500', status: 'dispatched', investigationJobId: 'inv_c500' }),
        } as Response;
      }
      // Cancel endpoint returns 500 (transient failure)
      if (typeof url === 'string' && url.includes('/cancel') && init?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Internal Server Error' }),
        } as unknown as Response;
      }
      // Poll sequence: running → running (after cancel re-poll) → done
      if (typeof url === 'string' && url.includes('/investigation/inv_c500')) {
        pollCount++;
        if (pollCount <= 3) {
          return {
            ok: true,
            json: async () => ({
              job: { id: 'inv_c500', status: 'running', query: 'test', createdAt: 1, updatedAt: 1, deadline: 99999 },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'inv_c500',
              status: 'done',
              query: 'test',
              report: { summary: '完成了', anchors: [] },
              createdAt: 1,
              updatedAt: 1,
              completedAt: 2,
              deadline: 99999,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    // Poll 1: running
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Click cancel → 500 → re-poll returns running
    const cancelBtn = container.querySelector('[data-testid="investigation-cancel"]') as HTMLButtonElement | null;
    expect(cancelBtn).toBeTruthy();
    await act(async () => {
      cancelBtn?.click();
    });

    // Give cancel handler time to complete
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    // Should NOT be frozen — polling should continue
    // Advance to trigger more polls until job completes
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl, 'should eventually show report after cancel 500 + continued polling').toBeTruthy();
    expect(container.textContent).toContain('完成了');
  });

  // --- Cloud P2-1: stale in-flight poll must not overwrite terminal state ---
  it('ignores stale non-terminal poll response after terminal state is reached', async () => {
    const block = makeTriageConfirmBlock('plan-stale-poll');
    let pollCount = 0;
    // Simulate: poll 1 = slow (returns running AFTER poll 2 already resolved done)
    // We control this by making poll 2 resolve "done" and poll 1 resolve "running" later.
    let resolveSlow: ((v: Response) => void) | null = null;

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/confirm')) {
        return {
          ok: true,
          json: async () => ({ planId: 'plan-stale-poll', status: 'dispatched', investigationJobId: 'inv_stale' }),
        } as Response;
      }
      if (typeof url === 'string' && url.includes('/investigation/inv_stale')) {
        pollCount++;
        if (pollCount === 1) {
          // First poll: returns 'running' immediately (initial)
          return {
            ok: true,
            json: async () => ({
              job: { id: 'inv_stale', status: 'running', query: 'test', createdAt: 1, updatedAt: 1, deadline: 99999 },
            }),
          } as Response;
        }
        if (pollCount === 2) {
          // Second poll (interval tick): slow — will resolve after poll 3
          return new Promise<Response>((resolve) => {
            resolveSlow = resolve;
          });
        }
        // pollCount >= 3: returns 'done'
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'inv_stale',
              status: 'done',
              query: 'test',
              report: { summary: '调查结果', anchors: [] },
              createdAt: 1,
              updatedAt: 1,
              completedAt: 2,
              deadline: 99999,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    // Poll 1: running (initial poll)
    // Poll 2 (at 2s): starts but is slow (pending promise)
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Poll 3 (at 4s): returns 'done' immediately → terminal state reached
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Now report should be showing
    expect(container.querySelector('[data-testid="investigation-report"]')).toBeTruthy();
    expect(container.textContent).toContain('调查结果');

    // Now resolve the slow poll 2 with 'running' — this MUST NOT overwrite the terminal 'done'
    await act(async () => {
      resolveSlow?.({
        ok: true,
        json: async () => ({
          job: { id: 'inv_stale', status: 'running', query: 'test', createdAt: 1, updatedAt: 1, deadline: 99999 },
        }),
      } as Response);
    });

    // Report must STILL be showing — stale 'running' must not regress to spinner
    expect(
      container.querySelector('[data-testid="investigation-report"]'),
      'stale running response must not overwrite terminal done state',
    ).toBeTruthy();
    expect(container.textContent).toContain('调查结果');
  });

  // --- R2 P2: transient HTTP error should not permanently stop polling ---
  it('resumes polling after transient 500 instead of permanently stopping', async () => {
    const block = makeTriageConfirmBlock('plan-inv-r2p2');
    let pollCount = 0;

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/confirm')) {
        return {
          ok: true,
          json: async () => ({ planId: 'plan-inv-r2p2', status: 'dispatched', investigationJobId: 'inv_transient' }),
        } as Response;
      }
      if (typeof url === 'string' && url.includes('/investigation/inv_transient')) {
        pollCount++;
        // Poll 1: running (normal)
        if (pollCount === 1) {
          return {
            ok: true,
            json: async () => ({
              job: {
                id: 'inv_transient',
                status: 'running',
                query: 'test',
                createdAt: 1,
                updatedAt: 1,
                deadline: 99999,
              },
            }),
          } as Response;
        }
        // Poll 2: transient 500 error
        if (pollCount === 2) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'Internal Server Error' }),
          } as unknown as Response;
        }
        // Poll 3+: done with report (should reach here if polling continues)
        return {
          ok: true,
          json: async () => ({
            job: {
              id: 'inv_transient',
              status: 'done',
              query: 'test',
              report: { summary: '恢复后完成的调查', anchors: [] },
              createdAt: 1,
              updatedAt: 1,
              completedAt: 2,
              deadline: 99999,
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    // Poll 1: running
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.querySelector('[data-testid="investigation-progress"]')).toBeTruthy();

    // Poll 2: transient 500 → should show error but NOT stop polling
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Poll 3: server recovers → should show report (proves polling continued)
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl, 'polling should continue after transient 500 and show report when server recovers').toBeTruthy();
    expect(container.textContent).toContain('恢复后完成的调查');
  });

  // --- P2-4: test fixture with messageId to exercise real backend contract ---
  it('renders anchors with messageId matching backend buildReport contract', async () => {
    const block = makeTriageConfirmBlock('plan-inv-p24');

    const realReport = {
      summary: '找到了 2 条相关信息。\n\n[跳过去 R1] F229 Phase B 讨论\n[跳过去 R2] 相关消息',
      anchors: [
        {
          handle: 'R1',
          kind: 'thread' as const,
          threadId: 'thread_real_1',
          messageId: 'msg_real_abc',
          title: 'F229 Phase B 讨论',
          relevance: '直接相关：讨论了总机能力设计',
        },
        {
          handle: 'R2',
          kind: 'thread' as const,
          threadId: 'thread_real_2',
          title: '相关消息',
          relevance: '间接相关',
        },
      ],
    };

    mockConfirmAndPoll('plan-inv-p24', 'inv_real', 'done', realReport);

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // Both anchors render
    expect(container.textContent).toContain('R1');
    expect(container.textContent).toContain('F229 Phase B 讨论');
    expect(container.textContent).toContain('R2');
    expect(container.textContent).toContain('相关消息');

    // Summary with markers renders
    expect(container.textContent).toContain('找到了 2 条相关信息');
  });

  // --- R2 P2: raw marker syntax should be stripped from rendered summary ---
  it('strips raw marker syntax from report summary instead of showing brackets', async () => {
    const block = makeTriageConfirmBlock('plan-inv-markers');

    // Backend buildReport writes markers like [跳过去 R1], [查看 R2], [链接 R3], [R4] into summary
    const markerReport = {
      summary:
        '关于「F229」找到 4 条相关记录：\n[跳过去 R1] 讨论记录\n[查看 R2] docs/features/F229.md\n[链接 R3] PR #2307\n[R4] 未知条目',
      anchors: [
        { handle: 'R1', kind: 'thread' as const, threadId: 't1', title: '讨论记录', relevance: '相关' },
        { handle: 'R2', kind: 'doc' as const, path: 'docs/features/F229.md', title: 'F229 doc', relevance: '文档' },
        {
          handle: 'R3',
          kind: 'github' as const,
          path: 'https://github.com/example/repo/pull/2307',
          title: 'PR #2307',
          relevance: 'PR',
        },
        { handle: 'R4', kind: 'unknown' as const, title: '未知条目', relevance: '其他' },
      ],
    };

    mockConfirmAndPoll('plan-inv-markers', 'inv_markers', 'done', markerReport);

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    const reportEl = container.querySelector('[data-testid="investigation-report"]');
    expect(reportEl).toBeTruthy();

    // Summary intro text should still be present
    expect(container.textContent).toContain('关于「F229」找到 4 条相关记录');

    // Raw marker brackets must NOT leak into rendered output
    expect(container.textContent).not.toContain('[跳过去');
    expect(container.textContent).not.toContain('[查看');
    expect(container.textContent).not.toContain('[链接');
    expect(container.textContent).not.toContain('[R4]');
  });

  // --- R2 P2 (edge): marker-like text in user query must not be stripped ---
  it('preserves marker-like text inside user query prefix', async () => {
    const block = makeTriageConfirmBlock('plan-inv-query-edge');

    // User query contains [R1] — should NOT be stripped from the 关于「...」 prefix
    const edgeReport = {
      summary: '关于「[R1] 是什么意思」找到 1 条相关记录：\n[跳过去 R1] 讨论记录',
      anchors: [{ handle: 'R1', kind: 'thread' as const, threadId: 't1', title: '讨论记录', relevance: '相关' }],
    };

    mockConfirmAndPoll('plan-inv-query-edge', 'inv_edge', 'done', edgeReport);

    vi.useFakeTimers();
    await renderCard(block);
    await clickButton('确认');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    // The [R1] inside the user query must be preserved
    expect(container.textContent).toContain('[R1] 是什么意思');

    // But the line-start marker [跳过去 R1] must still be stripped
    expect(container.textContent).not.toContain('[跳过去');
  });
});
