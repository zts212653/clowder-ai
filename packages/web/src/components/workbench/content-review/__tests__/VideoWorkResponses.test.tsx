// @vitest-environment jsdom
import type { ArtifactReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { VideoWorkResponses } from '../VideoWorkResponses';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), controller: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
vi.mock('@/components/content-review/useArtifactReview', () => ({
  useArtifactReview: (...args: unknown[]) => mock.controller(...args),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('reads the exact reference and original authorized review, locates v4 and opens v1 without guessing a new position', async () => {
  const anchor = { kind: 'video-range', streamId: '0:0x1', startTick: 2000, endTick: 3000 };
  const view = {
    review: {
      reviewId: 'original',
      rounds: [
        {
          number: 1,
          asset: { contentRef: 'work:one', ownerRevision: 1 },
          annotations: [{ id: 'opinion', body: 'Original v1', state: 'open' }],
        },
        {
          number: 2,
          asset: { contentRef: 'work:one', ownerRevision: 4 },
          responseSource: { round: 1 },
          responses: [
            { annotationId: 'opinion', disposition: 'addressed', explanation: 'Shortened', resultAnchor: anchor },
          ],
        },
      ],
    },
    authority: { state: 'current' },
    pendingVersion: false,
  } as unknown as ArtifactReviewView;
  const judge = vi.fn(async () => true),
    version = vi.fn(),
    result = vi.fn();
  mock.controller.mockReturnValue({ view, act: judge });
  mock.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        ownerUserId: 'operator',
        contexts: [
          {
            reviewId: 'original',
            round: 2,
            taskId: 'task',
            threadId: 'production',
            title: 'Review',
            taskTitle: 'Original',
            threadTitle: 'Film',
            targetCatId: 'director',
            targetName: 'Director',
          },
        ],
      }),
    ),
  );
  const node = document.createElement('div'),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <VideoWorkResponses
          reference={{ contentRef: 'work:one', ownerRevision: 4 }}
          onVersion={version}
          onResult={result}
        />,
      ),
    );
    expect(JSON.parse(mock.fetch.mock.calls[0]![1].body)).toEqual({ contentRef: 'work:one', ownerRevision: 4 });
    expect(mock.controller).toHaveBeenCalledWith('original');
    expect(judge).not.toHaveBeenCalled();
    const button = (text: string) => [...node.querySelectorAll('button')].find((item) => item.textContent === text)!;
    await act(async () => button('查看新版位置').click());
    expect(result).toHaveBeenCalledWith(anchor);
    await act(async () => button('看原意见所在版本').click());
    expect(version).toHaveBeenCalledWith(1);
    await act(async () => button('已改').click());
    expect(judge).toHaveBeenCalledWith(
      { kind: 'judge_response', sourceRound: 1, annotationId: 'opinion', resultOwnerRevision: 4, outcome: 'accepted' },
      2,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
