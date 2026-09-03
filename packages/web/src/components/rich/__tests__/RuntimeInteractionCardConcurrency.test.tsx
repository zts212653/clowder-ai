import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../RichBlocks';
import { approvalRequest, block, errorJson, messageId, okJson, record } from './runtime-interaction-test-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis as Record<string, unknown>, { React });

describe('RuntimeInteractionCard concurrency', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => ((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true));
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

  it('does not let an in-flight pending hydration overwrite a terminal submit response', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    let getCount = 0;
    vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
      if (!options) {
        getCount += 1;
        if (getCount === 1) return okJson({ interaction: record(approvalRequest()) });
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return okJson({
        interaction: record(approvalRequest(), 'declined', {
          status: 'declined',
          reasonCode: 'user_rejected',
          settledAt: 3000,
        }),
      });
    });
    await renderCard(root);
    act(() => {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:runtime-interaction-updated', { detail: { interactionId: 'interaction-ui' } }),
      );
    });
    await clickDecline(container);
    expect(container.textContent).toContain('你已拒绝这次请求');
    await act(async () => {
      resolveRefresh?.(okJson({ interaction: record(approvalRequest()) }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('你已拒绝这次请求');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('rehydrates canonical terminal truth after a 409 stale response', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(approvalRequest()) }))
      .mockResolvedValueOnce(
        errorJson(409, {
          error: 'runtime interaction has no active provider waiter',
          reasonCode: 'transport_lost',
        }),
      )
      .mockResolvedValueOnce(
        okJson({
          interaction: record(approvalRequest(), 'invalidated', {
            status: 'invalidated',
            reasonCode: 'transport_lost',
            settledAt: 3000,
          }),
        }),
      );
    await renderCard(root);
    await clickDecline(container);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('运行连接已中断，这个请求已失效');
    expect(container.textContent).not.toContain('no active provider waiter');
  });

  it('allows only one submit while the first POST is in flight', async () => {
    let resolveSubmit: ((response: Response) => void) | undefined;
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(approvalRequest()) }))
      .mockImplementationOnce(
        async () =>
          new Promise<Response>((resolve) => {
            resolveSubmit = resolve;
          }),
      );
    await renderCard(root);
    const decline = findDecline(container);
    await act(async () => {
      decline?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      decline?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveSubmit?.(
        okJson({
          interaction: record(approvalRequest(), 'declined', {
            status: 'declined',
            reasonCode: 'user_rejected',
            settledAt: 3000,
          }),
        }),
      );
      await Promise.resolve();
    });
  });

  it('shows a stable error when an upstream failure body is not JSON', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(okJson({ interaction: record(approvalRequest()) }))
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));
    await renderCard(root);
    await clickDecline(container);
    expect(container.textContent).toContain('提交失败');
    expect(container.textContent).not.toContain("Unexpected token '<'");
  });
});

async function renderCard(root: Root): Promise<void> {
  await act(async () => {
    root.render(<RichBlocks blocks={[block]} messageId={messageId} />);
    await Promise.resolve();
  });
}

async function clickDecline(container: HTMLDivElement): Promise<void> {
  const decline = findDecline(container);
  await act(async () => {
    decline?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function findDecline(container: HTMLDivElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button): button is HTMLButtonElement => button.textContent === 'Decline',
  );
}
