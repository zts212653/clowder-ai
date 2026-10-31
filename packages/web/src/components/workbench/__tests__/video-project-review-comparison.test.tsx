import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useProjectReview } from '../video-project/useProjectReview';
import { useScreeningProject } from '../video-project/useScreeningProject';
import { VideoProjectReviewSurface } from '../video-project/VideoProjectReviewSurface';
import {
  createVideoProjectSurface,
  resolveVideoProjectTarget,
  type VideoProjectTarget,
} from '../video-project-surface';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

// Synthetic loaded-owner fixtures isolate the real surface's state transitions; playback has separate tests.
vi.mock('../video-project/useProjectReview', () => ({ useProjectReview: vi.fn() }));
vi.mock('../video-project/useScreeningProject', () => ({ useScreeningProject: vi.fn() }));
vi.mock('../video-project/VideoProjectScreeningPlayer', () => ({
  VideoProjectScreeningPlayer: ({ screening, markRequest }: { screening: { id: string }; markRequest: number }) => (
    <output data-testid="single" data-mark-request={markRequest}>
      {screening.id}
    </output>
  ),
}));
vi.mock('../video-project/ProjectScreeningCompare', () => ({
  ProjectScreeningCompare: ({
    leftId,
    right,
    markRequest,
  }: {
    leftId: string;
    right: { screening: { id: string } };
    markRequest: number;
  }) => (
    <output data-testid="compare" data-mark-request={markRequest}>
      {leftId}-&gt;{right.screening.id}
    </output>
  ),
}));
vi.mock('../video-project/RegisterScreening', () => ({ RegisterScreening: () => null }));
vi.mock('../video-project/ProjectReviewPanel', () => ({ ProjectReviewPanel: () => null }));
const contentRef = `video-project:${'a'.repeat(64)}`;
const sides = ['v1', 'v2', 'v3', 'v4'].map((id) => comparisonSide(id, [comparisonShot('shot', 0, 100)]));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let listed: typeof sides, target: VideoProjectTarget, nextTarget: VideoProjectTarget;
const refresh = vi.fn((surface) => {
  const resolved = resolveVideoProjectTarget(surface);
  if (!resolved) throw new Error('Invalid refreshed surface target');
  nextTarget = resolved;
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  listed = sides.slice(0, 3);
  target = { contentRef, screeningId: 'v3' };
  nextTarget = target;
  refresh.mockClear();
  vi.mocked(useProjectReview).mockReturnValue({ review: null, error: null, pending: false });
  vi.mocked(useScreeningProject).mockImplementation((selected) => {
    const side = sides.find((item) => item.screening.id === selected.screeningId) ?? listed.at(-1) ?? sides[2];
    const input = { ...side.input, contentRef: selected.contentRef };
    const screeningFor = (item: typeof side) => ({
      ...item.screening,
      input: { ...item.screening.input, contentRef: selected.contentRef },
    });
    const head = { ...input, document: { ...input.document, screenings: listed.map(screeningFor) } };
    return {
      state: { head, input, descriptor: { screening: screeningFor(side), mediaUrl: side.mediaUrl } },
      error: null,
      loading: false,
    };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<VideoProjectReviewSurface target={target} onRefreshSurface={refresh} />));
}
async function select(index: number, value: string) {
  const element = container.querySelectorAll('select')[index];
  if (!element) throw new Error('Missing version selector');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function compare() {
  await render();
  await select(1, 'v2');
  expect(container.querySelector('[data-testid="compare"]')?.textContent).toBe('v2->v3');
}
it.each([
  'v1',
  'v2',
])('discards the pair before a version selector makes %s the frozen right version', async (version) => {
  await compare();
  await select(0, version);
  target = nextTarget;
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
  expect(container.querySelector('[data-testid="single"]')?.textContent).toBe(version);
});
it.each([
  { contentRef, screeningId: 'v1', position: { pts: 5, requestId: 1 } },
  { contentRef, screeningId: 'v3', position: { pts: 5, requestId: 1 } },
  { contentRef: `video-project:${'b'.repeat(64)}`, screeningId: 'v3' },
] as const)('clears comparison for an external original-chip/restore navigation %j', async (changed) => {
  await compare();
  const surface = createVideoProjectSurface({ ...changed, title: '原位置' });
  const resolved = resolveVideoProjectTarget(surface);
  if (!resolved) throw new Error('Fixture restore descriptor did not resolve');
  target = resolved;
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
  expect(container.querySelector('[data-testid="single"]')?.textContent).toBe(target.screeningId);
});
it('does not revive the previous pair after navigating back to its former right version', async () => {
  await compare();
  target = { contentRef, screeningId: 'v1' };
  await render();
  target = { contentRef, screeningId: 'v3' };
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
});
it('retains the chosen fixed pair on head refresh without offering a newly appended right version as old', async () => {
  await compare();
  listed = sides;
  await render();
  expect(container.querySelector('[data-testid="compare"]')?.textContent).toBe('v2->v3');
  const options = [...container.querySelectorAll('select')[1].options].map((option) => option.value);
  expect(options).toEqual(['', 'v1', 'v2']);
});
it('stops a comparison whose left version is absent from the current admitted directory', async () => {
  await compare();
  listed = [sides[0], sides[2]];
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
  expect(container.querySelectorAll('select')[1].value).toBe('');
  listed = sides.slice(0, 3);
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
});
it('does not revive a pair after an initially unresolved right resolves to another version and back', async () => {
  target = { contentRef };
  await compare();
  listed = sides;
  await render();
  expect(container.querySelector('[data-testid="single"]')?.textContent).toBe('v4');
  listed = sides.slice(0, 3);
  await render();
  expect(container.querySelector('[data-testid="compare"]')).toBeNull();
});

it.each([false, true])('routes M and the header to the same active picture (compare=%s)', async (comparison) => {
  if (comparison) await compare();
  else await render();
  const picture = container.querySelector('[data-mark-request]');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', bubbles: true })));
  expect(picture?.getAttribute('data-mark-request')).toBe('1');
  const mark = [...container.querySelectorAll('button')].find((button) => button.querySelector('kbd'));
  await act(async () => mark?.click());
  expect(picture?.getAttribute('data-mark-request')).toBe('2');
});
it('ignores typing, native selectors, composition, held keys, modifiers and hidden pictures', async () => {
  await compare();
  const picture = container.querySelector('[data-mark-request]');
  for (const element of ['input', 'textarea', 'select', 'div']) {
    const editor = document.createElement(element);
    if (element === 'div') editor.setAttribute('contenteditable', '');
    container.append(editor);
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })));
    editor.remove();
  }
  for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }])
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ...flags })));
  expect(picture?.getAttribute('data-mark-request')).toBe('0');
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible={false}>
        <VideoProjectReviewSurface target={target} onRefreshSurface={refresh} />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' })));
  expect(container.querySelector('[data-mark-request]')?.getAttribute('data-mark-request')).toBe('0');
});
