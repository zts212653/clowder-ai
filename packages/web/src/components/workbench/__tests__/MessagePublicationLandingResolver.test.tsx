import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessagePublicationLandingResolver } from '../MessagePublicationLandingResolver';
import { createMessagePublicationSurface } from '../message-publication-surface';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
const source = {
  kind: 'message' as const,
  threadId: 'source-thread',
  messageId: 'm',
  messageRevision: '1',
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
  sourcePublication: { artifactRef: source.expectedUrl, sourceRef: 'message:source-thread:m', revision: '1' },
};
const choice = {
  asset,
  title: '封面',
  taskTitle: '原来的封面委托',
  threadTitle: '一起画画',
  targetName: '小星星',
  match: 'legacy-ambiguous',
};
let element: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mocks.apiFetch.mockReset();
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
});

it('ambiguous legacy source waits for a named choice and resolves the original review without mounting an editor', async () => {
  mocks.apiFetch.mockImplementation(
    async (url, init) =>
      new Response(
        JSON.stringify(
          url === '/api/content-reviews/resolve'
            ? {
                ownerUserId: 'operator',
                contexts: [
                  {
                    reviewId: `review-${'c'.repeat(64)}`,
                    round: 1,
                    taskId: 'task',
                    threadId: 'source-thread',
                    title: '封面',
                    taskTitle: choice.taskTitle,
                    threadTitle: choice.threadTitle,
                    targetCatId: 'codex-astra',
                    targetName: choice.targetName,
                  },
                ],
              }
            : JSON.parse(init.body).selection
              ? { status: 'resolved', ownerUserId: 'operator', asset }
              : { status: 'choice-required', ownerUserId: 'operator', choices: [choice] },
        ),
      ),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  expect(onResolved).not.toHaveBeenCalled();
  expect(element.textContent).toContain('原来的封面委托');
  expect(element.querySelector('textarea')).toBeNull();
  await act(async () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('原来的封面委托'))!.click(),
  );
  const selected = mocks.apiFetch.mock.calls.find(
    ([url, init]) => url === '/api/content-publications/resolve' && JSON.parse(init.body).selection,
  );
  expect(JSON.parse(selected![1].body).selection).toEqual({
    contentRef: asset.contentRef,
    ownerRevision: 1,
  });
  expect(onResolved.mock.calls[0]?.[0].id).toBe(`content-review:review-${'c'.repeat(64)}`);
  expect(element.querySelector('textarea')).toBeNull();
});

it('names each copy by what the user continues and puts a pending judgment first (F309 parent 102)', async () => {
  // Real page 2026-09-24: the two copies read "判断 Schedule 卡片… · 第 1 版" and a bare file name.
  const direct = {
    ...choice,
    asset: { ...asset, contentRef: `prepared-media:${'e'.repeat(64)}` },
    title: '1790209472839-9b7936d6.png',
    taskTitle: undefined,
    targetName: undefined,
    match: 'exact',
  };
  const task = { ...choice, taskTitle: '判断 Schedule 卡片红色说明是否越界', targetName: '缅因猫', match: 'exact' };
  mocks.apiFetch.mockImplementation(async (url, init) => {
    if (url === '/api/content-reviews/resolve') {
      const { contentRef } = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          ownerUserId: 'operator',
          contexts:
            contentRef === asset.contentRef
              ? [
                  {
                    reviewId: `review-${'c'.repeat(64)}`,
                    round: 1,
                    taskId: 'task',
                    threadId: 'source-thread',
                    title: '红色说明越界了吗',
                    taskTitle: task.taskTitle,
                    threadTitle: '一起画画',
                    targetCatId: 'codex-sol',
                    targetName: '缅因猫',
                    state: 'awaiting_human',
                  },
                ]
              : [],
        }),
      );
    }
    return new Response(
      JSON.stringify({ status: 'choice-required', ownerUserId: 'operator', choices: [direct, task] }),
    );
  });
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '图片')}
        onResolved={() => {}}
        onBack={() => {}}
      />,
    ),
  );
  const options = [...element.querySelectorAll('li button')].map((button) => button.textContent ?? '');
  expect(options).toHaveLength(2);
  expect(options[0]).toContain('继续缅因猫请你判断的：红色说明越界了吗');
  expect(options[1]).toContain('直接在这张图上讨论（独立于任务审阅）');
  expect(options[1]).not.toContain('1790209472839-9b7936d6.png');
});

