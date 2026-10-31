import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReviewContextSelector } from '../ReviewContextSelector';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
const context = (id: string) => ({
  reviewId: id,
  round: 1,
  taskId: `task-${id}`,
  threadId: `thread-${id}`,
  title: '封面',
  taskTitle: '完成封面',
  threadTitle: '原对话',
  targetCatId: 'opus5',
  targetName: '宪宪',
  state: 'draft',
  taskState: 'active',
});
// The selector consumes only owner/read coordinates; annotations remain in the real landing tests.
const view = { review: { reviewId: 'review-a', revision: 1, task: { ownerUserId: 'operator' } } } as ArtifactReviewView;
const round = { number: 1, asset: { contentRef: 'prepared-media:a', ownerRevision: 1 } } as ArtifactReviewRound;
const response = (contexts = [context('review-a'), context('review-b')], ownerUserId = 'operator') =>
  new Response(JSON.stringify({ ownerUserId, contexts }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.fetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};
it('a disappeared selected context stays explicit and is never replaced by the remaining Task', async () => {
  mock.fetch.mockImplementation(async () => response([context('review-b')]));
  const onChange = vi.fn();
  await act(async () => {
    root.render(<ReviewContextSelector view={view} round={round} onChange={onChange} />);
    await flush();
  });
  expect(container.querySelector('select')?.value).toBe('review-a');
  expect(container.textContent).toContain('当前讨论的关联已变化');
  expect(onChange).not.toHaveBeenCalled();
  expect(container.textContent).toContain('宪宪 · 原对话 · 完成封面 · 第 1 版 · 讨论中');
});
it('permission/read failure clears old choices and a fresh retry can recover without switching', async () => {
  mock.fetch.mockImplementation(async () => response());
  const onChange = vi.fn();
  await act(async () => {
    root.render(<ReviewContextSelector view={view} round={round} onChange={onChange} />);
    await flush();
  });
  mock.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '权限已变化' } }), { status: 403 }));
  await act(async () => {
    window.dispatchEvent(new Event('cat-cafe:artifact-review-changed'));
    await flush();
  });
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.querySelectorAll('option')).toHaveLength(1);
  await act(async () => {
    container.querySelector('button')?.click();
    await flush();
  });
  expect(container.querySelector('select')?.disabled).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
});
it('late previous-version replies cannot expose old choices in the new version or another owner', async () => {
  let resolveOld!: (value: Response) => void;
  mock.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      }),
  );
  const onChange = vi.fn();
  await act(async () => root.render(<ReviewContextSelector view={view} round={round} onChange={onChange} />));
  mock.fetch.mockImplementation(async () => response([context('review-new')], 'other-user'));
  await act(async () => {
    root.render(
      <ReviewContextSelector
        view={view}
        round={{ ...round, asset: { ...round.asset, ownerRevision: 2 } }}
        onChange={onChange}
      />,
    );
    await flush();
  });
  await act(async () => {
    resolveOld(response());
    await flush();
  });
  expect(container.querySelector('select')?.disabled).toBe(true);
  expect(container.querySelectorAll('option')).toHaveLength(1);
  expect(container.textContent).toContain('当前身份已变化');
  expect(onChange).not.toHaveBeenCalled();
});
