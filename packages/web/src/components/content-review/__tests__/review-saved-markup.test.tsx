import type { ArtifactReviewDrawing } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReviewMarkupDraft } from '../review-markup-draft';

const media = { kind: 'image' as const, width: 800, height: 600 };
const first: ArtifactReviewDrawing = {
  id: 'first',
  kind: 'rectangle',
  x: 10,
  y: 12,
  width: 30,
  height: 40,
  color: '#d04a3a',
  strokeWidth: 4,
};
const second: ArtifactReviewDrawing = { ...first, id: 'second', x: 80 };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, draft: ReturnType<typeof useReviewMarkupDraft>;
const key = 'cat-cafe:review:operator:review:round:1:markup';
function Draft({ confirmed }: { confirmed: ArtifactReviewDrawing[] }) {
  draft = useReviewMarkupDraft(key, media, confirmed);
  return createElement('div', null, String(draft.marks.length));
}
async function render(confirmed: ArtifactReviewDrawing[] = []) {
  await act(async () => root.render(createElement(Draft, { confirmed })));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it('read-back removes only exactly committed marks and retires their local undo history', async () => {
  await render();
  await act(async () => draft.add(first));
  await act(async () => draft.add(second));
  expect(draft.canUndo).toBe(true);
  await render([first]);
  expect(draft.marks).toEqual([second]);
  expect(draft.canUndo).toBe(false);
  expect(draft.canRedo).toBe(false);
  expect(JSON.parse(localStorage.getItem(key)!).marks).toEqual([second]);
  await render([first, { ...second, x: 150 }]);
  expect(draft.marks).toEqual([second]);
  await render([first, second]);
  expect(draft.marks).toEqual([]);
});

it('a receipt never overwrites an unreadable local draft during crash recovery', async () => {
  localStorage.setItem(key, '{unknown-draft-sentinel');
  await render([first]);
  expect(draft.readError).toBe(true);
  expect(draft.canEdit).toBe(false);
  expect(localStorage.getItem(key)).toBe('{unknown-draft-sentinel');
});
