import type { ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
const source: ContentModificationRequest['source'] = {
  kind: 'workspace',
  reviewId: 'review',
  locator: { worktreeId: 'work', path: 'guide.md' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  expectedReviewRevision: 1,
};
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mock.fetch.mockReset();
  mock.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          cats: [{ catId: 'opus5', name: '宪宪', mcpSupport: true, restrictions: ['不负责生产发布'] }],
          threads: [{ threadId: 'thread', title: '原对话' }],
        }),
      ),
  );
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
const render = (catId = 'opus5', threadId = 'thread') =>
  act(async () =>
    root.render(
      <ContentModificationPanel
        source={source}
        ownerUserId="operator"
        title="说明书"
        suggestedCatId={catId}
        suggestedThreadId={threadId}
        initialBody="修改文案"
        onClose={() => {}}
      />,
    ),
  );
it('retains the unavailable named cat visibly rather than displaying the empty or first option', async () => {
  await render('missing-cat');
  const selected = element.querySelector<HTMLSelectElement>('[aria-label="修改目标猫"]');
  expect(selected?.value).toBe('missing-cat');
  expect(selected?.selectedOptions[0]?.textContent).toContain('当前不可用');
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
it('retains a missing execution conversation as an explicit unavailable choice', async () => {
  await render('opus5', 'missing-thread');
  const selected = element.querySelector<HTMLSelectElement>('[aria-label="修改执行对话"]');
  expect(selected?.value).toBe('missing-thread');
  expect(selected?.selectedOptions[0]?.textContent).toContain('当前不可用');
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
});
it('shows the selected cat restrictions without turning free text into a new inferred routing prohibition', async () => {
  await render();
  expect(element.textContent).toContain('不负责生产发布');
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(false);
});
