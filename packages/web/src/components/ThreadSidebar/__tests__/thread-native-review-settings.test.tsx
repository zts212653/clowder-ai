import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import { ThreadNativeReviewSettingsContent } from '../ThreadNativeReviewSettings';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ThreadNativeReviewSettingsContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not hammer Review history while a native review is running', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(
      response({
        reviews: [
          {
            v: 1,
            id: 'review-running',
            target: { kind: 'uncommitted_changes' },
            delivery: 'inline',
            status: 'running',
            requestedAt: 100,
            updatedAt: 100,
            items: [],
          },
        ],
      }),
    );

    await act(async () => root.render(<ThreadNativeReviewSettingsContent threadId="thread-1" />));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps reconciling an active review whose bounded history projection is temporarily absent', async () => {
    vi.useFakeTimers();
    apiFetch
      .mockResolvedValueOnce(response({ reviews: [], activeReviewIds: ['review-running'] }))
      .mockResolvedValueOnce(
        response({
          reviews: [
            {
              v: 1,
              id: 'review-running',
              target: { kind: 'uncommitted_changes' },
              delivery: 'inline',
              status: 'completed',
              requestedAt: 100,
              updatedAt: 200,
              items: [],
              result: { status: 'completed', summary: 'No findings' },
              truncated: true,
            },
          ],
          activeReviewIds: [],
        }),
      );

    await act(async () => root.render(<ThreadNativeReviewSettingsContent threadId="thread-1" />));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('No findings');

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('states that native Review is not an independent merge-gate reviewer and renders structured results', async () => {
    apiFetch.mockResolvedValueOnce(
      response({
        reviews: [
          {
            v: 1,
            id: 'review-1',
            target: { kind: 'uncommitted_changes' },
            delivery: 'inline',
            status: 'completed',
            requestedAt: 100,
            updatedAt: 102,
            items: [{ id: 'exit-1', kind: 'mode_exited', text: 'P1: unsafe delete', completedAt: 102 }],
            result: { status: 'completed', summary: 'P1: unsafe delete' },
          },
        ],
      }),
    );
    await act(async () => root.render(<ThreadNativeReviewSettingsContent threadId="thread-1" />));
    expect(container.textContent).toContain('不等于家里的独立 merge-gate reviewer');
    expect(container.textContent).toContain('P1: unsafe delete');
    expect(container.textContent).toContain('未提交改动');
  });

  it('starts a structured detached base-branch review without a slash command', async () => {
    apiFetch.mockResolvedValueOnce(response({ reviews: [] }));
    await act(async () => root.render(<ThreadNativeReviewSettingsContent threadId="thread-1" />));
    const select = container.querySelector<HTMLSelectElement>('select[name="targetKind"]');
    const branch = container.querySelector<HTMLInputElement>('input[name="baseBranch"]');
    const delivery = container.querySelector<HTMLSelectElement>('select[name="delivery"]');
    act(() => {
      if (select) select.value = 'base_branch';
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const visibleBranch = container.querySelector<HTMLInputElement>('input[name="baseBranch"]') ?? branch;
    act(() => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (visibleBranch) inputSetter?.call(visibleBranch, 'origin/main');
      visibleBranch?.dispatchEvent(new Event('input', { bubbles: true }));
      if (delivery) selectSetter?.call(delivery, 'detached');
      delivery?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    apiFetch.mockResolvedValueOnce(
      response(
        {
          review: {
            v: 1,
            id: 'review-2',
            target: { kind: 'base_branch', branch: 'origin/main' },
            delivery: 'detached',
            status: 'running',
            requestedAt: 100,
            updatedAt: 100,
            items: [],
          },
        },
        202,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const lastCall = apiFetch.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const init = lastCall?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      target: { kind: 'base_branch', branch: 'origin/main' },
      delivery: 'detached',
    });
  });

  it('sends an explicit native cat selection when more than one review session is available', async () => {
    apiFetch.mockResolvedValueOnce(
      response({ reviews: [], nativeTargets: [{ catId: 'codex' }, { catId: 'codex-terra' }] }),
    );
    await act(async () => root.render(<ThreadNativeReviewSettingsContent threadId="thread-1" />));
    const selector = container.querySelector<HTMLSelectElement>('select[name="reviewCatId"]');
    expect(selector).not.toBeNull();
    act(() => {
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (selector) selectSetter?.call(selector, 'codex-terra');
      selector?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    apiFetch.mockResolvedValueOnce(
      response(
        {
          review: {
            v: 1,
            id: 'review-selected',
            target: { kind: 'uncommitted_changes' },
            delivery: 'inline',
            status: 'running',
            requestedAt: 100,
            updatedAt: 100,
            items: [],
            catId: 'codex-terra',
          },
        },
        202,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const body = JSON.parse(String((apiFetch.mock.calls.at(-1)?.[1] as RequestInit).body));
    expect(body.catId).toBe('codex-terra');
  });
});
