// @vitest-environment jsdom
import type { PullRequestChangesTarget } from '@cat-cafe/shared';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChangesDiff } from '../useChangesDiff';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
const first: PullRequestChangesTarget = {
  kind: 'github-pr',
  v: 1,
  repoFullName: 'owner/repo',
  prNumber: 7,
  worktreeId: 'root',
  threadId: 'host',
};
const second = { ...first, prNumber: 8 };
let host: HTMLDivElement;
let root: Root;
let view: ReturnType<typeof useChangesDiff>;
let committedErrors: (typeof view.error)[] = [];
function Probe({ target }: { target?: PullRequestChangesTarget }) {
  view = useChangesDiff('root', target);
  useLayoutEffect(() => {
    committedErrors.push(view.error);
  });
  return <span>{view.data?.diff ?? 'empty'}</span>;
}
const response = (target: PullRequestChangesTarget, diff: string) => ({
  ok: true,
  json: async () => ({
    target,
    diff,
    changedFiles: [{ path: 'main.ts', status: 'M', patchState: 'available' }],
    comparison: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) },
    completeness: 'complete',
    omissions: [],
    totalChangedFiles: 1,
  }),
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  committedErrors = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render(target?: PullRequestChangesTarget) {
  await act(async () => root.render(<Probe target={target} />));
}

it('reads the encoded precise PR target instead of requesting current local diff', async () => {
  fetchMock.mockResolvedValue(response(first, 'PR 7'));
  await render(first);
  expect(fetchMock.mock.calls[0]?.[0]).toMatch(/^\/api\/workspace\/pull-request-changes\?target=/);
  expect(view.data?.diff).toBe('PR 7');
});

it('clears old target data immediately and rejects a late A response after switching to B', async () => {
  let finishA: (value: unknown) => void = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  fetchMock.mockResolvedValueOnce(response(second, 'PR 8'));
  await render(first);
  await render(second);
  expect(view.data?.diff).toBe('PR 8');
  await act(async () => finishA(response(first, 'PR 7 late')));
  expect(view.data?.diff).toBe('PR 8');
});

it('rejects an identity-mismatched response and reports a classified failure without local fallback', async () => {
  fetchMock.mockResolvedValueOnce(response(second, 'wrong PR'));
  await render(first);
  expect(view.data).toBeNull();
  expect(view.error).toBe('unavailable');
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: 'rate_limited' } }) });
  await act(async () => view.refresh());
  expect(view.data).toBeNull();
  expect(view.error).toBe('rate_limited');
  expect(fetchMock.mock.calls).toHaveLength(2);
});

it('keeps the classic local Changes endpoint for a non-PR target', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ diff: 'local', changedFiles: [] }) });
  await render();
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspace/diff?worktreeId=root');
  expect(view.data?.diff).toBe('local');
});

it('never presents A failure with B identity even before the new target passive effect runs', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: 'rate_limited' } }) });
  await render(first);
  expect(view.error).toBe('rate_limited');
  committedErrors = [];
  fetchMock.mockImplementationOnce(() => new Promise(() => {}));
  await render(second);
  expect(committedErrors.length).toBeGreaterThan(0);
  expect(committedErrors).not.toContain('rate_limited');
  expect(view.data).toBeNull();
  expect(view.loading).toBe(true);
});

it.each([
  { comparison: { unrelatedA: 'a'.repeat(40), unrelatedB: 'b'.repeat(40), unrelatedC: 'c'.repeat(40) } },
  { comparison: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)] },
  { omissions: ['unexpected_reason'], completeness: 'partial' },
  { totalChangedFiles: -1 },
])('reports an invalid read envelope as unavailable before presenting its revision: %j', async (invalid) => {
  const good = await response(first, 'PR 7').json();
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ...good, ...invalid }) });
  await render(first);
  expect(view.data).toBeNull();
  expect(view.error).toBe('unavailable');
});
