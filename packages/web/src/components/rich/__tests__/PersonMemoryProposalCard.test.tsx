import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

const openApprovalHub = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/stores/approvalHubStore', () => ({
  useApprovalHubStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ open: openApprovalHub }),
    { getState: () => ({ open: openApprovalHub }) },
  ),
}));

import { PersonMemoryProposalCard } from '../PersonMemoryProposalCard';

const approvalMessageId = 'person-memory-card-message';
const block: RichCardBlock = {
  id: 'person-memory-person_candidate_card',
  kind: 'card',
  v: 1,
  title: '要把黄挺记下来吗？',
  bodyMarkdown: '1. **黄挺属于终端用户计算开发部**\n   来源：You 明确陈述',
  fields: [
    { label: '范围', value: '仅你的私人记忆' },
    { label: '写入', value: '在 Approval Hub 逐项勾选后自动完成' },
  ],
  actions: [
    {
      label: '去审批',
      action: 'person-memory:open-approval-hub',
      payload: { candidateId: 'person_candidate_card' },
    },
  ],
  meta: {
    kind: 'person_memory_proposal',
    candidateId: 'person_candidate_card',
    envelopeRef: 'approval:F276:person_candidate_card',
    decisionSurface: 'approval_hub',
    status: 'pending_approval',
  },
};

function snapshot(status: string, messageId = approvalMessageId) {
  return {
    proposalId: 'person_candidate_card',
    status,
    remainingDraftIds: status === 'materialized' ? [] : ['person_draft_fact'],
    publicationState: 'anchored',
    approvalCardMessageId: messageId,
    ...(status === 'materialized'
      ? {
          decisionReceipt: {
            decisionId: 'decision_card_1',
            materializedClaimIds: ['person_claim_1'],
            materializedRelationshipIds: ['person_relationship_1'],
            materializedEventIds: [],
          },
        }
      : {}),
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('PersonMemoryProposalCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    openApprovalHub.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows one navigation-only action and opens Approval Hub', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson(snapshot('pending_approval')));
    await act(async () => {
      root.render(<PersonMemoryProposalCard block={block} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    const button = container.querySelector<HTMLButtonElement>('[data-testid="person-memory-open-approval-hub"]');
    expect(button?.textContent).toContain('去审批');
    await act(async () => button?.click());
    expect(openApprovalHub).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('converges to a durable receipt with undo but never exposes inline approval', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson(snapshot('pending_approval')));
    await act(async () => {
      root.render(<PersonMemoryProposalCard block={block} messageId={approvalMessageId} />);
      await Promise.resolve();
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: snapshot('materialized'),
        }),
      );
    });

    expect(container.textContent).toContain('已写入');
    expect(container.textContent).toContain('1 条事实');
    expect(container.querySelector('[data-testid="person-memory-open-approval-hub"]')).toBeNull();
    expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.every((call) => !String(call[0]).endsWith('/approve'))).toBe(true);
  });

  it('undoes the exact durable decision and converges to withdrawn', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson(snapshot('materialized')))
      .mockResolvedValueOnce(okJson({ status: 'withdrawn', verdict: 'undone' }));
    await act(async () => {
      root.render(<PersonMemoryProposalCard block={block} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    const undo = container.querySelector<HTMLButtonElement>('[data-testid="person-memory-undo"]');
    await act(async () => {
      undo?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('已撤回');
    expect(container.querySelector('[data-testid="person-memory-undo"]')).toBeNull();
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/person-memory-proposals/person_candidate_card/undo',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails closed when hydration or card anchoring cannot be verified', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson(snapshot('pending_approval', 'different-message')));
    await act(async () => {
      root.render(<PersonMemoryProposalCard block={block} messageId={approvalMessageId} />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('审批卡来源验证失败');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('does not let a late pending hydration overwrite a materialized socket receipt', async () => {
    let resolveHydration!: (response: Response) => void;
    vi.mocked(apiFetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveHydration = resolve;
      }),
    );

    act(() => root.render(<PersonMemoryProposalCard block={block} messageId={approvalMessageId} />));
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: snapshot('materialized'),
        }),
      );
    });
    await act(async () => {
      resolveHydration(okJson(snapshot('pending_approval')));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('已写入');
    expect(container.querySelector('[data-testid="person-memory-undo"]')).not.toBeNull();
  });
});
