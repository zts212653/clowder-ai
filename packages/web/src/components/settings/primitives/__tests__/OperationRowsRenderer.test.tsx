/**
 * F202 W2-3 h1 — the web side of per-row actions: an operation whose list action returns `rows`
 * renders a row list; a row action sends that row's input; a declared confirmation is asked first
 * in the shared Console dialog (and fails closed without one); a row is disabled while its action
 * runs, and a failure stays on its row.
 */
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
      return jsonResponse({ ok: true, render: 'status', data: { status: 'ok' }, currentAction: 'list', advance: true });
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

  it('lists the rows on mount, with their detail and the actions the Host validated', async () => {
    serve([row('a1'), row('b2')]);
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(calls.map(({ url }) => url)).toEqual(['/api/plugins/chatgpt-pro/actions/authorization/list']);
    expect(byTestId('chatgpt-pro-row-a1')?.textContent).toContain('Conversation a1');
    expect(byTestId('chatgpt-pro-row-a1')?.textContent).toContain('https://chatgpt.com/c/a1');
    expect(revokeButton('b2')?.textContent).toBe('Revoke');
  });

  it('shows the empty text when there are no rows', async () => {
    serve([], { empty: 'No authorized conversations' });
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(byTestId('chatgpt-pro-rows-empty')?.textContent).toBe('No authorized conversations');
  });

  it('says why the list is unavailable', async () => {
    serve([], { listError: 'Plugin returned an invalid result' });
    await render(<ActionRenderer target={target} operation={operation} />);

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Plugin returned an invalid result');
    expect(byTestId('chatgpt-pro-rows-empty')).toBeNull();
  });

  it('asks before revoking; cancel sends nothing, confirm sends the row input and refreshes the list', async () => {
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
    expect(sent('list')).toHaveLength(2);
    expect(byTestId('chatgpt-pro-row-a1')).toBeNull();
    expect(byTestId('chatgpt-pro-row-b2')).not.toBeNull();
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
    expect(byTestId('chatgpt-pro-rows-awaiting-owner')).not.toBeNull();
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
