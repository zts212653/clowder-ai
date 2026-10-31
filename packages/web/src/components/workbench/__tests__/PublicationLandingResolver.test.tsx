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

// A receipt is bound to one review. The work's generic entry remembers the review the person last chose and may be
// the only one of several; a bound target is neither of those, and never turns into a sibling's review.
const boundTo = (letter: string) => ({ ...target, reviewId: context(letter).reviewId });
const renderBound = async (letter: string, contexts: ReturnType<typeof context>[], resolved = vi.fn()) => {
  mock.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts })));
  const bound = boundTo(letter);
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={createPublicationSurface({ ...bound, title: '作品' })}
        target={bound}
        onResolved={resolved}
        onBack={() => {}}
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  return resolved;
};
const NOT_HELD = '这份修改所属的审阅当前不可访问，或已不再包含这一版；没有改去打开这件作品的其他任务审阅。';

it('a target bound to a review enters that review, whatever the generic entry remembered for the work', async () => {
  localStorage.setItem(contentContextSelectionKey('operator', target.contentRef), context('c').reviewId);
  const resolved = await renderBound('b', [context('c'), context('b')]);
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(context('b').reviewId);
  expect(container.querySelector('[aria-label="作品讨论上下文"]')).toBeNull();
});

it('a target bound to a review enters it even when it is the one of several that the person never chose', async () => {
  const resolved = await renderBound('c', [context('b'), context('c'), context('d')]);
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(context('c').reviewId);
  expect(resolved).toHaveBeenCalledTimes(1);
});

it('says so in place when the bound review is not among the work reviews, and offers no sibling', async () => {
  localStorage.setItem(contentContextSelectionKey('operator', target.contentRef), context('c').reviewId);
  const resolved = await renderBound('b', [context('c'), context('d')]);
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
  expect(container.querySelector('[aria-label="作品讨论上下文"]')).toBeNull();
  expect(container.textContent).not.toContain('继续');
  expect(mock.mount).not.toHaveBeenCalled();
});

it('also says so when the work has no review at all, instead of showing the work as if nothing were bound', async () => {
  const resolved = await renderBound('b', []);
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
  expect(mock.mount).not.toHaveBeenCalled();
});

it('still offers the way back from the bound notice', async () => {
  const onBack = vi.fn();
  mock.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [] })));
  const bound = boundTo('b');
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={createPublicationSurface({ ...bound, title: '作品' })}
        target={bound}
        onResolved={vi.fn()}
        onBack={onBack}
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  const back = [...container.querySelectorAll('button')].find((button) => button.textContent === '返回来源');
  expect(back).toBeDefined();
  await act(async () => back?.click());
  expect(onBack).toHaveBeenCalledTimes(1);
});

// The host keeps one resolver for a work whatever opened it, so the same instance can go from the generic entry to a
// bound receipt. Nothing the generic entry left behind (the work on screen, the choice it recorded, the catalogue it
// read) may answer for the bound target.
const renderGeneric = async (contexts: ReturnType<typeof context>[], resolved = vi.fn()) => {
  mock.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts })));
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  return resolved;
};
const siblingButtons = () => [...container.querySelectorAll('[aria-label="关联的任务审阅"] button')];

it('a work shown through the generic entry gives way to a bound target whose review is gone: notice only, no sibling', async () => {
  const resolved = await renderGeneric([]);
  expect(container.querySelector('[data-testid="live-editor"]')).not.toBeNull();
  resolved.mockClear();
  await renderBound('b', [context('c')], resolved);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
  expect(container.querySelector('[data-testid="live-editor"]')).toBeNull();
  expect(container.querySelector('[aria-label="关联的任务审阅"]')).toBeNull();
  expect(resolved).not.toHaveBeenCalled();
});

it('no sibling can be reached by clicking through after the switch to a bound target', async () => {
  const resolved = await renderGeneric([]);
  resolved.mockClear();
  await renderBound('b', [context('c')], resolved);
  for (const button of siblingButtons()) await act(async () => (button as HTMLButtonElement).click());
  expect(resolved).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
});

