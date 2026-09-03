import type { CustodyOfferV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CustodyOfferCard } from '../CustodyOfferCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis as Record<string, unknown>, { React });

const sourceMessageId = 'message-source';
const sourceMessageRevision = `sha256:${'a'.repeat(64)}`;
const pending: CustodyOfferV1 = {
  offerId: 'custody-offer:message-source',
  sourceMessageRevision,
  policyVersion: 'custody-recognition-v1',
  reasonCode: 'future_deliverable',
  disposition: 'pending',
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function accepted(result: 'admitted' | 'resumed' | 'needs_clarification'): CustodyOfferV1 {
  return {
    ...pending,
    disposition: 'accepted',
    actorRef: 'user:owner-1',
    dispositionAt: 1_788_190_000_100,
    admission: {
      state: 'resulted',
      idempotencyKey: 'custody:custody-offer:message-source',
      result:
        result === 'needs_clarification'
          ? { result, clarificationReason: 'The intended outcome is missing.' }
          : {
              result,
              subjectRef: 'task:work:presentation',
              ownerRef: 'task:item:presentation',
              revision: 1,
              receiptRef: 'task:receipt:presentation',
            },
    },
  };
}

describe('CustodyOfferCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT);
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows exactly one accept/decline choice and submits the exact source revision', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ kind: 'found', sourceMessageRevision, offer: pending }))
      .mockResolvedValueOnce(okJson({ kind: 'accepted', transitioned: true, offer: accepted('admitted') }));

    await act(async () => {
      root.render(<CustodyOfferCard sourceMessageId={sourceMessageId} expectedOffer={pending} />);
      await Promise.resolve();
    });
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(container.textContent).toContain('要不要我帮你接住这件事');

    const accept = [...container.querySelectorAll('button')].find((button) => button.textContent === '接住');
    await act(async () => {
      accept?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      `/api/messages/${sourceMessageId}/custody-offer/accept`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sourceMessageRevision, offerId: pending.offerId }),
      }),
    );
    expect(container.textContent).toContain('我们接住了');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('fails closed when the hydrated owner no longer matches the source-bound card', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        kind: 'found',
        sourceMessageRevision: `sha256:${'b'.repeat(64)}`,
        offer: { ...pending, sourceMessageRevision: `sha256:${'b'.repeat(64)}` },
      }),
    );
    await act(async () => {
      root.render(<CustodyOfferCard sourceMessageId={sourceMessageId} expectedOffer={pending} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('请回到原消息');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('keeps needs_clarification source-local and never claims that Task custody exists', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({ kind: 'found', sourceMessageRevision, offer: accepted('needs_clarification') }),
    );
    await act(async () => {
      root.render(<CustodyOfferCard sourceMessageId={sourceMessageId} expectedOffer={pending} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('还差一个关键信息');
    expect(container.textContent).toContain('还没有建立任务');
    expect(container.textContent).not.toContain('我们接住了');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('refetches canonical truth after the source-owner invalidation event', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ kind: 'found', sourceMessageRevision, offer: pending }))
      .mockResolvedValueOnce(okJson({ kind: 'found', sourceMessageRevision, offer: accepted('resumed') }));
    await act(async () => {
      root.render(<CustodyOfferCard sourceMessageId={sourceMessageId} expectedOffer={pending} />);
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:custody-offer-updated', { detail: { messageId: sourceMessageId } }),
      );
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('我们接住了');
  });
});
