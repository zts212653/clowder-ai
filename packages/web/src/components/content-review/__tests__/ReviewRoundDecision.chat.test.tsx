import type { ArtifactReviewRound } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ReviewRoundDecision } from '../ReviewRoundDecision';
import { compareAsset } from './media-compare.fixture';

let root: Root, container: HTMLDivElement;
const round: ArtifactReviewRound = {
  number: 2,
  asset: compareAsset(2),
  openedAt: '2026-10-13T23:00:00Z',
  state: 'awaiting_human',
  annotations: [],
  responses: [],
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  writeShellPresentation('v2');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('approves the real round without another input or a fabricated human reason', async () => {
  const decide = vi.fn().mockResolvedValue(true);
  await act(async () =>
    root.render(
      <ReviewRoundDecision
        round={round}
        ownerUserId="operator"
        canWrite
        saving={false}
        draftKey="decision"
        act={decide}
        compact
      />,
    ),
  );
  expect(container.querySelector('textarea')).toBeNull();
  const approve = [...container.querySelectorAll('button')].find((b) => b.textContent === '通过此版本');
  expect(approve?.disabled).toBe(false);
  await act(async () => approve?.click());
  expect(decide).toHaveBeenCalledWith({ kind: 'decide', outcome: 'approved', explanation: '' }, 2);
});
it('does not offer approval of a historical or nonwritable round', async () => {
  const decide = vi.fn();
  await act(async () =>
    root.render(
      <ReviewRoundDecision
        round={round}
        ownerUserId="operator"
        canWrite={false}
        saving={false}
        draftKey="decision"
        act={decide}
        compact
      />,
    ),
  );
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === '通过此版本')).toBe(false);
  expect(decide).not.toHaveBeenCalled();
});

it('keeps the designed request-changes action in the original Chat instead of submitting a decision', async () => {
  const discuss = vi.fn(() => true),
    decide = vi.fn();
  await act(async () =>
    root.render(
      <ReviewRoundDecision
        round={round}
        ownerUserId="operator"
        canWrite
        saving={false}
        draftKey="decision"
        act={decide}
        onDiscuss={discuss}
        compact
      />,
    ),
  );
  const request = [...container.querySelectorAll('button')].find((button) => button.textContent === '要求修改');
  expect(request).toBeDefined();
  await act(async () => request?.click());
  expect(discuss).toHaveBeenCalledExactlyOnceWith();
  expect(decide).not.toHaveBeenCalled();
  expect(container.querySelector('textarea')).toBeNull();
});

it.each([
  false,
  true,
])('keeps the previous decision draft until its explicit Chat handoff is accepted: %s', async (accepted) => {
  const words = '原来写过的两行\n这一行也不能丢';
  localStorage.setItem('decision', JSON.stringify({ body: words, anchor: null }));
  const discuss = vi.fn(() => accepted);
  await act(async () =>
    root.render(
      <ReviewRoundDecision
        round={round}
        ownerUserId="operator"
        canWrite
        saving={false}
        draftKey="decision"
        act={vi.fn()}
        onDiscuss={discuss}
        compact
      />,
    ),
  );
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain(words);
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '放到聊天')?.click());
  expect(discuss).toHaveBeenCalledExactlyOnceWith(words);
  expect(localStorage.getItem('decision') === null).toBe(accepted);
});
