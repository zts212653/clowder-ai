import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createArtifactReviewSurface } from '../artifact-review-surface';
import { ContentPublicationNavigator } from '../ContentPublicationNavigator';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createPublicationSurface } from '../publication-surface';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import { createInitialWorkbenchState } from '../workbench-model';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), mount: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
const source = {
  kind: 'message' as const,
  threadId: 'source',
  messageId: 'message',
  messageRevision: '42',
  expectedUrl: '/uploads/a.png',
  item: { kind: 'content-block' as const, index: 0 },
};
const asset = {
  contentRef: `prepared-media:${'a'.repeat(64)}`,
  ownerRevision: 1,
  blobDigest: `sha256:${'b'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 20, height: 20 },
  ownerReceiptRef: 'receipt',
  sourcePublication: { artifactRef: source.expectedUrl, sourceRef: 'message:source:message', revision: '42' },
};
const surface = { ...createPublicationSurface({ ...asset, title: '封面' }), messagePublicationSource: source };
function Owner() {
  useEffect(() => {
    mock.mount();
  }, []);
  return (
    <textarea aria-label="原批注草稿" data-visible={useWorkspaceSurfaceVisibility()} defaultValue="未提交的选区说明" />
  );
}
let root: Root, element: HTMLDivElement;
const store = useF307ExperienceWorkbenchStore;
let original: ReturnType<typeof store.getState>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mock.fetch.mockReset();
  mock.mount.mockReset();
  original = store.getState();
  store.setState({ layout: createInitialWorkbenchState([surface]), hydrated: true, mainAreaAttentionSurfaceId: null });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  store.setState(original, true);
});
const render = () =>
  act(async () =>
    root.render(
      <ContentPublicationNavigator surface={surface}>
        <Owner />
      </ContentPublicationNavigator>,
    ),
  );
const button = (text: string) =>
  [...element.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
it('failed or cancelled reselection leaves the same owner instance and unsaved draft intact', async () => {
  mock.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }));
  await render();
  const draft = element.querySelector('textarea')!;
  draft.value = '仍在编辑';
  await act(async () => button('切换原作品')!.click());
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(draft.dataset.visible).toBe('false');
  expect(mock.mount).toHaveBeenCalledTimes(1);
  await act(async () => button('返回作品')!.click());
  expect(element.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('仍在编辑');
  expect(draft.dataset.visible).toBe('true');
  expect(store.getState().layout.surfaces).toEqual([surface]);
});
it('explicitly selecting the same canonical work completes without a stuck resolving shell or duplicate owner', async () => {
  mock.fetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/content-reviews/resolve'
            ? { ownerUserId: 'operator', contexts: [] }
            : { status: 'resolved', ownerUserId: 'operator', asset },
        ),
      ),
  );
  await render();
  await act(async () => button('切换原作品')!.click());
  expect(element.textContent).toContain('当前只有这一份可访问的作品');
  await act(async () => button('打开第 1 版')!.click());
  expect(element.textContent).not.toContain('正在回到原作品');
  expect(element.querySelector('textarea')?.dataset.visible).toBe('true');
  expect(mock.mount).toHaveBeenCalledTimes(1);
  expect(store.getState().layout.surfaces).toHaveLength(1);
  expect(store.getState().layout.surfaces[0]?.messagePublicationSource).toEqual(source);
  expect(store.getState().mainAreaAttentionSurfaceId).toBeNull();
});

it('places the v2 publication chooser in the existing header and keeps its owner and return focus', async () => {
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  mock.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }));
  await act(async () =>
    root.render(
      <ContentPublicationNavigator surface={surface}>
        {(leadingAction) => (
          <>
            <header data-testid="content-actions">
              {leadingAction}
              <button>返回</button>
            </header>
            <Owner />
          </>
        )}
      </ContentPublicationNavigator>,
    ),
  );
  const trigger = button('切换原作品')!;
  expect(trigger?.closest('header')?.dataset.testid).toBe('content-actions');
  const draft = element.querySelector('textarea')!;
  draft.value = '仍在编辑';
  await act(async () => trigger.click());
  await act(async () => button('返回作品')!.click());
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(element.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('仍在编辑');
  expect(mock.mount).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(trigger);
});

it('places the valid Task-associated chooser beside its version without replacing its owner on cancellation', async () => {
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  const taskSurface = {
    ...createArtifactReviewSurface(`review-${'c'.repeat(64)}`, source.threadId, '原作品', 2),
    messagePublicationSource: source,
  };
  mock.fetch.mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }));
  store.setState({ layout: createInitialWorkbenchState([taskSurface]) });
  await act(async () =>
    root.render(
      <ContentPublicationNavigator surface={taskSurface}>
        {(leadingAction) => (
          <>
            <header data-testid="task-actions">
              {leadingAction}
              <span>第 2 版</span>
            </header>
            <Owner />
          </>
        )}
      </ContentPublicationNavigator>,
    ),
  );
  const trigger = button('切换原作品')!;
  expect(trigger?.closest('header')?.dataset.testid).toBe('task-actions');
  const draft = element.querySelector('textarea')!;
  draft.value = '同Task第2版未提交的说明';
  await act(async () => trigger.click());
  await act(async () => button('返回作品')!.click());
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(element.querySelector('textarea')).toBe(draft);
  expect(draft.value).toBe('同Task第2版未提交的说明');
  expect(mock.mount).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
  expect(store.getState().layout.surfaces).toEqual([taskSurface]);
});

it('keeps the standalone chooser for a rejected Task descriptor even with a header-slot receiver', async () => {
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  const valid = createArtifactReviewSurface(`review-${'c'.repeat(64)}`, source.threadId, '原作品', 2);
  const invalid = { ...valid, id: 'foreign-owner-id', messagePublicationSource: source };
  await act(async () =>
    root.render(
      <ContentPublicationNavigator surface={invalid}>
        {(leadingAction) => (
          <header data-testid="invalid-actions">
            {leadingAction}
            <p>审阅引用已不可用。</p>
          </header>
        )}
      </ContentPublicationNavigator>,
    ),
  );
  expect(button('切换原作品')).toBeDefined();
  expect(button('切换原作品')?.closest('header')).toBeNull();
});
