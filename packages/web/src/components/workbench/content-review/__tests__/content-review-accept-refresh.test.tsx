import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentLandingCapabilities, ContentReviewController } from '../content-review-contract';

const captured: { onApplied?: (writtenRevision?: string) => Promise<void> | void } = {};

vi.mock('../WorkspaceContentReviewProjection', () => ({
  WorkspaceContentReviewProjection: (props: { onApplied?: (writtenRevision?: string) => Promise<void> | void }) => {
    captured.onApplied = props.onApplied;
    return null;
  },
}));

const { ContentReviewSurface } = await import('../ContentReviewSurface');

describe('accepting a modification moves the review onto the accepted version', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured.onApplied = undefined;
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  async function renderWith(calls: string[]) {
    const refreshSource = vi.fn(async (options?: { expectedSourceRevision?: string }) => {
      calls.push(`refreshSource:${options?.expectedSourceRevision ?? 'current'}`);
    });
    const review = {
      view: { review: { reviewId: 'review-1' } },
      refreshSource,
    } as unknown as ContentReviewController;
    await act(async () => {
      root.render(
        <ContentReviewSurface
          review={review}
          path="drinks.md"
          sourceText=""
          sourceTextRevision="rev-1"
          onBack={() => undefined}
          onApplied={async () => {
            calls.push('refreshFile');
          }}
          capabilities={{} as ContentLandingCapabilities}
        />,
      );
    });
    return refreshSource;
  }

  it('refreshes the file, then moves the review only onto the accepted revision', async () => {
    const calls: string[] = [];
    await renderWith(calls);
    expect(captured.onApplied).toBeTypeOf('function');
    await act(async () => {
      await captured.onApplied?.(`sha256:${'b'.repeat(64)}`);
    });
    expect(calls).toEqual(['refreshFile', `refreshSource:sha256:${'b'.repeat(64)}`]);
  });

  it('leaves the drift banner in charge when the accepted revision is unknown', async () => {
    const calls: string[] = [];
    const refreshSource = await renderWith(calls);
    await act(async () => {
      await captured.onApplied?.(undefined);
    });
    expect(calls).toEqual(['refreshFile']);
    expect(refreshSource).not.toHaveBeenCalled();
  });
});
