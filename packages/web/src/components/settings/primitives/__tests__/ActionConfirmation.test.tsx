/**
 * F202 W2-3 h1 — an action whose manifest declares `confirm` is confirmed by the owner in the shared
 * Console dialog before every invocation, whichever renderer shows it: the sequenced renderer's
 * buttons and disconnect, and the live-status renderer's revoke button (the rows renderer is
 * covered alongside its rows). Cancelling sends nothing, and the Host never runs such an action on
 * its own: not a polling step, not a live status check.
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
const { LiveStatusActionRenderer } = await import('../LiveStatusActionRenderer');
const { ConfirmProvider } = await import('../../../useConfirm');

const target = { kind: 'plugin', id: 'reader' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('declared action confirmation (F202 W2-3 h1)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: string[];

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

  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render(operation: PlatformOperationStatus, { configured }: { configured?: boolean } = {}) {
    act(() =>
      root.render(
        <ConfirmProvider>
          <ActionRenderer target={target} operation={operation} configured={configured} />
        </ConfirmProvider>,
      ),
    );
    await settle();
  }

  function answerEverything() {
    mockApiFetch.mockImplementation(async (url) => {
      calls.push(String(url));
      return jsonResponse({ ok: true, render: 'status', data: { status: 'ok' } });
    });
  }

  async function click(element: Element | null | undefined) {
    if (!element) throw new Error('missing element');
    await act(async () => {
      (element as HTMLElement).click();
    });
    await settle();
  }

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const dialogButton = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent === text);
  const sent = (action: string) => calls.filter((url) => url.endsWith(`/${action}`));

  it('asks before a sequenced button action', async () => {
    mockApiFetch.mockImplementation(async (url) => {
      calls.push(String(url));
      return jsonResponse({ ok: true, render: 'status', data: 'Wiped' });
    });
    await render({
      name: 'danger',
      label: 'Danger zone',
      actions: [{ id: 'wipe', label: 'Wipe', render: 'button', confirm: 'Wipe everything?' }],
    });

    await click(byTestId('reader-action-wipe'));
    expect(container.textContent).toContain('Wipe everything?');
    await click(dialogButton('取消'));
    expect(calls).toEqual([]);

    await click(byTestId('reader-action-wipe'));
    await click(dialogButton('确认'));
    expect(calls).toEqual(['/api/plugins/reader/actions/danger/wipe']);
  });

  it('asks before revoking a live authorization, and not before granting it', async () => {
    let armed = false;
    mockApiFetch.mockImplementation(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/arm')) armed = true;
      if (path.endsWith('/disarm')) armed = false;
      return jsonResponse({
        ok: true,
        render: 'status',
        label: armed ? 'Authorized' : 'Not authorized',
        data: {
          armed,
          remainingMs: armed ? 60_000 : 0,
          ...(armed ? { expiresAt: new Date(Date.now() + 60_000).toISOString() } : {}),
        },
      });
    });
    await render({
      name: 'authorization',
      label: 'Authorization',
      actions: [
        { id: 'arm', label: 'Authorize', render: 'button', next: 'disarm' },
        { id: 'status', label: 'Status', render: 'status' },
        { id: 'disarm', label: 'Revoke', render: 'button', next: 'arm', confirm: 'Stop the authorization now?' },
      ],
    });

    await click(byTestId('reader-action-arm'));
    expect(sent('arm')).toHaveLength(1);
    expect(byTestId('reader-disconnect')).not.toBeNull();

    await click(byTestId('reader-disconnect'));
    expect(container.textContent).toContain('Stop the authorization now?');
    await click(dialogButton('取消'));
    expect(sent('disarm')).toEqual([]);

    await click(byTestId('reader-disconnect'));
    await click(dialogButton('确认'));
    expect(sent('disarm')).toHaveLength(1);
    expect(container.textContent).toContain('Not authorized');
  });

  it('asks before disconnecting from the connected banner', async () => {
    answerEverything();
    await render(
      {
        name: 'link',
        label: 'Link',
        actions: [
          { id: 'start', label: 'Connect', render: 'button', next: 'disconnect' },
          {
            id: 'disconnect',
            label: 'Disconnect',
            render: 'button',
            next: 'start',
            confirm: 'Disconnect the account?',
          },
        ],
      },
      { configured: true },
    );

    await click(byTestId('reader-disconnect'));
    expect(container.textContent).toContain('Disconnect the account?');
    await click(dialogButton('取消'));
    expect(calls).toEqual([]);

    await click(byTestId('reader-disconnect'));
    await click(dialogButton('确认'));
    expect(calls).toEqual(['/api/plugins/reader/actions/link/disconnect']);
  });

  it('never polls a step that asks for confirmation', async () => {
    answerEverything();
    await render({
      name: 'pair',
      label: 'Pair',
      currentAction: 'wait',
      actions: [
        { id: 'start', label: 'Start', render: 'button', next: 'wait' },
        { id: 'wait', label: 'Waiting for the phone', render: 'polling', confirm: 'Keep waiting?' },
      ],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(calls).toEqual([]);
    expect(container.textContent).toContain('“Waiting for the phone” asks for your confirmation');
  });

  const guardedStatus: PlatformOperationStatus = {
    name: 'authorization',
    label: 'Authorization',
    actions: [
      { id: 'arm', label: 'Authorize', render: 'button', next: 'disarm' },
      { id: 'status', label: 'Status', render: 'status', confirm: 'Check the authorization?' },
      { id: 'disarm', label: 'Revoke', render: 'button', next: 'arm' },
    ],
  };

  it('keeps a live status that asks for confirmation off the live-status renderer', async () => {
    answerEverything();
    await render(guardedStatus);

    expect(calls).toEqual([]);
    expect((byTestId('reader-action-arm') as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it('never checks such a status in the live-status renderer itself', async () => {
    answerEverything();
    const [arm, status, disarm] = guardedStatus.actions;
    act(() =>
      root.render(
        <ConfirmProvider>
          <LiveStatusActionRenderer
            target={target}
            operation={guardedStatus}
            armAction={arm}
            statusAction={status}
            revokeAction={disarm}
          />
        </ConfirmProvider>,
      ),
    );
    await settle();

    expect(calls).toEqual([]);
  });
});
