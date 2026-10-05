import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EvolutionContentReviewSurface } from '../EvolutionContentReviewSurface';
import { mediaView } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
it('opens an experiment original with the full discussion surface and explicit derivative action without preparing a publication', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container),
    view = mediaView(),
    old = view.review.source;
  if (old.kind !== 'media') throw new Error('expected original image');
  const ref = (name: string, version = 'v1') => ({
    ownerFeatureId: 'F311',
    ownerStateRef: 'experiment:' + name,
    version,
  });
  const locator = {
    programId: 'evolution-program:' + 'a'.repeat(32),
    experimentRef: ref('left'),
    recordRef: ref('case'),
    mediaRef: ref('original', 'b'.repeat(64)),
  };
  view.review.source = {
    kind: 'evolution',
    locator,
    revision: old.revision,
    mime: 'image/jpeg',
    media: old.media,
    byteLength: 100,
    label: '实验原图',
  };
  mocks.apiFetch.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toBe('/api/content-reviews/prepare');
    expect(JSON.parse(String(init.body)).evolution).toEqual(locator);
    return new Response(JSON.stringify({ ...view, currentSource: view.review.source }));
  });
  try {
    await act(async () => {
      root.render(<EvolutionContentReviewSurface locator={locator} title="实验原图" onBack={() => {}} />);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="workspace-content-review-surface"]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('作为新作品修改');
    expect(container.querySelector('img')?.getAttribute('src')).toContain(
      '/api/content-reviews/' + view.review.reviewId + '/media?',
    );
    expect(container.textContent).toContain('实验原件');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
