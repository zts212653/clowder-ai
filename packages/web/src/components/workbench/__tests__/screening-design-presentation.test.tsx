import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { checkShellCopyParity } from '../../shell/__tests__/shell-copy-parity-check';
import { ProjectReviewPanel } from '../video-project/ProjectReviewPanel';
import { ScreeningTimelineNavigation } from '../video-project/screening-ui/ScreeningTimelineNavigation';
import { screeningCopy } from '../video-project/screening-ui/screening.shell-copy';
import { modificationOpinion, modificationSnapshot } from './modification.fixture';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ displayName: '小太阳', avatar: '/avatars/sol.png' }) }),
}));
vi.mock('@/components/CatAvatar', () => ({
  // biome-ignore lint/performance/noImgElement: immutable CatAvatar test substitute, not production rendering.
  CatAvatar: ({ catId }: { catId: string }) => <img alt="小太阳" src={`/avatars/${catId}.png`} />,
}));
it('keeps all screening wording and count/time templates equivalent in Chinese and English', () => {
  expect(checkShellCopyParity(screeningCopy)).toEqual([]);
});

it('shows numbered scenes with names on hover and real frozen artwork only in the current scene', () => {
  const input = modificationSnapshot(1);
  input.document.timeline.scenes = [
    { id: 's1', label: '开场' },
    { id: 's2', label: '找到问题' },
  ];
  input.document.timeline.segments[0].sceneId = 's1';
  input.document.timeline.segments[1].sceneId = 's2';
  const props = {
    timeline: input.document.timeline,
    assets: input.document.assets,
    contentRef: input.contentRef,
    ownerRevision: 1,
    current: input.document.timeline.segments[1],
    onSeek: vi.fn(),
  };
  const dom = new DOMParser().parseFromString(
    renderToStaticMarkup(<ScreeningTimelineNavigation {...props} />),
    'text/html',
  );
  const scenes = dom.querySelector('nav[aria-label="场次"]');
  expect(scenes?.textContent).toBe('12');
  expect(scenes?.querySelector('button[title="找到问题"]')?.getAttribute('aria-current')).toBe('true');
  const shots = dom.querySelector('nav[aria-label="镜头"]');
  expect(shots?.querySelectorAll('button')).toHaveLength(1);
  expect(shots?.textContent?.match(/C08/g)).toHaveLength(1);
  expect(shots?.querySelector('img')?.getAttribute('src')).toContain('/assets/png-old?ownerRevision=1');
});

it('keeps issue authors friendly, exposes expansion and removes the manual refresh action', () => {
  const before = modificationSnapshot(1),
    annotation = modificationOpinion(before, modificationSnapshot(2));
  annotation.body = '这是一条需要保留全文、但不能占满问题栏的原意见。'.repeat(12);
  const html = renderToStaticMarkup(
    <ProjectReviewPanel
      contentRef={before.contentRef}
      review={{ annotations: [annotation], revision: 1 } as never}
      screeningId="original"
      pending={false}
      error={null}
      onRefresh={vi.fn()}
      onLocate={vi.fn()}
      onCompare={vi.fn()}
    />,
  );
  const dom = new DOMParser().parseFromString(html, 'text/html');
  expect(dom.body.textContent).toContain('你');
  expect(dom.body.textContent).toContain('小太阳');
  expect(dom.body.textContent).not.toContain('owner');
  expect(dom.body.textContent).not.toContain('sol');
  expect(dom.querySelector('img')).not.toBeNull();
  expect(dom.querySelector('[aria-expanded="false"]')).not.toBeNull();
  expect([...dom.querySelectorAll('button')].map((item) => item.textContent)).not.toContain('刷新');
});
