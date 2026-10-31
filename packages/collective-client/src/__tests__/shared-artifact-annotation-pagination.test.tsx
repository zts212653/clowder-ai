// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactAnnotations } from '../SharedArtifactAnnotations.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';
import { annotationArtifact, annotationView } from './shared-artifact-annotation-pages.fixture.js';

it('keeps explicitly expanded annotations across the same poll, but drops drifted and late pages after a new revision or Human', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let finish!: (view: SharedMarkdownView) => void;
  const expanded = annotationView();
  expanded.view.review.annotations.push(...annotationView(2).view.review.annotations);
  expanded.view.annotationPage.nextOffset = undefined;
  const moreAnnotations = vi.fn(async () => expanded);
  let humanId = 'reader';
  const render = (view: SharedMarkdownView) =>
    root.render(
      <CollectiveArtifactContext.Provider
        value={
          {
            catalogue: [annotationArtifact],
            humanId,
            humanName: (id: string) => id,
            api: { moreAnnotations },
          } as unknown as CollectiveArtifactState
        }
      >
        <SharedArtifactAnnotations view={view} onOpenDiscussion={() => {}} />
      </CollectiveArtifactContext.Provider>,
    );
  const more = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('更多批注'));
  try {
    await act(async () => render(annotationView()));
    expect(host.textContent).not.toContain('批注意见 2');
    expect(moreAnnotations).not.toHaveBeenCalled();
    expect(more()?.textContent).toContain('2/3');
    await act(async () => more()?.click());
    expect(host.textContent).toContain('批注意见 2');
    await act(async () => render(annotationView()));
    expect(host.textContent).toContain('批注意见 2');
    const next = annotationView();
    next.view.review.revision = 2;
    await act(async () => render(next));
    expect(host.textContent).not.toContain('批注意见 2');
    moreAnnotations.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => more()?.click());
    humanId = 'another-reader';
    await act(async () => render(next));
    await act(async () => finish(expanded));
    expect(host.textContent).not.toContain('批注意见 2');
    expect(more()?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
