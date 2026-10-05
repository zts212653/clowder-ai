import type { ContentModificationRequest } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationPanel } from '../ContentModificationPanel';
import { modificationSourceVersion, modificationStorageKey } from '../modification-draft';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
const oldSource: ContentModificationRequest['source'] = {
  kind: 'workspace',
  reviewId: 'file-review',
  locator: { worktreeId: 'work', path: 'guide.md' },
  expectedReviewRevision: 1,
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
};
const source = { ...oldSource, expectedReviewRevision: 2, expectedSourceRevision: `sha256:${'b'.repeat(64)}` };
const selection = (baseRevision: string, quote: string) => ({
  kind: 'text_quote' as const,
  baseRevision,
  start: 0,
  end: quote.length,
  quote,
  quoteDigest: `sha256:${'c'.repeat(64)}`,
  contextDigest: `sha256:${'d'.repeat(64)}`,
});
const oldIntent = { selection: selection(oldSource.expectedSourceRevision, 'old paragraph') };
const currentIntent = { selection: selection(source.expectedSourceRevision, 'new paragraph') };
const key = modificationStorageKey('operator', source);
const json = (value: unknown) => new Response(JSON.stringify(value));
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mock.fetch.mockReset();
  localStorage.setItem(
    key,
    JSON.stringify({
      v: 1,
      sourceVersion: modificationSourceVersion(oldSource),
      body: '保留语气，修改说明',
      targetCatId: 'opus5',
      threadId: 'execution',
      intent: oldIntent,
      acceptOperations: {},
    }),
  );
  mock.fetch.mockImplementation(async (url) =>
    url.endsWith('/choices')
      ? json({
          cats: [{ catId: 'opus5', name: '宪宪', mcpSupport: true, restrictions: [] }],
          threads: [{ threadId: 'execution', title: '原执行对话' }],
        })
      : new Response('{}', { status: 404 }),
  );
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.restoreAllMocks();
});
const render = (version = modificationSourceVersion(source)) =>
  act(async () =>
    root.render(
      <ContentModificationPanel
        source={source}
        ownerUserId="operator"
        title="说明书"
        initialIntent={currentIntent}
        initialIntentSourceVersion={version}
        onClose={() => {}}
      />,
    ),
  );
const adopt = () =>
  element.querySelector<HTMLButtonElement>('[data-testid="content-modification-use-current-version"]');
it('explicitly uses the newly resolved selection while retaining the old scope and original instruction/destination', async () => {
  await render();
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
  expect(adopt(), 'a drifted draft needs a usable recovery action').not.toBeNull();
  expect(adopt()?.disabled).toBe(false);
  await act(async () => adopt()!.click());
  const draft = JSON.parse(localStorage.getItem(key)!);
  expect(draft).toMatchObject({
    sourceVersion: modificationSourceVersion(source),
    body: '保留语气，修改说明',
    targetCatId: 'opus5',
    threadId: 'execution',
    intent: currentIntent,
    previousScopes: [
      {
        sourceVersion: modificationSourceVersion(oldSource),
        intent: oldIntent,
        targetCatId: 'opus5',
        threadId: 'execution',
      },
    ],
  });
  expect(draft.operation).toBeUndefined();
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(false);
  expect(mock.fetch.mock.calls.every(([url]) => url.endsWith('/choices'))).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(element);
  await render();
  expect(element.querySelector('textarea')?.value).toBe('保留语气，修改说明');
  expect(element.textContent).toContain('旧版选区');
  await act(async () => element.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  const submitted = mock.fetch.mock.calls.find(([url]) => url === '/api/content-modifications');
  expect(JSON.parse(submitted?.[1]?.body)).toMatchObject({
    source,
    targetCatId: 'opus5',
    threadId: 'execution',
    intent: { body: '保留语气，修改说明', ...currentIntent },
  });
});
it('a selection captured against the old version cannot enable recovery', async () => {
  await render(modificationSourceVersion(oldSource));
  expect(adopt()?.disabled).toBe(true);
  expect(JSON.parse(localStorage.getItem(key)!).intent).toEqual(oldIntent);
});
it('quota failure preserves the exact old draft and shows an error instead of dropping its predecessor', async () => {
  await render();
  const before = localStorage.getItem(key);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError');
  });
  await act(async () => adopt()!.click());
  expect(localStorage.getItem(key)).toBe(before);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('无法保存');
  expect(element.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
});
it('an unknown frozen operation keeps its old source and identity even after a new version is visible', async () => {
  const draft = JSON.parse(localStorage.getItem(key)!);
  const operation = {
    operationId: crypto.randomUUID(),
    source: oldSource,
    targetCatId: 'opus5',
    threadId: 'execution',
    intent: { body: draft.body, ...oldIntent },
  };
  localStorage.setItem(key, JSON.stringify({ ...draft, operation }));
  await render();
  expect(adopt()).toBeNull();
  const retry = element.querySelector<HTMLButtonElement>('[type="submit"]');
  expect(retry?.textContent).toBe('重试原修改请求');
  await act(async () => retry!.click());
  const sent = mock.fetch.mock.calls.find(([url]) => url === '/api/content-modifications');
  expect(JSON.parse(sent?.[1]?.body)).toEqual(operation);
  expect(JSON.parse(localStorage.getItem(key)!).operation).toEqual(operation);
});