it('a choice made on the generic entry does not answer for a bound target', async () => {
  const resolved = await renderGeneric([context('c'), context('d')]);
  const select = container.querySelector<HTMLSelectElement>('[aria-label="作品讨论上下文"]');
  if (!select) throw Error('missing context selection');
  select.value = context('c').reviewId;
  await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
  expect(resolved).toHaveBeenCalledTimes(1);
  // The same instance now serves a receipt bound to a review the owner no longer reports: C was chosen, B was asked for.
  await renderBound('b', [context('c'), context('d')], resolved);
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
});

it('the catalogue the generic entry read is not the answer for a bound target while the new read is still pending', async () => {
  const resolved = await renderGeneric([context('c')]);
  const select = container.querySelector<HTMLButtonElement>('button');
  expect(select).not.toBeNull();
  resolved.mockClear();
  mock.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
  const bound = boundTo('b');
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={createPublicationSurface({ ...bound, title: '作品' })}
        target={bound}
        onResolved={resolved}
        onBack={() => {}}
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  expect(resolved).not.toHaveBeenCalled();
  expect(siblingButtons()).toHaveLength(0);
  expect(container.querySelector('[data-testid="live-editor"]')).toBeNull();
  // Until the owner answers for the bound review, nothing is concluded about it: it is being checked, not missing.
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('正在核对作品的原讨论');
});

it('a bound review is still entered after the work was shown through the generic entry', async () => {
  const resolved = await renderGeneric([]);
  resolved.mockClear();
  await renderBound('b', [context('b'), context('c')], resolved);
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(resolveArtifactReviewTarget(resolved.mock.calls[0]?.[0])?.reviewId).toBe(context('b').reviewId);
});

it('goes back to being an ordinary entry when the target stops being bound: the notice does not stick', async () => {
  // The work was shown through the generic entry, a bound receipt then replaced it with its notice, and now a plain
  // open of the same work arrives: the work is not on screen, so its one review is entered as for a fresh open.
  const resolved = await renderGeneric([]);
  expect(container.querySelector('[data-testid="live-editor"]')).not.toBeNull();
  resolved.mockClear();
  await renderBound('b', [context('c')], resolved);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(NOT_HELD);
  mock.apiFetch.mockImplementation(
    async () => new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [context('c')] })),
  );
  await act(async () => {
    root.render(
      <PublicationLandingResolver sourceSurface={canonical} target={target} onResolved={resolved} onBack={() => {}}>
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  expect(container.textContent).not.toContain('没有改去打开这件作品的其他任务审阅');
  expect(resolveArtifactReviewTarget(resolved.mock.calls.at(-1)?.[0])?.reviewId).toBe(context('c').reviewId);
});

it.each([
  'pending',
  'error',
  'choice',
])('keeps the header switch reachable in the %s resolver fallback without mounting the owner', async (state) => {
  const switched = vi.fn();
  if (state === 'pending') mock.apiFetch.mockImplementation(() => new Promise<Response>(() => {}));
  else
    mock.apiFetch.mockImplementation(async () =>
      state === 'error'
        ? new Response(JSON.stringify({ error: 'denied' }), { status: 403 })
        : new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [context('b'), context('c')] })),
    );
  await act(async () => {
    root.render(
      <PublicationLandingResolver
        sourceSurface={canonical}
        target={target}
        onResolved={() => {}}
        onBack={() => {}}
        leadingAction={<button onClick={switched}>切换原作品</button>}
      >
        <Editor />
      </PublicationLandingResolver>,
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
  });
  const action = [...container.querySelectorAll('button')].find((item) => item.textContent === '切换原作品');
  expect(action).toBeDefined();
  await act(async () => action!.click());
  expect(switched).toHaveBeenCalledTimes(1);
  expect(mock.mount).not.toHaveBeenCalled();
});
