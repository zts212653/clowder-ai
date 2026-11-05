// @vitest-environment jsdom

import type { ArtifactReview, ArtifactReviewRound } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ReviewResponseJudgments } from '../ReviewResponseJudgments';
import { ReviewVersionDetails } from '../ReviewVersionDetails';

vi.mock('../ReviewHistory', () => ({ ReviewHistory: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const round: ArtifactReviewRound = {
  number: 3,
  openedAt: '2026-10-20T20:00:00.000Z',
  state: 'draft',
  annotations: [],
  asset: {
    contentRef: 'work:one',
    ownerRevision: 4,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'video/mp4',
    media: {
      kind: 'video',
      width: 100,
      height: 100,
      codedWidth: 100,
      codedHeight: 100,
      rotation: 0,
      pixelAspectRatio: { numerator: 1, denominator: 1 },
      streamId: '0:0x1',
      streamIndex: 0,
      timebase: { numerator: 1, denominator: 1000 },
      startTick: 0,
      durationTicks: 10000,
      containerStartSeconds: 0,
    },
    sourcePublication: { artifactRef: 'v4.mp4', sourceRef: 'workspace:root:v4.mp4', revision: 'v4' },
    ownerReceiptRef: 'receipt-v4',
  },
  responses: [{ annotationId: 'original-v1-opinion', disposition: 'addressed', explanation: 'shortened' }],
  responseSource: { round: 1, ownerRevision: 1, reviewRevision: 3 },
};
describe('an author response keeps the original opinion round', () => {
  it('opens v1 rather than the immediately previous v3 when v4 responds across rounds', async () => {
    const select = vi.fn();
    const node = document.createElement('div');
    const root = createRoot(node);
    await act(async () =>
      root.render(
        <ReviewVersionDetails
          responseControl={
            <ReviewResponseJudgments
              review={
                {
                  rounds: [
                    {
                      number: 1,
                      asset: { ownerRevision: 1 },
                      annotations: [{ id: 'original-v1-opinion', body: 'Original opinion' }],
                    },
                    round,
                  ],
                } as ArtifactReview
              }
              round={round}
              canJudge={false}
              onJudge={async () => false}
              onSource={select}
            />
          }
          reviewId="review"
          revision={4}
          ownerUserId="operator"
          onClose={() => {}}
        />,
      ),
    );
    const button = [...node.querySelectorAll('button')].find((item) => item.textContent === '看原意见所在版本');
    expect(button).toBeDefined();
    expect([...node.querySelectorAll('p')].filter((item) => item.textContent === 'shortened')).toHaveLength(1);
    await act(async () => button?.click());
    await act(async () => root.unmount());
    expect(select).toHaveBeenCalledWith(1);
  });
});
