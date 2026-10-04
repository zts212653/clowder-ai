import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceModificationEntry } from '../WorkspaceModificationEntry';
import { view } from './WorkspaceContentReviewSurface.fixture';

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mock.fetch(...args) }));
vi.mock('@/components/content-review/ContentModificationLanding', () => ({
  ContentModificationLanding: (props: {
    source: unknown;
    initialIntent: unknown;
    initialIntentSourceVersion: string;
  }) => <output data-testid="captured-scope">{JSON.stringify(props)}</output>,
}));
const original = view();
const updated = structuredClone(original);
updated.review.source.revision = `sha256:${'e'.repeat(64)}`;
updated.review.revision++;
const current = { ...updated, currentSource: updated.review.source };
const anchor = (revision: string) => ({
  kind: 'text_quote',
  baseRevision: revision,
  start: 0,
  end: 4,
  quote: 'word',
  quoteDigest: revision,
  contextDigest: revision,
});
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mock.fetch.mockReset();
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
const render = (source = original) =>
  act(async () =>
    root.render(
      <WorkspaceModificationEntry
        view={source}
        path="guide.md"
        target={{ kind: 'text_quote', quote: 'word' }}
        disabled={false}
      />,
    ),
  );
const open = () =>
  act(async () => element.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click());
it('a late selection reply cannot reopen a draft against a different source version', async () => {
  let finish!: (response: Response) => void;
  mock.fetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  await open();
  await render(current);
  await act(async () => finish(new Response(JSON.stringify({ selection: anchor(original.review.source.revision) }))));
  expect(element.querySelector('output')).toBeNull();
  mock.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ selection: anchor(current.review.source.revision) })),
  );
  await open();
  const captured = JSON.parse(element.querySelector('output')!.textContent!);
  expect(captured.initialIntentSourceVersion).toBe(`${current.review.reviewId}:${current.review.source.revision}`);
  expect(captured.initialIntent.selection.baseRevision).toBe(current.review.source.revision);
  expect(JSON.parse(mock.fetch.mock.calls.at(-1)?.[1].body).source.expectedSourceRevision).toBe(
    current.review.source.revision,
  );
});
it('a captured selection keeps its old version stamp until another explicit selection read', async () => {
  mock.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ selection: anchor(original.review.source.revision) })),
  );
  await render();
  await open();
  await render(current);
  const captured = JSON.parse(element.querySelector('output')!.textContent!);
  expect(captured.source.expectedSourceRevision).toBe(current.review.source.revision);
  expect(captured.initialIntentSourceVersion).toBe(`${original.review.reviewId}:${original.review.source.revision}`);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
});
