import type { WorkspaceContentReview } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ProjectReviewPanel } from '../video-project/ProjectReviewPanel';
import { modificationOpinion, modificationSnapshot } from './modification.fixture';

it.each([
  '字'.repeat(80),
  '短\n意见\n也\n需要\n全文',
  'A short opinion',
])('can expand and collapse every clamped original body: %s', async (body) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const before = modificationSnapshot(1),
    annotation = modificationOpinion(before, modificationSnapshot(2));
  annotation.body = body;
  const container = document.createElement('div'),
    root = createRoot(container),
    locate = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ProjectReviewPanel
          contentRef={before.contentRef}
          review={{ annotations: [annotation], revision: 1 } as WorkspaceContentReview}
          screeningId="original"
          pending={false}
          error={null}
          onRefresh={vi.fn()}
          onLocate={locate}
          onCompare={vi.fn()}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]');
    expect(toggle).not.toBeNull();
    expect(container.querySelector('.line-clamp-3')?.textContent).toBe(body);
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.line-clamp-3')).toBeNull();
    expect(container.textContent).toContain(body);
    expect(locate).not.toHaveBeenCalled();
    await act(async () => toggle?.click());
    expect(container.querySelector('.line-clamp-3')?.textContent).toBe(body);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it('labels an explicit not-changed answer honestly and keeps its reason instead of offering a fake modification', () => {
  const before = modificationSnapshot(1);
  const annotation = modificationOpinion(before, modificationSnapshot(2), {
    kind: 'not-changed',
    reason: '这处位置已经符合原决定',
  });
  const html = renderToStaticMarkup(
    <ProjectReviewPanel
      contentRef={before.contentRef}
      review={{ annotations: [annotation], revision: 1 } as WorkspaceContentReview}
      screeningId="original"
      pending={false}
      error={null}
      onRefresh={vi.fn()}
      onLocate={vi.fn()}
      onCompare={vi.fn()}
    />,
  );
  expect(html).toContain('未改动');
  expect(html).toContain('这处位置已经符合原决定');
  expect(html).not.toContain('已修改');
  expect(html).not.toContain('查看修改');
  expect(html).toContain('还不对');
});

it('keeps the previous actual modification available after Human reopen without claiming it is the current answer', () => {
  const before = modificationSnapshot(1);
  const annotation = modificationOpinion(before, modificationSnapshot(2));
  annotation.projectHistory?.push({
    kind: 'reopened',
    operationId: 'human-reopen',
    actor: { kind: 'human', actorId: 'human' },
    at: '2026-10-10T18:00:00Z',
    reason: '还需修改',
  });
  const html = renderToStaticMarkup(
    <ProjectReviewPanel
      contentRef={before.contentRef}
      review={{ annotations: [annotation], revision: 2 } as WorkspaceContentReview}
      screeningId="original"
      pending={false}
      error={null}
      onRefresh={vi.fn()}
      onLocate={vi.fn()}
      onCompare={vi.fn()}
    />,
  );
  expect(html).toContain('待处理');
  expect(html).toContain('查看上次修改');
  expect(html).not.toContain('>还不对</button>');
});
