import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveArtifactReviewTarget } from '../artifact-review-surface';
import { contentContextSelectionKey, PublicationLandingResolver } from '../PublicationLandingResolver';
import { createPublicationSurface } from '../publication-surface';
import { createInitialWorkbenchState, reduceWorkbench } from '../workbench-model';

const mock = vi.hoisted(() => ({ apiFetch: vi.fn(), mount: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.apiFetch(...args) }));
const target = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 1 };
const canonical = createPublicationSurface({ ...target, title: '同一作品' });
const weak = {
  ...canonical,
  id: 'artifact:item',
  objectRef: { kind: 'artifact' as const, id: 'item' },
  ownerStateRef: { owner: 'f232', key: 'item' },
};
const context = (letter: string) => ({
  reviewId: `review-${letter.repeat(64)}`,
  round: 1,
  taskId: `task-${letter}`,
  threadId: `thread-${letter}`,
  title: '同一作品',
  taskTitle: `修改${letter}`,
  threadTitle: `原对话${letter}`,
  targetCatId: 'codex-astra',
  targetName: '小星星',
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.apiFetch.mockReset();
  mock.mount.mockReset();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
function Editor() {
  useEffect(() => {
    mock.mount();
  }, []);
  return <div data-testid="live-editor">原编辑会话</div>;
}
function Host() {
  const [layout, setLayout] = useState(createInitialWorkbenchState([canonical, weak]));
  return (
    <>
      {layout.surfaces.map((surface) => (
        <PublicationLandingResolver
          key={surface.id}
          sourceSurface={surface}
          target={target}
          onResolved={(resolved) =>
            setLayout((state) =>
              reduceWorkbench(state, {
                type: 'resolve-content-surface',
                sourceSurfaceId: surface.id,
                surface: resolved,
              }),
            )
          }
          onBack={() => {}}
        >
          <Editor />
        </PublicationLandingResolver>
      ))}
    </>
  );
}
it('the real resolver removes a weak F232 shell without mounting a second editing session', async () => {
  mock.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [] })));
  // Each reader owns its response stream, just like independent fetches.
  mock.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [] })));
  await act(async () => {
    root.render(<Host />);
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  expect(container.querySelectorAll('[data-testid="live-editor"]')).toHaveLength(1);
  expect(mock.mount).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain('正在回到原作品');
  await act(async () => {
    window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  expect(mock.mount, 'owner refresh does not remount an unchanged editing session').toHaveBeenCalledTimes(1);
});
it('requires a named genuine context choice, remembers it and returns the pinned original round', async () => {
  const choices = [context('b'), context('c')];
  choices[1]!.round = 2;
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: choices })),
  );
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(mock.mount).not.toHaveBeenCalled();
  const select = container.querySelector<HTMLSelectElement>('[aria-label="作品讨论上下文"]');
  expect(select?.textContent).toContain('小星星 · 原对话c · 修改c');
  if (!select) throw Error('missing context selection');
  select.value = choices[1]!.reviewId;
  await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
  expect(localStorage.getItem(contentContextSelectionKey('operator', target.contentRef))).toBe(choices[1]!.reviewId);
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])).toEqual({
    reviewId: choices[1]!.reviewId,
    threadId: 'thread-c',
    round: 2,
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  resolved.mockClear();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(choices[1]!.reviewId);
});

it('a publication opened from a chat message asks to continue its one review, whichever host renders it', async () => {
  // Real page 2026-09-24: the chat click resolves directly and opens a publication surface carrying
  // messagePublicationSource; the owner renderer, not the message landing, mounts the resolver.
  const fromChat = createPublicationSurface({
    ...target,
    title: '图片',
    messagePublicationSource: {
      kind: 'message',
      threadId: 'thread-chat',
      messageId: 'message-1',
      messageRevision: '1',
      expectedUrl: '/uploads/b.png',
      item: { kind: 'content-block', index: 0 },
    },
  });
  mock.apiFetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ownerUserId: 'operator',
          contexts: [{ ...context('e'), targetName: '缅因猫', title: '看看这张', state: 'awaiting_human' }],
        }),
      ),
  );
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={fromChat} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(container.textContent).toContain('继续缅因猫请你判断的：看看这张');
});

