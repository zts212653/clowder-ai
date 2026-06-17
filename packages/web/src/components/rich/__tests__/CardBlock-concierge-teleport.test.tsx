/**
 * F229 AC-A3 Bug1: concierge teleport/go 跨 thread 导航必须走 pathname 路由
 * (`/thread/<id>` + history.pushState), NOT query (`/?threadId=<id>`).
 *
 * 根因: chat 路由 threadId 唯一来源是 getThreadIdFromPathname(window.location.pathname)
 * ((chat)/layout.tsx). query `?threadId=` 全 web 零消费者 → pathname='/' → 'default'(大厅).
 * production R3 实测: 点"跳过去"跳大厅 (thread_mqawamwdxtvem4k5). 现有 artifacts-panel-jump
 * 只测了同 thread pending, 跨 thread URL 格式从无覆盖 → 测试盲点.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardBlock } from '@/components/rich/CardBlock';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';

const mockOnNavigationAction = vi.fn();
vi.mock('@/stores/conciergeStore', () => ({
  useConciergeStore: { getState: () => ({ onNavigationAction: mockOnNavigationAction }) },
}));

const chatState = { currentThreadId: 'thread_A' as string | null, updateRichBlock: vi.fn() };
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => chatState },
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

describe('CardBlock concierge teleport/go cross-thread navigation (Bug1: query → path)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pushStateSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    __resetPendingTeleportForTest();
    chatState.currentThreadId = 'thread_A';
    vi.mocked(apiFetch).mockReset();
    // Reset pathname to '/' so pushThreadRouteWithHistory doesn't skip pushState
    // (it short-circuits when location.pathname already === target href — cross-test pollution).
    window.history.replaceState(null, '', '/');
    pushStateSpy = vi.spyOn(window.history, 'pushState');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderAndClick(block: RichCardBlock, label: string): void {
    act(() => {
      root.render(createElement(CardBlock, { block, messageId: 'msg-1' }));
    });
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    expect(btn, `button containing "${label}" should render`).toBeTruthy();
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('teleport WITHOUT messageId navigates to /thread/<id> pathname, not /?threadId= query (lobby fallback)', () => {
    const block: RichCardBlock = {
      id: 'c-1',
      kind: 'card',
      v: 1,
      title: '',
      actions: [{ action: 'concierge_teleport', label: '跳过去：F229讨论', payload: { threadId: 'thread_B' } }],
    };
    renderAndClick(block, '跳过去');
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread_B');
  });

  it('teleport WITH messageId (cross-thread) navigates to /thread/<id> AND records pending teleport', () => {
    const block: RichCardBlock = {
      id: 'c-2',
      kind: 'card',
      v: 1,
      title: '',
      actions: [
        {
          action: 'concierge_teleport',
          label: '跳过去：F229讨论',
          payload: { threadId: 'thread_B', messageId: 'msg-x' },
        },
      ],
    };
    renderAndClick(block, '跳过去');
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread_B');
    expect(peekPendingTeleport('thread_B')?.messageId).toBe('msg-x');
  });

  it('concierge_go navigates to /thread/<id> pathname (not query)', () => {
    const block: RichCardBlock = {
      id: 'c-3',
      kind: 'card',
      v: 1,
      title: '',
      actions: [{ action: 'concierge_go', label: '跟去', payload: { targetThreadId: 'thread_B' } }],
    };
    renderAndClick(block, '跟去');
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread_B');
  });

  it('P1: restored confirmed triage state disables the plan buttons after refresh', () => {
    const block: RichCardBlock = {
      id: 'triage-card',
      kind: 'card',
      v: 1,
      title: '分诊计划',
      actions: [
        {
          action: 'concierge_triage_confirm',
          label: '确认传话',
          payload: { planId: 'plan-1', intent: 'relay' },
        },
        {
          action: 'concierge_triage_cancel',
          label: '取消',
          payload: { planId: 'plan-1' },
        },
      ],
    };

    act(() => {
      root.render(
        createElement(CardBlock, {
          block,
          messageId: 'msg-1',
          confirmations: [
            {
              id: 'c1',
              messageId: 'msg-1',
              status: 'confirmed',
              action: { kind: 'concierge_triage_confirm', planId: 'plan-1', intent: 'relay', summary: '传话' },
            },
          ],
        }),
      );
    });

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('已确认');
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('P1: restored cancelled triage state disables the plan buttons after refresh', () => {
    const block: RichCardBlock = {
      id: 'triage-card',
      kind: 'card',
      v: 1,
      title: '分诊计划',
      actions: [
        {
          action: 'concierge_triage_confirm',
          label: '确认传话',
          payload: { planId: 'plan-1', intent: 'relay' },
        },
        {
          action: 'concierge_triage_cancel',
          label: '取消',
          payload: { planId: 'plan-1' },
        },
      ],
    };

    act(() => {
      root.render(
        createElement(CardBlock, {
          block,
          messageId: 'msg-1',
          confirmations: [
            {
              id: 'c1',
              messageId: 'msg-1',
              status: 'cancelled',
              action: { kind: 'concierge_triage_cancel', planId: 'plan-1' },
            },
          ],
        }),
      );
    });

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toContain('已取消');
    expect(buttons.every((b) => b.disabled)).toBe(true);
  });

  it('P1: propose_thread triage confirmation navigates to the created thread', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'completed', threadId: 'thread_new_investigation' }),
    } as Response);
    const block: RichCardBlock = {
      id: 'triage-card',
      kind: 'card',
      v: 1,
      title: '开新调查',
      actions: [
        {
          action: 'concierge_triage_confirm',
          label: '确认开新调查',
          payload: { planId: 'plan-2', intent: 'propose_thread' },
        },
      ],
    };

    await act(async () => {
      root.render(createElement(CardBlock, { block, messageId: 'msg-1' }));
    });
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('确认开新调查'));
    expect(btn).toBeTruthy();

    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/concierge/triage/plan-2/confirm', { method: 'POST' });
    expect(mockOnNavigationAction).toHaveBeenCalled();
    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/thread/thread_new_investigation');
  });

  it('P1: relay triage confirmation posts user-selected targetCats', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'completed', relayReceiptId: 'receipt-1' }),
    } as Response);
    const block: RichCardBlock = {
      id: 'triage-card',
      kind: 'card',
      v: 1,
      title: '选择目标猫',
      actions: [
        {
          action: 'concierge_triage_confirm',
          label: '确认传话给 @codex',
          payload: { planId: 'plan-3', intent: 'relay', targetCats: ['codex'] },
        },
      ],
    };

    await act(async () => {
      root.render(createElement(CardBlock, { block, messageId: 'msg-1' }));
    });
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('确认传话给 @codex'));
    expect(btn).toBeTruthy();

    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/concierge/triage/plan-3/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetCats: ['codex'] }),
    });
  });
});
