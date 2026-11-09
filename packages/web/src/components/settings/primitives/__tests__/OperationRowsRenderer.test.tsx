/**
 * F202 W2-3 h1 — the web side of per-row actions: an operation whose list action returns `rows`
 * renders a row list; a row action sends that row's input; a declared confirmation is asked first
 * in the shared Console dialog (and fails closed without one); a row is disabled while its action
 * runs, and a failure stays on its row.
 */
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
// The real confirm dialog, not the global auto-accepting stub from test-setup.ts.
vi.mock('@/components/useConfirm', async (importOriginal) => importOriginal());

import { apiFetch } from '@/utils/api-client';
import type { PlatformOperationStatus } from '../../../HubConfigIcons';

const mockApiFetch = vi.mocked(apiFetch);
const { ActionRenderer } = await import('../ActionRenderer');
const { ConfirmProvider } = await import('../../../useConfirm');

const target = { kind: 'plugin', id: 'chatgpt-pro' } as const;
const declaredWording = 'Stop routing this conversation to Clowder?';
const operation: PlatformOperationStatus = {
  name: 'authorization',
  label: 'Authorized conversations',
  actions: [
    { id: 'list', label: 'Refresh', render: 'status', resultRender: 'rows' },
    { id: 'reset', label: 'Reset all', render: 'button', confirm: 'Forget every conversation?', next: 'list' },
  ],
  rowActions: [{ id: 'revoke', label: 'Revoke', confirm: declaredWording, next: 'list' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Row = ReturnType<typeof row>;
const row = (key: string, confirm?: string) => ({
  key,
  label: `Conversation ${key}`,
  detail: `https://chatgpt.com/c/${key}`,
  actions: [{ action: 'revoke', input: { conversationId: key }, ...(confirm ? { confirm } : {}) }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface ServeOptions {
  readonly revokeError?: string;
  readonly revokeGate?: Promise<unknown>;
  readonly listError?: string;
  readonly empty?: string;
}

describe('OperationRowsRenderer (F202 W2-3 h1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ url: string; body?: string }>;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  /** Serve the list from `listed`; revoke removes its row (after `revokeGate`), or fails with `revokeError`. */
  function serve(initial: Row[], options: ServeOptions = {}) {
    let listed = initial;
    const list = () =>
      options.listError
        ? jsonResponse({ error: options.listError }, 502)
        : jsonResponse({
            ok: true,
            render: 'rows',
            data: { rows: listed, ...(options.empty ? { empty: options.empty } : {}) },
          });
    const revoke = async (body: string) => {
      await options.revokeGate;
      if (options.revokeError) return jsonResponse({ error: options.revokeError }, 502);
      const { conversationId } = JSON.parse(body) as { conversationId: string };
      listed = listed.filter((candidate) => candidate.key !== conversationId);
      return jsonResponse({
        ok: true,
        render: 'rows',
        data: { rows: listed },
        label: `${listed.length} authorized conversation(s)`,
        currentAction: 'list',
        advance: true,
      });
    };
    const reset = () => {
      listed = [];
      return jsonResponse({ ok: true, render: 'status', data: { status: 'ok' } });
    };
    const routes: Record<string, (body: string) => Response | Promise<Response>> = {
      '/api/plugins/chatgpt-pro/actions/authorization/list': list,
      '/api/plugins/chatgpt-pro/actions/authorization/revoke': revoke,
      '/api/plugins/chatgpt-pro/actions/authorization/reset': reset,
    };
    mockApiFetch.mockImplementation(async (url, init) => {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url: String(url), ...(body === undefined ? {} : { body }) });
      const route = routes[String(url)] ?? (() => jsonResponse({ error: 'unexpected request' }, 500));
      return route(body ?? '');
    });
  }

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render(ui: React.ReactElement, { withConfirm = true } = {}) {
    act(() => root.render(withConfirm ? <ConfirmProvider>{ui}</ConfirmProvider> : ui));
    await settle();
  }

  async function click(element: Element | null | undefined) {
    if (!element) throw new Error('missing element');
    await act(async () => {
      (element as HTMLElement).click();
    });
    await settle();
  }

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const revokeButton = (key: string) => byTestId(`chatgpt-pro-row-${key}-action-revoke`) as HTMLButtonElement | null;
  const dialogButton = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text);
  const sent = (action: string) => calls.filter(({ url }) => url.endsWith(`/authorization/${action}`));

  it('loads a polling status on entry without an always-visible refresh control', async () => {
    serve([row('waiting')]);
    const passive: PlatformOperationStatus = {
      ...operation,
      actions: [{ ...operation.actions[0]!, render: 'polling' }],
    };
    await render(<ActionRenderer target={target} operation={passive} />);
    expect(sent('list')).toHaveLength(1);
    expect(byTestId('chatgpt-pro-row-waiting')).not.toBeNull();
    expect(byTestId('chatgpt-pro-rows-refresh')).toBeNull();
  });

  it('offers a retry only after a polling status read fails and removes it after recovery', async () => {
    mockApiFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'Connection unavailable' }, 502))
      .mockResolvedValue(jsonResponse({ ok: true, render: 'rows', data: { rows: [row('ready')] } }));
    const passive: PlatformOperationStatus = {
      ...operation,
      actions: [{ ...operation.actions[0]!, render: 'polling' }],
    };
    await render(<ActionRenderer target={target} operation={passive} />);
    expect(byTestId('chatgpt-pro-rows-refresh')?.textContent).toBe('重新检查');
    await click(byTestId('chatgpt-pro-rows-refresh'));
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(byTestId('chatgpt-pro-row-ready')).not.toBeNull();
    expect(byTestId('chatgpt-pro-rows-refresh')).toBeNull();
  });

  it('retains owner confirmation for a polling list that explicitly requires it', async () => {
    serve([row('ready')]);
    const guarded: PlatformOperationStatus = {
      ...operation,
      actions: [{ ...operation.actions[0]!, render: 'polling', confirm: 'Allow this status read?' }],
    };
    await render(<ActionRenderer target={target} operation={guarded} />);
    expect(sent('list')).toHaveLength(0);
    await click(byTestId('chatgpt-pro-rows-refresh'));
    await click(dialogButton('取消'));
    expect(sent('list')).toHaveLength(0);
    await click(byTestId('chatgpt-pro-rows-refresh'));
    await click(dialogButton('确认'));
    expect(sent('list')).toHaveLength(1);
  });

  it('does not restore a previous rows receipt before an owner-confirmed list action', async () => {
    serve([]);
    const injected = {
      ...operation,
      lastResult: { render: 'rows', data: { rows: [row('stale')] } },
      actions: operation.actions.map((action) =>
        action.id === 'list' ? { ...action, confirm: 'Load current rows?' } : action,
      ),
    };
    await render(<ActionRenderer target={target} operation={injected} />);
    expect(byTestId('chatgpt-pro-row-stale')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('ignores a late button receipt after switching the plugin target', async () => {
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    mockApiFetch.mockImplementation(async (url) =>
      String(url).endsWith('/reset') ? delayed : jsonResponse({ ok: true, render: 'rows', data: { rows: [] } }),
    );
    const plain = { ...operation, actions: operation.actions.map((action) => ({ ...action, confirm: undefined })) };
    await render(<ActionRenderer target={target} operation={plain} />);
    await click(byTestId('chatgpt-pro-action-reset'));
    await render(<ActionRenderer target={{ kind: 'plugin', id: 'other-plugin' }} operation={plain} />);
    await act(async () => release(jsonResponse({ ok: false, label: 'stale reset failure' })));
    await settle();
    expect(container.textContent).not.toContain('stale reset failure');
  });

  it('lists the rows on mount, with their detail and the actions the Host validated', async () => {
    serve([row('a1'), row('b2')]);
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(calls.map(({ url }) => url)).toEqual(['/api/plugins/chatgpt-pro/actions/authorization/list']);
    expect(byTestId('chatgpt-pro-row-a1')?.textContent).toContain('Conversation a1');
    expect(byTestId('chatgpt-pro-row-a1')?.textContent).toContain('https://chatgpt.com/c/a1');
    expect(revokeButton('b2')?.textContent).toBe('Revoke');
  });

  it('replaces the current stage with rows returned by a row action without an extra list request', async () => {
    const stagedOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'advance', label: 'Continue' }],
    };
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return String(url).endsWith('/list')
        ? jsonResponse({
            ok: true,
            render: 'rows',
            data: {
              rows: [
                {
                  key: 'stage-one',
                  label: 'Stage one',
                  actions: [{ action: 'advance', input: { stage: 'one' } }],
                },
              ],
            },
          })
        : jsonResponse({
            ok: true,
            render: 'rows',
            data: { rows: [{ key: 'stage-two', label: 'Stage two' }] },
          });
    });

    await render(<ActionRenderer target={target} operation={stagedOperation} />);
    await click(byTestId('chatgpt-pro-row-stage-one-action-advance'));

    expect(byTestId('chatgpt-pro-row-stage-one')).toBeNull();
    expect(byTestId('chatgpt-pro-row-stage-two')?.textContent).toContain('Stage two');
    expect(sent('list')).toHaveLength(1);
  });

  it('does not let an older status request erase a freshly returned proposal', async () => {
    const staleStatus = deferred<Response>();
    let statusCalls = 0;
    const stagedOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'prepare', label: 'Prepare' }],
    };
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      if (String(url).endsWith('/prepare')) {
        return jsonResponse({
          ok: true,
          render: 'rows',
          data: { rows: [{ key: 'proposal-one', label: 'Exact Host proposal' }], validUntil: Date.now() + 60_000 },
        });
      }
      statusCalls += 1;
      return statusCalls === 1
        ? jsonResponse({
            ok: true,
            render: 'rows',
            data: {
              rows: [
                {
                  key: 'authorization-required',
                  label: 'Authorization required',
                  actions: [{ action: 'prepare', input: { intent: 'prepare' } }],
                },
              ],
            },
          })
        : staleStatus.promise;
    });

    await render(<ActionRenderer target={target} operation={stagedOperation} />);
    act(() => (byTestId('chatgpt-pro-rows-refresh') as HTMLButtonElement).click());
    await click(byTestId('chatgpt-pro-row-authorization-required-action-prepare'));
    expect(byTestId('chatgpt-pro-row-proposal-one')).not.toBeNull();

    await act(async () => staleStatus.resolve(jsonResponse({ ok: true, render: 'rows', data: { rows: [] } })));
    await settle();
    expect(byTestId('chatgpt-pro-row-proposal-one')).not.toBeNull();
  });

  it('keeps a request-scoped proposal row until local abandon, then performs only a status read', async () => {
    const stagedOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'prepare', label: 'Prepare' }],
    };
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return String(url).endsWith('/list')
        ? jsonResponse({
            ok: true,
            render: 'rows',
            data: {
              rows: [
                {
                  key: 'authorization-required',
                  label: 'Authorization required',
                  actions: [{ action: 'prepare', input: { intent: 'prepare' } }],
                },
              ],
            },
          })
        : jsonResponse({
            ok: true,
            render: 'rows',
            data: {
              rows: [{ key: 'proposal-one', label: 'Exact Host proposal' }],
              validUntil: Date.now() + 60_000,
            },
          });
    });

    await render(<ActionRenderer target={target} operation={stagedOperation} />);
    await click(byTestId('chatgpt-pro-row-authorization-required-action-prepare'));
    expect(byTestId('chatgpt-pro-row-proposal-one')).not.toBeNull();
    expect(byTestId('chatgpt-pro-rows-refresh')).toBeNull();

    await click(byTestId('chatgpt-pro-rows-abandon'));
    expect(byTestId('chatgpt-pro-row-proposal-one')).toBeNull();
    expect(byTestId('chatgpt-pro-row-authorization-required')).not.toBeNull();
    expect(sent('list')).toHaveLength(2);
    expect(calls.filter(({ url }) => url.endsWith('/prepare'))).toHaveLength(1);
  });

  it('expires a proposal row into one pure status read', async () => {
    const stagedOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'prepare', label: 'Prepare' }],
    };
    let prepared = false;
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      if (String(url).endsWith('/prepare')) {
        prepared = true;
        return jsonResponse({
          ok: true,
          render: 'rows',
          data: { rows: [{ key: 'proposal-one', label: 'Exact Host proposal' }], validUntil: Date.now() + 15 },
        });
      }
      return jsonResponse({
        ok: true,
        render: 'rows',
        data: {
          rows: [
            {
              key: prepared ? 'authorization-required-again' : 'authorization-required',
              label: 'Authorization required',
              actions: [{ action: 'prepare', input: { intent: 'prepare' } }],
            },
          ],
        },
      });
    });

    await render(<ActionRenderer target={target} operation={stagedOperation} />);
    await click(byTestId('chatgpt-pro-row-authorization-required-action-prepare'));
    expect(byTestId('chatgpt-pro-row-proposal-one')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
    expect(byTestId('chatgpt-pro-row-proposal-one')).toBeNull();
    expect(byTestId('chatgpt-pro-row-authorization-required-again')).not.toBeNull();
    expect(sent('list')).toHaveLength(2);
  });

  it('bounds external observation, pauses while hidden, resumes once visible, and stops on unmount', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T00:00:00.000Z'));
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return jsonResponse({
        ok: true,
        render: 'rows',
        data: {
          rows: [{ key: 'waiting-subscription', label: 'Waiting for ChatGPT' }],
          pollUntil: Date.now() + 60_000,
        },
      });
    });

    try {
      act(() => root.render(<ActionRenderer target={target} operation={operation} />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sent('list')).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(sent('list')).toHaveLength(2);

      visibility = 'hidden';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(sent('list')).toHaveLength(2);

      visibility = 'visible';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sent('list')).toHaveLength(3);

      act(() => root.unmount());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(sent('list')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    }
  });

  it('aborts and invalidates an in-flight observation when the page becomes hidden', async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const pending = deferred<Response>();
    let callsCount = 0;
    let observationSignal: AbortSignal | undefined;
    mockApiFetch.mockImplementation(async (_url, init) => {
      callsCount += 1;
      if (callsCount === 1) {
        return jsonResponse({
          ok: true,
          render: 'rows',
          data: { rows: [{ key: 'waiting', label: 'Waiting' }], pollUntil: Date.now() + 60_000 },
        });
      }
      observationSignal = init?.signal as AbortSignal;
      return pending.promise;
    });

    try {
      act(() => root.render(<ActionRenderer target={target} operation={operation} />));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await act(async () => vi.advanceTimersByTimeAsync(2500));
      expect(callsCount).toBe(2);

      visibility = 'hidden';
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () =>
        pending.resolve(
          jsonResponse({ ok: true, render: 'rows', data: { rows: [{ key: 'ready', label: 'Ready after hide' }] } }),
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));

      expect(observationSignal?.aborted).toBe(true);
      expect(container.textContent).not.toContain('Ready after hide');
    } finally {
      vi.useRealTimers();
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
    }
  });

  it('shows when bounded observation expires and only an owner refresh starts a new window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T00:00:00.000Z'));
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return jsonResponse({
        ok: true,
        render: 'rows',
        data: {
          rows: [{ key: 'waiting-subscription', label: 'Waiting for ChatGPT' }],
          pollUntil: Date.now() + 15,
        },
      });
    });

    try {
      act(() =>
        root.render(
          <ActionRenderer
            target={target}
            operation={{ ...operation, actions: [{ ...operation.actions[0]!, render: 'polling' }] }}
          />,
        ),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(byTestId('chatgpt-pro-rows-refresh')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(byTestId('chatgpt-pro-rows-observation-paused')?.textContent).toContain('自动检查已到本次等待上限');
      expect(byTestId('chatgpt-pro-rows-refresh')?.textContent).toBe('重新检查');
      const callsAtDeadline = sent('list').length;

      act(() => (byTestId('chatgpt-pro-rows-refresh') as HTMLButtonElement).click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sent('list')).toHaveLength(callsAtDeadline + 1);
      expect(byTestId('chatgpt-pro-rows-observation-paused')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the empty text when there are no rows', async () => {
    serve([], { empty: 'No authorized conversations' });
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(byTestId('chatgpt-pro-rows-empty')?.textContent).toBe('No authorized conversations');
  });

  it.each([
    'immediate',
    'after detail fetch',
  ] as const)('retains the row diagnostic across %s operation-state refresh, then clears it after a failure', async (timing) => {
    let failed = false;
    let updatedAt = 1;
    const diagnostic = 'The selected conversation page is ready; no message sent.';
    const op: PlatformOperationStatus = { ...operation, rowActions: [{ id: 'check-page', label: 'Check page' }] };
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return String(url).endsWith('/list')
        ? jsonResponse({
            ok: true,
            render: 'rows',
            data: { rows: [{ ...row('a1'), actions: [{ action: 'check-page', input: { conversationId: 'a1' } }] }] },
          })
        : jsonResponse(
            failed ? { ok: false, label: 'Connection lost' } : { ok: true, render: 'status', label: diagnostic },
          );
    });
    function RefreshedDetail() {
      const [state, setState] = React.useState({ currentAction: 'list', updatedAt });
      const onStatusChange = () => {
        const refresh = () => setState({ currentAction: 'check-page', updatedAt: ++updatedAt });
        if (timing === 'immediate') refresh();
        else void Promise.resolve().then(refresh);
      };
      return <ActionRenderer target={target} operation={{ ...op, ...state }} onStatusChange={onStatusChange} />;
    }
    await render(<RefreshedDetail />);
    const retainedRow = byTestId('chatgpt-pro-row-a1');
    await click(byTestId('chatgpt-pro-row-a1-action-check-page'));
    expect(updatedAt).toBe(2);
    expect(container.querySelector('output')?.textContent).toBe(diagnostic);
    expect(retainedRow?.querySelector('output')?.textContent).toBe(diagnostic);
    expect(retainedRow?.querySelector('output')?.closest('li')).toBe(retainedRow);
    expect(byTestId('chatgpt-pro-row-a1')).toBe(retainedRow);
    expect(sent('list')).toHaveLength(1);
    failed = true;
    await click(byTestId('chatgpt-pro-row-a1-action-check-page'));
    expect(container.querySelector('output')).toBeNull();
    expect(byTestId('chatgpt-pro-row-a1-error')?.textContent).toBe('Connection lost');
  });

  it.each([
    'Title refresh unavailable: HOST_UNAVAILABLE',
    'Updated 2 titles',
  ])('keeps button feedback after next:list: %s, and clears it on the next failed action', async (label) => {
    let failed = false;
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      return String(url).endsWith('/list')
        ? jsonResponse({ ok: true, render: 'rows', data: { rows: [row('a1')] } })
        : jsonResponse(failed ? { ok: false, label: 'Connection lost' } : { ok: true, render: 'status', label });
    });
    const op = {
      ...operation,
      actions: [
        operation.actions[0],
        { id: 'refresh', label: 'Refresh titles', render: 'button' as const, next: 'list' },
      ],
    };
    await render(<ActionRenderer target={target} operation={op} />);
    await click(byTestId('chatgpt-pro-action-refresh'));
    expect(sent('list')).toHaveLength(2);
    expect(container.querySelector('output')?.textContent).toBe(label);
    expect(byTestId('chatgpt-pro-row-a1')).not.toBeNull();
    failed = true;
    await click(byTestId('chatgpt-pro-action-refresh'));
    expect(container.querySelector('output')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Connection lost');
  });

  it.each(['list', 'revoke'])('clears button feedback when the owner starts %s, before its failure', async (action) => {
    let failNext = false;
    let finish: (value: Response) => void = () => {};
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      if (failNext)
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return String(url).endsWith('/list')
        ? jsonResponse({ ok: true, render: 'rows', data: { rows: [row('a1')] } })
        : jsonResponse({ ok: true, render: 'status', label: 'Updated 2 titles' });
    });
    const op = {
      ...operation,
      actions: [
        operation.actions[0],
        { id: 'refresh', label: 'Refresh titles', render: 'button' as const, next: 'list' },
      ],
    };
    await render(<ActionRenderer target={target} operation={op} />);
    await click(byTestId('chatgpt-pro-action-refresh'));
    expect(container.querySelector('output')?.textContent).toBe('Updated 2 titles');
    failNext = true;
    if (action === 'revoke') {
      await click(revokeButton('a1'));
      await click(dialogButton('取消'));
      expect(sent('revoke')).toHaveLength(0);
      expect(container.querySelector('output')?.textContent).toBe('Updated 2 titles');
      await click(revokeButton('a1'));
      await click(dialogButton('确认'));
    } else {
      await click(byTestId('chatgpt-pro-rows-refresh'));
    }
    expect(container.querySelector('output')).toBeNull();
    await act(async () => finish(jsonResponse({ ok: false, label: 'Network error' })));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Network error');
    expect(container.querySelector('output')).toBeNull();
    expect(byTestId('chatgpt-pro-row-a1')).not.toBeNull();
  });

  it('says why the list is unavailable', async () => {
    serve([], { listError: 'Plugin returned an invalid result' });
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Plugin returned an invalid result');
    expect(byTestId('chatgpt-pro-rows-empty')).toBeNull();
  });

  it('asks before revoking; cancel sends nothing and a returned rows receipt replaces the list', async () => {
    serve([row('a1'), row('b2')]);
    await render(<ActionRenderer target={target} operation={operation} />);

    await click(revokeButton('a1'));
    expect(container.textContent).toContain(declaredWording);
    await click(dialogButton('取消'));
    expect(sent('revoke')).toEqual([]);

    await click(revokeButton('a1'));
    await click(dialogButton('确认'));

    expect(sent('revoke')).toEqual([
      { url: '/api/plugins/chatgpt-pro/actions/authorization/revoke', body: '{"conversationId":"a1"}' },
    ]);
    const revokeCall = mockApiFetch.mock.calls.find(([url]) => String(url).endsWith('/revoke'));
    expect(new Headers(revokeCall?.[1]?.headers).get('x-cat-cafe-owner-confirmed')).toBe('true');
    const listCall = mockApiFetch.mock.calls.find(([url]) => String(url).endsWith('/list'));
    expect(new Headers(listCall?.[1]?.headers).has('x-cat-cafe-owner-confirmed')).toBe(false);
    expect(sent('list')).toHaveLength(1);
    expect(byTestId('chatgpt-pro-row-a1')).toBeNull();
    expect(byTestId('chatgpt-pro-row-b2')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe('1 authorized conversation(s)');
    expect(container.querySelector('output')?.closest('li')).toBeNull();
  });

  it("uses a row's own wording in place of the declared one", async () => {
    serve([row('a1', 'Revoke the conversation about taxes?')]);
    await render(<ActionRenderer target={target} operation={operation} />);

    await click(revokeButton('a1'));

    expect(container.textContent).toContain('Revoke the conversation about taxes?');
    expect(container.textContent).not.toContain(declaredWording);
  });

  it('asks when only the row declares a confirmation, and not when neither does', async () => {
    serve([row('a1', 'Revoke a1?'), row('b2')]);
    const undeclared = { ...operation, rowActions: [{ id: 'revoke', label: 'Revoke', next: 'list' }] };
    await render(<ActionRenderer target={target} operation={undeclared} />);

    await click(revokeButton('b2'));
    expect(sent('revoke').map(({ body }) => body)).toEqual(['{"conversationId":"b2"}']);

    await click(revokeButton('a1'));
    expect(container.textContent).toContain('Revoke a1?');
    expect(sent('revoke')).toHaveLength(1);
    await click(dialogButton('确认'));
    expect(sent('revoke').map(({ body }) => body)).toEqual(['{"conversationId":"b2"}', '{"conversationId":"a1"}']);
  });

  it('disables only the row whose action is running', async () => {
    let release: (value?: unknown) => void = () => {};
    serve([row('a1'), row('b2')], { revokeGate: new Promise((resolve) => (release = resolve)) });
    await render(<ActionRenderer target={target} operation={operation} />);

    await click(revokeButton('a1'));
    await click(dialogButton('确认'));
    expect(revokeButton('a1')?.disabled).toBe(true);
    expect(revokeButton('b2')?.disabled).toBe(false);

    await act(async () => release());
    await settle();
    expect(byTestId('chatgpt-pro-row-a1')).toBeNull();
    expect(revokeButton('b2')?.disabled).toBe(false);
  });

  it('lets concurrent row actions settle independently without leaving an older row busy', async () => {
    const first = deferred<Response>();
    const concurrentOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'advance', label: 'Advance' }],
    };
    const concurrentRows = ['a1', 'b2'].map((key) => ({
      key,
      label: `Stage ${key}`,
      actions: [{ action: 'advance', input: { key } }],
    }));
    mockApiFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/list'))
        return jsonResponse({ ok: true, render: 'rows', data: { rows: concurrentRows } });
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      return key === 'a1' ? first.promise : jsonResponse({ ok: true, render: 'rows', data: { rows: concurrentRows } });
    });
    await render(<ActionRenderer target={target} operation={concurrentOperation} />);

    await click(byTestId('chatgpt-pro-row-a1-action-advance'));
    expect((byTestId('chatgpt-pro-row-a1-action-advance') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('chatgpt-pro-row-b2-action-advance') as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId('chatgpt-pro-row-b2-action-advance'));
    await act(async () => first.resolve(jsonResponse({ ok: true, render: 'rows', data: { rows: concurrentRows } })));
    await settle();

    expect((byTestId('chatgpt-pro-row-a1-action-advance') as HTMLButtonElement).disabled).toBe(false);
    expect((byTestId('chatgpt-pro-row-b2-action-advance') as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not reconcile over the latest proposal after concurrent actions drain', async () => {
    const first = deferred<Response>();
    let listCalls = 0;
    const concurrentOperation: PlatformOperationStatus = {
      ...operation,
      rowActions: [{ id: 'advance', label: 'Advance' }],
    };
    const concurrentRows = ['a1', 'b2'].map((key) => ({
      key,
      label: `Stage ${key}`,
      actions: [{ action: 'advance', input: { key } }],
    }));
    mockApiFetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/list')) {
        listCalls += 1;
        return jsonResponse({ ok: true, render: 'rows', data: { rows: concurrentRows } });
      }
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      if (key === 'a1') return first.promise;
      return jsonResponse({
        ok: true,
        render: 'rows',
        data: {
          rows: [{ key: 'proposal', label: 'Latest canonical proposal' }],
          validUntil: Date.now() + 60_000,
        },
      });
    });
    await render(<ActionRenderer target={target} operation={concurrentOperation} />);

    await click(byTestId('chatgpt-pro-row-a1-action-advance'));
    await click(byTestId('chatgpt-pro-row-b2-action-advance'));
    expect(byTestId('chatgpt-pro-row-proposal')).not.toBeNull();
    await act(async () => first.resolve(jsonResponse({ ok: true, render: 'rows', data: { rows: concurrentRows } })));
    await settle();

    expect(byTestId('chatgpt-pro-row-proposal')).not.toBeNull();
    expect(listCalls).toBe(1);
  });

  it('keeps a failure on the row it happened to', async () => {
    serve([row('a1'), row('b2')], { revokeError: 'Action failed: Conversation not found' });
    await render(<ActionRenderer target={target} operation={operation} />);

    await click(revokeButton('a1'));
    await click(dialogButton('确认'));

    expect(byTestId('chatgpt-pro-row-a1-error')?.textContent).toBe('Action failed: Conversation not found');
    expect(byTestId('chatgpt-pro-row-b2-error')).toBeNull();
    expect(revokeButton('a1')?.disabled).toBe(false);
  });

  it('fails closed when no confirmation dialog is available', async () => {
    serve([row('a1')]);
    await render(<ActionRenderer target={target} operation={operation} />, { withConfirm: false });

    await click(revokeButton('a1'));

    expect(sent('revoke')).toEqual([]);
  });

  it('asks before an operation-wide button, then refreshes the list', async () => {
    serve([row('a1')]);
    await render(<ActionRenderer target={target} operation={operation} />);

    await click(byTestId('chatgpt-pro-action-reset'));
    expect(container.textContent).toContain('Forget every conversation?');
    await click(dialogButton('取消'));
    expect(sent('reset')).toEqual([]);

    await click(byTestId('chatgpt-pro-action-reset'));
    await click(dialogButton('确认'));
    expect(sent('reset')).toHaveLength(1);
    expect(byTestId('chatgpt-pro-rows-empty')).not.toBeNull();
  });

  it('never lists by itself when the list action asks for confirmation', async () => {
    serve([row('a1'), row('b2')]);
    const guarded: PlatformOperationStatus = {
      ...operation,
      actions: [
        { id: 'list', label: 'Load', render: 'button', resultRender: 'rows', confirm: 'Load the conversation list?' },
      ],
    };
    await render(<ActionRenderer target={target} operation={guarded} />);
    expect(sent('list')).toEqual([]);
    expect(byTestId('chatgpt-pro-rows-awaiting-owner')?.textContent).toContain('“Load” asks for your confirmation');

    await click(byTestId('chatgpt-pro-rows-refresh'));
    expect(container.textContent).toContain('Load the conversation list?');
    await click(dialogButton('取消'));
    expect(sent('list')).toEqual([]);

    await click(byTestId('chatgpt-pro-rows-refresh'));
    await click(dialogButton('确认'));
    expect(sent('list')).toHaveLength(1);
    expect(byTestId('chatgpt-pro-row-a1')).not.toBeNull();
    expect(byTestId('chatgpt-pro-rows-awaiting-owner')).toBeNull();

    await click(revokeButton('a1'));
    await click(dialogButton('确认'));
    expect(sent('revoke')).toHaveLength(1);
    expect(sent('list')).toHaveLength(1);
    expect(byTestId('chatgpt-pro-row-a1')).toBeNull();
    expect(byTestId('chatgpt-pro-row-b2')).not.toBeNull();
    expect(byTestId('chatgpt-pro-rows-awaiting-owner')).toBeNull();
  });

  it('drives the alpha.9 owner journey from its packed manifest without preparing or pairing on mount', async () => {
    const manifest = JSON.parse(
      readFileSync('../api/src/domains/plugin/bundled-packages/chatgpt-dot/0.2.0-alpha.10/manifest.json', 'utf8'),
    ) as {
      pluginId: string;
      configuration: Array<{
        key: string;
        label: string;
        actions: Array<{
          id: string;
          label: string;
          render: string;
          resultRender?: string;
          confirm?: string;
          next?: string;
        }>;
      }>;
    };
    const field = manifest.configuration.find((candidate) => candidate.key === 'connection');
    if (!field) throw new Error('alpha.9 connection operation is missing');
    const dotOperation = {
      name: field.key,
      label: field.label,
      actions: field.actions.filter((action) => action.render !== 'row'),
      rowActions: field.actions.filter((action) => action.render === 'row'),
    } as unknown as PlatformOperationStatus;
    const dotTarget = { kind: 'plugin', id: manifest.pluginId } as const;
    const authorizationRow = {
      key: 'authorization-required',
      label: '需要确认共享连接范围',
      detail: 'Dot 尚未获准使用现有猫咖云端连接。',
      actions: [{ action: 'prepare-shared', label: '准备授权', input: { journey: 'prepare-shared' } }],
    };
    const proposalRow = {
      key: 'proposal-one',
      label: '连接到现有猫咖云端连接',
      detail: '工具（1）：dot_read；事件（1）：dot.changed',
      actions: [
        {
          action: 'bind-shared',
          label: '连接现有猫咖云端连接',
          confirm: '确认连接？',
          input: { proposalRef: 'proposal-one' },
        },
      ],
    };
    const pairingRow = {
      key: 'pairing-not-started',
      label: '共享入口已获准',
      detail: '下一步生成一次 Dot 配对说明。',
      actions: [{ action: 'begin-pairing', label: '生成配对说明', input: { journey: 'begin-pairing' } }],
    };
    const waitingRow = {
      key: 'waiting-subscription',
      label: '等待 ChatGPT 订阅',
      detail: '在已有猫咖 personal plugin 中 Refresh 后订阅 dot.summoned。',
      actions: [{ action: 'show-instructions', label: '复制配对说明', input: { journey: 'show-instructions' } }],
    };
    const instructions = 'OPEN EXISTING PERSONAL PLUGIN\nREFRESH\nSUBSCRIBE dot.summoned pairing_code=secret';
    const resultByAction: Record<string, unknown> = {
      status: { ok: true, render: 'rows', data: { rows: [authorizationRow] } },
      'prepare-shared': {
        ok: true,
        render: 'rows',
        data: { rows: [proposalRow], validUntil: Date.now() + 60_000 },
      },
      'bind-shared': { ok: true, render: 'rows', data: { rows: [pairingRow] } },
      'begin-pairing': {
        ok: true,
        render: 'rows',
        data: { rows: [waitingRow], pollUntil: Date.now() + 60_000 },
      },
      'show-instructions': { ok: true, render: 'text', data: instructions },
    };
    mockApiFetch.mockImplementation(async (url) => {
      calls.push({ url: String(url) });
      const action = String(url).split('/').at(-1);
      const body = action ? resultByAction[action] : undefined;
      if (!body) throw new Error(`unexpected Dot action: ${action ?? 'missing'}`);
      return jsonResponse(body);
    });

    await render(<ActionRenderer target={dotTarget} operation={dotOperation} configured />);

    expect(calls.map(({ url }) => url)).toEqual([`/api/plugins/${manifest.pluginId}/actions/connection/status`]);
    expect(byTestId(`${manifest.pluginId}-row-authorization-required`)).not.toBeNull();
    expect(calls.some(({ url }) => url.endsWith('/prepare-shared') || url.endsWith('/begin-pairing'))).toBe(false);

    await click(byTestId(`${manifest.pluginId}-row-authorization-required-action-prepare-shared`));
    expect(byTestId(`${manifest.pluginId}-row-proposal-one-action-bind-shared`)).not.toBeNull();

    await click(byTestId(`${manifest.pluginId}-row-proposal-one-action-bind-shared`));
    await click(dialogButton('确认'));
    expect(byTestId(`${manifest.pluginId}-row-pairing-not-started`)).not.toBeNull();

    await click(byTestId(`${manifest.pluginId}-row-pairing-not-started-action-begin-pairing`));
    await click(dialogButton('确认'));
    expect(byTestId(`${manifest.pluginId}-row-waiting-subscription`)).not.toBeNull();

    await click(byTestId(`${manifest.pluginId}-row-waiting-subscription-action-show-instructions`));
    expect(container.textContent).toContain(instructions);
    expect(dialogButton('复制')).not.toBeNull();
  });

  it('does not list on an owner refresh without a confirmation dialog', async () => {
    serve([row('a1')]);
    const guarded: PlatformOperationStatus = {
      ...operation,
      actions: [{ id: 'list', label: 'Load', render: 'button', resultRender: 'rows', confirm: 'Load?' }],
    };
    await render(<ActionRenderer target={target} operation={guarded} />, { withConfirm: false });

    await click(byTestId('chatgpt-pro-rows-refresh'));

    expect(sent('list')).toEqual([]);
  });

  it('retains a URL on its row and clears it when the owner target changes or the next action fails', async () => {
    let fail = false;
    const op: PlatformOperationStatus = { ...operation, rowActions: [{ id: 'watch', label: '观看副本' }] };
    mockApiFetch.mockImplementation(async (url) =>
      String(url).endsWith('/list')
        ? jsonResponse({
            ok: true,
            render: 'rows',
            data: { rows: [{ ...row('a1'), actions: [{ action: 'watch', input: { view: 'current' } }] }] },
          })
        : fail
          ? jsonResponse({ error: 'Viewer unavailable' }, 502)
          : jsonResponse({
              ok: true,
              render: 'url',
              data: { url: 'http://127.0.0.1:5189/watch#observer=fixture' },
              label: '观看本场副本',
            }),
    );
    await render(<ActionRenderer target={target} operation={op} />);
    expect(container.querySelector('a')).toBeNull();
    await click(byTestId('chatgpt-pro-row-a1-action-watch'));
    const link = byTestId('chatgpt-pro-row-a1')?.querySelector('a');
    expect(link?.textContent).toBe('观看本场副本');
    expect(link?.getAttribute('href')).toBe('http://127.0.0.1:5189/watch#observer=fixture');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
    await render(<ActionRenderer target={{ kind: 'plugin', id: 'another-plugin' }} operation={op} />);
    expect(container.querySelector('a')).toBeNull();
    await render(<ActionRenderer target={target} operation={op} />);
    fail = true;
    await click(byTestId('chatgpt-pro-row-a1-action-watch'));
    expect(container.querySelector('a')).toBeNull();
    expect(byTestId('chatgpt-pro-row-a1-error')?.textContent).toBe('Viewer unavailable');
  });

  it('treats keys named after Object.prototype members as ordinary row keys', async () => {
    serve([row('toString'), row('__proto__')], { revokeError: 'Conversation not found' });
    await render(<ActionRenderer target={target} operation={operation} />);
    expect(byTestId('chatgpt-pro-row-toString')).not.toBeNull();
    expect(byTestId('chatgpt-pro-row-__proto__')).not.toBeNull();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);

    await click(revokeButton('__proto__'));
    await click(dialogButton('确认'));

    expect(byTestId('chatgpt-pro-row-__proto__-error')?.textContent).toBe('Conversation not found');
    expect(byTestId('chatgpt-pro-row-toString-error')).toBeNull();
  });
});
