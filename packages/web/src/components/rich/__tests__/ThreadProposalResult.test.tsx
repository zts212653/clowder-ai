import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { ThreadProposalResult } from '../ThreadProposalResult';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellLanguage('zh');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  [false, true],
  [true, false],
  [true, true],
])('keeps lazy Open visible without href and checks authority before/after its read (%s→%s)', async (initial, completion) => {
  let grant = initial;
  const resolve = vi.fn(async () => {
    grant = completion;
    return 'created-child';
  });
  const navigate = vi.spyOn(window.history, 'pushState');
  await act(async () =>
    root.render(
      <ThreadProposalResult status="approved" effectUnknown authorizeOpen={() => grant} resolveThreadId={resolve}>
        <p>Original proposal</p>
      </ThreadProposalResult>,
    ),
  );
  const open = host.querySelector<HTMLButtonElement>('[data-testid="proposal-result-open"]');
  expect(open).not.toBeNull();
  expect(host.querySelector('a[href]')).toBeNull();
  expect(resolve).not.toHaveBeenCalled();
  open?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  open?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => open?.click());
  expect(resolve).toHaveBeenCalledTimes(initial ? 1 : 0);
  if (initial && completion) expect(navigate).toHaveBeenCalledExactlyOnceWith({}, '', '/thread/created-child');
  else expect(navigate).not.toHaveBeenCalled();
});

it('keeps a failed effect honest and retries the existing guarded result read', async () => {
  const resolve = vi.fn(async () => null);
  const navigate = vi.spyOn(window.history, 'pushState');
  await act(async () =>
    root.render(
      <ThreadProposalResult
        status="approved"
        effectFailed
        effectUnknown
        authorizeOpen={() => true}
        resolveThreadId={resolve}
      >
        <p>Original proposal</p>
      </ThreadProposalResult>,
    ),
  );
  expect(host.textContent).toContain('对话没开成');
  expect(host.textContent).not.toContain('对话已开');
  const retry = host.querySelector<HTMLButtonElement>('[data-testid="proposal-result-open"]');
  expect(retry?.textContent).toBe('再试一次');
  await act(async () => retry?.click());
  expect(resolve).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
});