it('a review sharing the work own ledger is entered directly even from a chat message (Step1 shared-ledger contract)', async () => {
  // Real page 2026-09-24: a modification requested from the work itself shares its canonical ledger
  // (ledgerRef); asking the user to "continue" it only hid the work behind a prompt.
  const fromChat = createPublicationSurface({
    ...target,
    title: '图片',
    messagePublicationSource: {
      kind: 'message',
      threadId: 'thread-chat',
      messageId: 'message-2',
      messageRevision: '1',
      expectedUrl: '/uploads/c.png',
      item: { kind: 'content-block', index: 0 },
    },
  });
  const shared = {
    ...context('7'),
    title: '修改这张图',
    state: 'changes_requested',
    ledgerRef: `workspace-review-${'9'.repeat(64)}`,
  };
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [shared] })),
  );
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={fromChat} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(shared.reviewId);
});

it('a generic entry shows the one review as a named continue action instead of entering it (F309 parent 135)', async () => {
  // Real page 2026-09-24 (case B): opening a chat image whose only copy is a Task publication went
  // straight into the cat's review. The object still resolves to that same copy; the user continues it.
  const pending = {
    ...context('d'),
    title: '判断原作品选择选项文案是否清楚',
    targetName: '缅因猫',
    state: 'awaiting_human',
  };
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [pending] })),
  );
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={canonical}
        target={target}
        onResolved={resolved}
        onBack={() => {}}
        confirmSingleContext
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(mock.mount).not.toHaveBeenCalled();
  const action = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('继续缅因猫请你判断的：判断原作品选择选项文案是否清楚'),
  );
  if (!action) throw Error('missing named continue action');
  await act(async () => action.click());
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(pending.reviewId);
  expect(localStorage.getItem(contentContextSelectionKey('operator', target.contentRef))).toBe(pending.reviewId);

  await act(async () => root.unmount());
  root = createRoot(container);
  resolved.mockClear();
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={canonical}
        target={target}
        onResolved={resolved}
        onBack={() => {}}
        confirmSingleContext
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId, 'a valid prior choice restores').toBe(
    pending.reviewId,
  );
});

it('does not silently replace a remembered unavailable context with the remaining first Task', async () => {
  localStorage.setItem(contentContextSelectionKey('operator', target.contentRef), context('b').reviewId);
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [context('c')] })),
  );
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(mock.mount).not.toHaveBeenCalled();
  expect(container.textContent).toContain('上次选择的讨论当前不可用');
});

it('a review that appears while the work is shown does not take the work away (F309 parent 102)', async () => {
  // Real page 2026-09-24: submitting "请猫修改" from the work created a review on the same ledger;
  // the next refresh replaced the image with a prompt (before: jumped into the review).
  let contexts: Record<string, unknown>[] = [];
  mock.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts })));
  const resolved = vi.fn();
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(container.querySelectorAll('[data-testid="live-editor"]')).toHaveLength(1);

  contexts = [{ ...context('f'), title: '修改这张图', state: 'changes_requested' }];
  await act(async () => {
    window.dispatchEvent(new Event('cat-cafe:artifact-review-changed'));
    for (let n = 0; n < 8; n++) await Promise.resolve();
  });
  expect(resolved, 'the new review is not entered on its own').not.toHaveBeenCalled();
  expect(container.querySelectorAll('[data-testid="live-editor"]'), 'the work stays in place').toHaveLength(1);
  expect(mock.mount).toHaveBeenCalledTimes(1);
  const action = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('继续小星星的审阅：修改这张图'),
  );
  if (!action) throw Error('missing named continue action beside the work');
  await act(async () => action.click());
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(context('f').reviewId);
});