it('a chat image whose only copy is a Task review offers to continue it by name instead of entering (case B)', async () => {
  mocks.apiFetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/content-reviews/resolve'
            ? {
                ownerUserId: 'operator',
                contexts: [
                  {
                    reviewId: `review-${'c'.repeat(64)}`,
                    round: 1,
                    taskId: 'task',
                    threadId: 'source-thread',
                    title: '判断原作品选择选项文案是否清楚',
                    taskTitle: '判断原作品选择选项文案是否清楚',
                    threadTitle: '一起画画',
                    targetCatId: 'codex-sol',
                    targetName: '缅因猫',
                    state: 'awaiting_human',
                  },
                ],
              }
            : { status: 'resolved', ownerUserId: 'operator', asset },
        ),
      ),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '图片')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  expect(onResolved).not.toHaveBeenCalled();
  const action = [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('继续缅因猫请你判断的：判断原作品选择选项文案是否清楚'),
  );
  if (!action) throw Error('missing named continue action');
  expect(element.textContent).not.toContain('直接在这张图上讨论');
  await act(async () => action.click());
  expect(onResolved.mock.calls[0]?.[0].id).toBe(`content-review:review-${'c'.repeat(64)}`);
  expect(
    mocks.apiFetch.mock.calls.filter(
      ([url, init]) => url === '/api/content-publications/resolve' && JSON.parse(init.body).selection,
    ),
    'the same retained copy is continued; nothing new is resolved or created',
  ).toHaveLength(0);
});

it('a saved choice that loses access remains an error and cannot switch to the remaining first publication', async () => {
  mocks.apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'choice-required', ownerUserId: 'operator', choices: [choice] })),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }));
  await act(async () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('原来的封面委托'))!.click(),
  );
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(onResolved).not.toHaveBeenCalled();
});

it('reopening does not replace a saved unavailable publication with the one remaining accessible target', async () => {
  localStorage.setItem(
    `cat-cafe:message-publication:operator:${JSON.stringify(source)}`,
    JSON.stringify({ contentRef: `prepared-media:${'f'.repeat(64)}`, ownerRevision: 1 }),
  );
  mocks.apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'resolved', ownerUserId: 'operator', asset })),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('上次选择的作品当前不可用');
  expect(onResolved).not.toHaveBeenCalled();
});

it('closing the resolving shell fences late responses instead of opening into another host', async () => {
  let finish!: (response: Response) => void;
  mocks.apiFetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  await act(async () => root.render(null));
  await act(async () => finish(new Response(JSON.stringify({ status: 'resolved', ownerUserId: 'operator', asset }))));
  expect(onResolved).not.toHaveBeenCalled();
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
});

it('partial visibility stays a visible choice even when the available object was selected before', async () => {
  localStorage.setItem(
    `cat-cafe:message-publication:operator:${JSON.stringify(source)}`,
    JSON.stringify({ contentRef: asset.contentRef, ownerRevision: 1 }),
  );
  mocks.apiFetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        status: 'choice-required',
        ownerUserId: 'operator',
        choices: [choice],
        unavailableContexts: true,
      }),
    ),
  );
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onResolved={onResolved}
        onBack={() => {}}
      />,
    ),
  );
  expect(element.textContent).toContain('历史作品当前无法访问');
  expect(onResolved).not.toHaveBeenCalled();
  expect(mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/content-publications/resolve')).toHaveLength(1);
});

it('explicitly choosing another original work ignores the remembered publication until the user selects', async () => {
  localStorage.setItem(
    `cat-cafe:message-publication:operator:${JSON.stringify(source)}`,
    JSON.stringify({ contentRef: asset.contentRef, ownerRevision: 1 }),
  );
  const other = { ...asset, contentRef: `prepared-media:${'d'.repeat(64)}` };
  mocks.apiFetch.mockImplementation(async (url, init) => {
    if (url === '/api/content-reviews/resolve')
      return new Response(JSON.stringify({ ownerUserId: 'operator', contexts: [] }));
    const selection = JSON.parse(init.body).selection;
    return new Response(
      JSON.stringify(
        selection
          ? {
              status: 'resolved',
              ownerUserId: 'operator',
              asset: selection.contentRef === other.contentRef ? other : asset,
            }
          : {
              status: 'choice-required',
              ownerUserId: 'operator',
              choices: [choice, { ...choice, asset: other, taskTitle: '另一份独立委托' }],
            },
      ),
    );
  });
  const onResolved = vi.fn();
  await act(async () =>
    root.render(
      <MessagePublicationLandingResolver
        source={source}
        surface={createMessagePublicationSurface(source, '封面')}
        onBack={() => {}}
        onResolved={onResolved}
        forceChoice
      />,
    ),
  );
  expect(onResolved).not.toHaveBeenCalled();
  expect(mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/content-publications/resolve')).toHaveLength(1);
  await act(async () =>
    [...element.querySelectorAll('button')].find((button) => button.textContent?.includes('另一份独立委托'))!.click(),
  );
  expect(onResolved).toHaveBeenCalledTimes(1);
  expect(onResolved.mock.calls[0]?.[0].messagePublicationSource).toEqual(source);
  expect(localStorage.getItem(`cat-cafe:message-publication:operator:${JSON.stringify(source)}`)).toBe(
    JSON.stringify({ contentRef: other.contentRef, ownerRevision: 1 }),
  );
});
