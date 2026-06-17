import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { CardBlock } from '../CardBlock';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

describe('CardBlock — unhandled action defense (F225 dogfood)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // A card whose action THIS build doesn't handle (e.g. a stale browser bundle rendering a newer
  // `handoff:approve` card via the generic CardBlock) silently no-ops — exactly the F225 dogfood P0.
  // The generic renderer must warn so "stale bundle + new action card" self-diagnoses → hard-refresh.
  it('warns when an unhandled card action is clicked (self-diagnosing for stale bundle)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block: RichCardBlock = {
      id: 'card_1',
      kind: 'card',
      v: 1,
      title: '提议 session 接力',
      actions: [{ label: '批准并接力', action: 'handoff:approve', payload: { proposalId: 'p1' } }],
    };
    await act(async () => {
      root.render(<CardBlock block={block} />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('handoff:approve');
  });
});

// F231 Phase C Task5: the profile-update confirmation card is a GENERIC `kind:'card'` block (not a
// dedicated renderer like thread/handoff proposals), so its approve/reject actions dispatch through
// CardBlock.handleAction. These pin the decision-route contract the operator triggers from the card.
describe('CardBlock — F231 profile-update decision dispatch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(apiFetch).mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function profileUpdateBlock(action: string, proposalId = 'p1') {
    const label = action === 'profile-update:approve' ? '批准并写入' : '驳回';
    const block: RichCardBlock = {
      id: `profile-update-${proposalId}`,
      kind: 'card',
      v: 1,
      title: '提议更新关系档案（primer）',
      actions: [{ label, action, payload: proposalId ? { proposalId } : {} }],
    };
    return block;
  }

  it('approve action POSTs to the approve decision route with the proposalId', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ proposalId: 'p1', status: 'approved', writtenPath: '/x/y-primer.md' }),
    } as unknown as Response);

    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/profile-updates/p1/approve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reject action POSTs to the reject decision route with the proposalId', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ proposalId: 'p1', status: 'rejected' }),
    } as unknown as Response);

    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:reject')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/profile-updates/p1/reject',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces the server error when the decision request fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Primer changed since propose (optimistic lock); re-propose' }),
    } as unknown as Response);

    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    await act(async () => {});

    expect(container.textContent).toContain('optimistic lock');
  });

  it('approve on an already-terminal proposal (409 {status:rejected}) collapses to rejected', async () => {
    const updateRichBlock = vi.spyOn(useChatStore.getState(), 'updateRichBlock').mockImplementation(() => {});
    vi.mocked(apiFetch).mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'already terminal', status: 'rejected' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ proposalId: 'p1', status: 'pending' }),
      } as Response;
    });

    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });
    await act(async () => {});

    expect(container.textContent).not.toContain('already terminal');
    expect(updateRichBlock).toHaveBeenCalledWith(
      'm1',
      'profile-update-p1',
      expect.objectContaining({
        tone: 'info',
        bodyMarkdown: '已驳回该提议',
        actions: undefined,
      }),
    );
  });

  it('does not dispatch and surfaces an error when proposalId is missing', async () => {
    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve', '')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(container.textContent).toContain('proposalId');
  });

  it('warns and does not dispatch unknown profile-update actions', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:edit')} messageId="m1" />);
    });
    const btn = container.querySelector('button');
    await act(async () => {
      btn?.click();
    });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('profile-update:edit'));
  });

  it('collapses matching cards when another tab settles the profile update', async () => {
    const updateRichBlock = vi.spyOn(useChatStore.getState(), 'updateRichBlock').mockImplementation(() => {});
    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve')} messageId="m1" />);
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: { proposalId: 'p1', status: 'approved' },
        }),
      );
    });

    expect(updateRichBlock).toHaveBeenCalledWith(
      'm1',
      'profile-update-p1',
      expect.objectContaining({
        tone: 'success',
        bodyMarkdown: '✓ 已批准并写入 primer',
        actions: undefined,
      }),
    );
  });

  it('hydrates and collapses already-approved profile-update cards on mount', async () => {
    const updateRichBlock = vi.spyOn(useChatStore.getState(), 'updateRichBlock').mockImplementation(() => {});
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ proposalId: 'p1', status: 'approved' }),
    } as unknown as Response);

    await act(async () => {
      root.render(<CardBlock block={profileUpdateBlock('profile-update:approve')} messageId="m1" />);
    });
    await act(async () => {});

    expect(apiFetch).toHaveBeenCalledWith('/api/profile-updates/p1');
    expect(updateRichBlock).toHaveBeenCalledWith(
      'm1',
      'profile-update-p1',
      expect.objectContaining({
        tone: 'success',
        bodyMarkdown: '✓ 已批准并写入 primer',
        actions: undefined,
      }),
    );
  });
});
