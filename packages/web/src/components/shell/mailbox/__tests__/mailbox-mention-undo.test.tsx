import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailboxMentionUndo } from '../MailboxMentionUndo';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
let root: Root;
let host: HTMLDivElement;
let owner: string | undefined;
let undone: boolean;
let finishUndo: ((value: Response) => void) | undefined;
const render = () => act(async () => root.render(<MailboxMentionUndo owner={owner} />));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  owner = 'owner-1';
  undone = false;
  finishUndo = undefined;
  api.mockImplementation(async (path: string) => {
    if (path.endsWith('/last-handling'))
      return Response.json({
        ownerUserId: owner,
        receipt: undone ? null : { undoId: 'batch-559', handled: 559, remaining: 558 },
      });
    if (path.endsWith('/undo')) {
      undone = true;
      return new Promise<Response>((resolve) => {
        finishUndo = resolve;
      });
    }
    throw new Error(path);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  api.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const beginUndo = () =>
  act(async () => host.querySelector<HTMLButtonElement>('[data-testid="mailbox-mentions-undo"]')?.click());
const completeUndo = () => act(async () => finishUndo?.(Response.json({ restored: 558 })));
it('keeps a successful undo notice through the invalidation refresh, hidden until the same owner is reverified', async () => {
  await render();
  const invalidate = () => {
    owner = undefined;
    root.render(<MailboxMentionUndo owner={owner} />);
  };
  window.addEventListener('cat-cafe:user-mention-updated', invalidate);
  try {
    await beginUndo();
    await completeUndo();
    expect(owner).toBeUndefined();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('[data-testid="mailbox-mentions-undo"]')).toBeNull();
    owner = 'owner-1';
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已撤销 558 件');
    expect(host.querySelector('[data-testid="mailbox-mentions-undo"]')).toBeNull();
  } finally {
    window.removeEventListener('cat-cafe:user-mention-updated', invalidate);
  }
});
it('clears the old owner notice on an actual owner change', async () => {
  await render();
  await beginUndo();
  await completeUndo();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('已撤销 558 件');
  owner = 'owner-2';
  await render();
  expect(host.querySelector('[role="status"]')).toBeNull();
  owner = 'owner-1';
  await render();
  expect(host.querySelector('[role="status"]')).toBeNull();
});
it.each([false, true])('does not install a late undo result across an owner switch (returned=%s)', async (returned) => {
  await render();
  await beginUndo();
  owner = 'owner-2';
  await render();
  if (returned) {
    owner = 'owner-1';
    await render();
  }
  await completeUndo();
  expect(host.querySelector('[role="status"]')).toBeNull();
  owner = 'owner-1';
  await render();
  expect(host.querySelector('[role="status"]')).toBeNull();
});
