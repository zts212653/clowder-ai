import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ProjectReviewPanel } from '../video-project/ProjectReviewPanel';
import { useProjectReview } from '../video-project/useProjectReview';
import { modificationOpinion, modificationSnapshot } from './modification.fixture';

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../video-project/screening-ui/project-review-read', () => ({
  readProjectReview: read,
  synchronizeProjectReview: async () => ({ pending: false, error: null }),
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

it('shows a newly appended canonical history automatically without a refresh button or losing the original opinion', async () => {
  const first = modificationOpinion(modificationSnapshot(1), modificationSnapshot(2));
  first.projectHistory = [];
  const next = structuredClone(first);
  next.projectHistory?.push({
    kind: 'replied',
    actor: { kind: 'human', actorId: 'owner' },
    at: '2026-10-10T22:00:00Z',
    operationId: 'reply',
    reason: '新的经过已经到达',
  });
  read
    .mockReset()
    .mockResolvedValueOnce({ revision: 1, annotations: [first] })
    .mockResolvedValue({ revision: 2, annotations: [next] });
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div'),
    root = createRoot(container);
  const unused = () => {};
  function LivePanel() {
    const live = useProjectReview('project-1', 0);
    return (
      <ProjectReviewPanel
        contentRef="project-1"
        screeningId="original"
        {...live}
        onRefresh={unused}
        onLocate={unused}
        onCompare={unused}
      />
    );
  }
  try {
    await act(async () => root.render(<LivePanel />));
    expect(container.textContent).toContain(first.body);
    expect(container.textContent).not.toContain('新的经过已经到达');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(container.textContent).toContain('新的经过已经到达');
    expect(container.textContent).toContain(first.body);
    expect([...container.querySelectorAll('button')].map((item) => item.textContent)).not.toContain('刷新');
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
