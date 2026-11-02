import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { RichBlocks } from '../RichBlocks';
import { RuntimeInteractionCard } from '../RuntimeInteractionCard';
import { approvalRequest, block, cardRef, messageId, okJson, record } from './runtime-interaction-test-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis as Record<string, unknown>, { React });

describe('RuntimeInteractionCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT);
  beforeEach(() => {
    observeApiSessionOwner('user-1');
    vi.mocked(apiFetch).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['another owner', 'another-user', 2000],
    ['another observed version', 'user-1', 1999],
  ] as const)('a hosted %s read cannot enable the canonical writer', async (_reason, ownerUserId, revision) => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(approvalRequest()) }));
    await act(async () =>
      root.render(
        <RuntimeInteractionCard
          block={block}
          messageId={messageId}
          host={{ ownerUserId, revision, cardRef, readCurrent: true, verifyCurrentRead: () => true }}
        />,
      ),
    );
    expect([...container.querySelectorAll('button')].filter((button) => !button.disabled)).toHaveLength(0);
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('locks an aligned hosted card while its containing owner read is being refreshed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(approvalRequest()) }));
    await act(async () =>
      root.render(
        <RuntimeInteractionCard
          block={block}
          messageId={messageId}
          host={{ ownerUserId: 'user-1', revision: 2000, cardRef, readCurrent: true, verifyCurrentRead: () => true }}
        />,
      ),
    );
    expect([...container.querySelectorAll('button')].some((button) => !button.disabled)).toBe(true);
    await act(async () =>
      root.render(
        <RuntimeInteractionCard
          block={block}
          messageId={messageId}
          host={{ ownerUserId: 'user-1', revision: 2000, cardRef, readCurrent: false, verifyCurrentRead: () => true }}
        />,
      ),
    );
    expect([...container.querySelectorAll('button')].some((button) => !button.disabled)).toBe(false);
  });

  it('keeps the original request title once in its hosted mailbox presentation', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(approvalRequest()) }));
    await act(async () =>
      root.render(
        <RuntimeInteractionCard
          block={block}
          messageId={messageId}
          host={{ ownerUserId: 'user-1', revision: 2000, cardRef, readCurrent: true, verifyCurrentRead: () => true }}
          presentation="mailbox"
        />,
      ),
    );
    expect([...container.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['Run tests?']);
    expect([...container.querySelectorAll('button')].some((button) => !button.disabled)).toBe(true);
  });

  it('checks the latest host generation at press time before React rerenders', async () => {
    let current = true;
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(approvalRequest()) }));
    await act(async () =>
      root.render(
        <RuntimeInteractionCard
          block={block}
          messageId={messageId}
          host={{ ownerUserId: 'user-1', revision: 2000, cardRef, readCurrent: true, verifyCurrentRead: () => current }}
        />,
      ),
    );
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Allow once');
    expect(button?.disabled).toBe(false);
    current = false;
    await act(async () => button?.click());
    expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('hydrates exact approval decisions and submits through the canonical card ref', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(approvalRequest()) }))
      .mockResolvedValueOnce(
        okJson({
          interaction: record(approvalRequest(), 'declined', {
            status: 'declined',
            reasonCode: 'user_rejected',
            settledAt: 3000,
            response: { kind: 'decision', decisionId: 'decline' },
          }),
        }),
      );

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Run tests?');
    expect(container.textContent).toContain('Allow this session');
    const decline = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Decline');

    await act(async () => {
      decline?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/api/runtime-interactions/interaction-ui/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cardRef, response: { kind: 'decision', decisionId: 'decline' } }),
      }),
    );
    expect(container.textContent).toContain('你已拒绝这次请求');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows a non-actionable preparing state while the canonical card is staged', async () => {
    const staged = record(approvalRequest(), 'staged');
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: { ...staged, cardRef: undefined } }));
    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('正在准备请求');
    expect(container.textContent).not.toContain('这个请求已失效');
    expect(container.textContent).not.toContain('只读副本');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders restart invalidation as stale rather than user rejection', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        interaction: record(approvalRequest(), 'invalidated', {
          status: 'invalidated',
          reasonCode: 'host_restarted',
          settledAt: 3000,
        }),
      }),
    );
    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('服务重启后，这个旧请求已失效');
    expect(container.textContent).not.toContain('你已拒绝');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders confirmation unavailability distinctly from user rejection', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      okJson({
        interaction: record(approvalRequest(), 'invalidated', {
          status: 'invalidated',
          reasonCode: 'confirmation_unavailable',
          settledAt: 3000,
        }),
      }),
    );
    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('此运行没有可用的确认界面');
    expect(container.textContent).not.toContain('你已拒绝');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('fails closed for a copied card while preserving the canonical card actions', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson({ interaction: record(approvalRequest()) }));
    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId="copied-message" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('只读副本');
    expect(container.querySelectorAll('button')).toHaveLength(0);

    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="runtime-interaction-actions"]')).not.toBeNull();
  });

  it('refetches canonical truth on runtime interaction socket invalidation', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(approvalRequest()) }))
      .mockResolvedValueOnce(
        okJson({
          interaction: record(approvalRequest(), 'invalidated', {
            status: 'invalidated',
            reasonCode: 'transport_lost',
            settledAt: 3000,
          }),
        }),
      );
    await act(async () => {
      root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:runtime-interaction-updated', { detail: { interactionId: 'interaction-ui' } }),
      );
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('运行连接已中断，这个请求已失效');
  });
});
