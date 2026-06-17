import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { HandoffProposalCard, isHandoffProposalCardBlock } from '../HandoffProposalCard';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

const legacyHandoffTitlePrefix = String.fromCodePoint(0x1f504);

const handoffBlock: RichCardBlock = {
  id: 'handoff-prop_1',
  kind: 'card',
  v: 1,
  title: `${legacyHandoffTitlePrefix} 提议 session 接力（封印当前 → 续接 fresh 自己）`,
  bodyMarkdown: 'opus 想在干净断点封印当前 session。',
  tone: 'info',
  fields: [
    { label: '封印 session', value: 'sess_1' },
    { label: '已完成', value: 'wired A' },
    { label: '下一步', value: 'wire B' },
  ],
  actions: [
    { label: '批准并接力', action: 'handoff:approve', payload: { proposalId: 'prop_1' } },
    { label: '驳回', action: 'handoff:reject', payload: { proposalId: 'prop_1' } },
  ],
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('HandoffProposalCard (F225 P1-2 — buttons no longer inert)', () => {
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
    // 云端 P2 added a mount GET status fetch, so every render now also calls apiFetch. Default:
    // mount GET → pending; POST approve/reject → settled status. Tests override for settled-on-load.
    vi.mocked(apiFetch).mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return okJson({ status: url.endsWith('/approve') ? 'approved' : 'rejected' });
      }
      return okJson({ proposal: { status: 'pending' } });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('isHandoffProposalCardBlock recognizes handoff:approve (not F128 propose:approve)', () => {
    expect(isHandoffProposalCardBlock(handoffBlock)).toBe(true);
    const f128: RichCardBlock = {
      ...handoffBlock,
      actions: [{ label: 'x', action: 'propose:approve', payload: { proposalId: 'p' } }],
    };
    expect(isHandoffProposalCardBlock(f128)).toBe(false);
  });

  it('renders 五件套 fields + two real approve/reject buttons', () => {
    act(() => root.render(<HandoffProposalCard block={handoffBlock} />));
    expect(container.textContent).toContain('提议 session 接力');
    expect(container.textContent).not.toContain(legacyHandoffTitlePrefix);
    expect(container.querySelector('svg[data-testid="handoff-card-icon"]')).not.toBeNull();
    expect(container.textContent).toContain('sess_1');
    expect(container.textContent).toContain('wire B');
    expect(container.querySelectorAll('button').length).toBe(2);
  });

  it('renders metadata as compact text and rich handoff fields as markdown sections', () => {
    const richBlock: RichCardBlock = {
      ...handoffBlock,
      fields: [
        { label: '封印 session', value: 'sess_2' },
        { label: 'worktree', value: 'cat-cafe-f225' },
        { label: '已完成', value: '- **wired A**\n- wired B' },
        { label: '下一步', value: '1. wire C\n2. wire D' },
      ],
    };
    act(() => root.render(<HandoffProposalCard block={richBlock} />));

    expect(container.textContent).toContain('sess_2');
    expect(container.textContent).toContain('cat-cafe-f225');
    expect(container.textContent).toContain('已完成');
    expect(container.textContent).toContain('下一步');
    expect(container.querySelector('strong')?.textContent).toBe('wired A');
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(4);
  });

  it('approve button POSTs /api/session-handoff/:id/approve then shows approved', async () => {
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准'));
    await act(async () => {
      approveBtn?.click();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/session-handoff/prop_1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已批准');
  });

  it('reject button POSTs /api/session-handoff/:id/reject then shows rejected', async () => {
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    const rejectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('驳回'));
    await act(async () => {
      rejectBtn?.click();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/session-handoff/prop_1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('已驳回');
  });

  it('reject-after-expire reflects SERVER status (已过期), not the optimistic verb (gpt52 P2)', async () => {
    // The reject route returns deduped { status: 'expired' } for an already-expired proposal; the card
    // must render 已过期 from the server result, not 已驳回 from the clicked verb.
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return okJson({ status: 'expired', deduped: true });
      return okJson({ proposal: { status: 'pending' } });
    });
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    const rejectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('驳回'));
    await act(async () => {
      rejectBtn?.click();
    });
    expect(container.textContent).toContain('已过期');
    expect(container.textContent).not.toContain('已驳回');
  });

  it('approve on an already-terminal proposal (409 {status:expired}) converges to 已过期, not a bare error (gpt52 P2)', async () => {
    // The approve route returns 409 { status: 'expired' } when the proposal is already terminal at
    // request time. A stale / cross-tab card clicking 批准并接力 must converge to the server status
    // (consume data.status even on !res.ok), not stay pending or surface only an error.
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'already terminal', status: 'expired' }),
        } as Response;
      }
      return okJson({ proposal: { status: 'pending' } });
    });
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准'));
    await act(async () => {
      approveBtn?.click();
    });
    expect(container.textContent).toContain('已过期');
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('hydrates durable status on mount — settled card shows no live buttons (云端 P2)', async () => {
    // mount GET returns an already-approved proposal (reload / multi-tab that missed the socket event)
    vi.mocked(apiFetch).mockImplementation(async () => okJson({ proposal: { status: 'approved' } }));
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/session-handoff/prop_1');
    expect(container.textContent).toContain('已批准');
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('monotonic hydration — a late pending GET does NOT revert a settled click (砚砚 re-review P2)', async () => {
    let resolveGet: ((r: Response) => void) | undefined;
    const lateGet = new Promise<Response>((r) => {
      resolveGet = r;
    });
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return okJson({ status: 'approved' });
      return lateGet; // mount GET stays pending until we resolve it below
    });
    await act(async () => {
      root.render(<HandoffProposalCard block={handoffBlock} />);
    });
    // user clicks approve BEFORE the mount GET resolves → local status settles to approved
    const approveBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('批准'));
    await act(async () => {
      approveBtn?.click();
    });
    expect(container.textContent).toContain('已批准');
    // now the late mount GET resolves with a STALE 'pending'
    await act(async () => {
      resolveGet?.(okJson({ proposal: { status: 'pending' } }));
      await lateGet;
    });
    // monotonic: settled 'approved' survives the late pending GET — no live buttons reappear
    expect(container.textContent).toContain('已批准');
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
