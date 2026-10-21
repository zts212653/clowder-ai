// @vitest-environment jsdom
import type { ArtifactReview, ArtifactReviewRound } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReviewResponseJudgments } from '../ReviewResponseJudgments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('shows original opinion and unmapped evidence, and only explicit Human clicks judge the exact result', async () => {
  const original = { id: 'old', body: 'Original v1 opinion', state: 'open', replies: [] };
  const round = {
    number: 3,
    asset: { ownerRevision: 4 },
    responseSource: { round: 1 },
    responses: [{ annotationId: 'old', disposition: 'addressed', explanation: 'Changed in v4' }],
  } as ArtifactReviewRound;
  const review = {
    rounds: [{ number: 1, asset: { ownerRevision: 1 }, annotations: [original] }, round],
  } as ArtifactReview;
  const judge = vi.fn(async () => true),
    locate = vi.fn();
  const node = document.createElement('div'),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(<ReviewResponseJudgments review={review} round={round} canJudge onJudge={judge} onSource={locate} />),
    );
    expect(judge).not.toHaveBeenCalled();
    expect(node.textContent).toContain('Original v1 opinion');
    expect(node.textContent).toContain('新版位置未定位');
    const button = [...node.querySelectorAll('button')].find((item) => item.textContent === '还不对');
    await act(async () => button?.click());
    expect(judge).toHaveBeenCalledWith(
      { kind: 'judge_response', sourceRound: 1, annotationId: 'old', resultOwnerRevision: 4, outcome: 'reopened' },
      3,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
