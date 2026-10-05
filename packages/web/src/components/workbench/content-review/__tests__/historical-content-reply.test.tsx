import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentReviewSurface } from '../ContentReviewSurface';
import { discussionView } from './WorkspaceContentReviewSurface.fixture';

vi.mock('@/components/content-review/ReviewActor', () => ({ ReviewActor: () => <span>You</span> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it('uses separate reply authority while historical canvas and annotation state stay locked', async () => {
  const view = { ...discussionView(), canWrite: false, historyReadOnly: true, canReply: true };
  const action = vi.fn().mockResolvedValue(true);
  const controller = {
    view,
    error: null,
    draft: '',
    target: null,
    activeAnnotationId: null,
    busy: false,
    pending: false,
    setDraft: vi.fn(),
    setTarget: vi.fn(),
    setActiveAnnotationId: vi.fn(),
    submitAnnotation: vi.fn(),
    refreshSource: vi.fn(),
    act: action,
    retryPending: vi.fn(),
  };
  await act(async () =>
    root.render(
      <ContentReviewSurface
        review={controller}
        title="第一版"
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector<HTMLButtonElement>('[data-mode="markup"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-mode="comment"]')?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开作品讨论"]')?.click());
  const text = container.querySelector<HTMLTextAreaElement>('textarea[aria-label^="回复批注"]');
  expect(text).not.toBeNull();
  expect(container.textContent).not.toContain('标为已解决');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(text, '继续讨论原版');
  await act(async () => text?.dispatchEvent(new Event('input', { bubbles: true })));
  await act(async () => text?.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(action).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'reply', annotationId: view.review.annotations[0]?.id, body: '继续讨论原版' }),
  );
  Object.assign(view, { canReply: false });
  await act(async () =>
    root.render(
      <ContentReviewSurface
        review={{ ...controller, view: { ...view } }}
        path="cover.png"
        sourceText=""
        sourceTextRevision=""
        onBack={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('textarea[aria-label^="回复批注"]')).toBeNull();
});
